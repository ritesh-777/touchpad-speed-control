// Touchpad Speed Control - Measures how far an app scrolls per unit of touchpad scroll
// Author: Ritesh Seth
// License: GPL v3
// GitHub: https://github.com/ritesh-777/touchpad-speed-control
//
// Calibration sends a short, slow two-finger scroll to a window through a
// virtual pointer, captures a strip of the window before and after, and
// finds how many logical pixels the content moved. That gives the app's
// gain: logical pixels per Clutter scroll unit. Virtual scroll events are
// injected after libinput, so WSF does not scale them and the gain is the
// app's own, independent of the factor currently applied.
//
// Two apps feel the same when gain × factor is the same for both, so the
// factor that makes an app match a reference app is
//     factor = referenceGain × referenceFactor / appGain
// (see factorForGain in factorResolver.js). Measuring in logical pixels
// keeps display scaling out of the result. The shift search itself is pure logic in
// scrollShift.js, unit tested with plain gjs.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';
import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';

import { columnSignatures, downsampleRows, estimateShift, isUnchanged, rowSignatures } from './scrollShift.js';

// Scroll sent per event and the pause between events. Slow enough that
// apps add little or no kinetic scrolling after the finish event.
const STEP_UNITS = 0.5;
const STEP_INTERVAL_MS = 16;
// Wait for smooth-scroll animations (browsers) to settle before capturing
const SETTLE_MS = 700;
// Accept a measurement once the content moved this far (logical px)
const MIN_SHIFT_PX = 24;
const STRIP_WIDTH_PX = 240;
// Largest disagreement accepted between the two measurements
const MAX_MISMATCH = 0.2;

// Pending waits, so cancelCalibration() can remove their main loop sources
// when the extension is disabled (for example when the screen locks)
const _pendingWaits = new Map();
let _cancelled = false;

/**
 * Waits `ms` milliseconds. Rejects if cancelCalibration() is called first.
 *
 * @param {number} ms - Milliseconds to wait.
 * @returns {Promise<void>}
 */
export function wait(ms) {
    if (_cancelled) return Promise.reject(new Error('calibration was cancelled'));
    return new Promise((resolve, reject) => {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            _pendingWaits.delete(id);
            resolve();
            return GLib.SOURCE_REMOVE;
        });
        _pendingWaits.set(id, reject);
    });
}

/**
 * Stops any measurement in progress: removes its pending timeouts and makes
 * further waits fail, so nothing keeps running after the extension is
 * disabled. A measurement interrupted this way may leave the page scrolled.
 */
export function cancelCalibration() {
    _cancelled = true;
    for (const [id, reject] of _pendingWaits) {
        GLib.source_remove(id);
        reject(new Error('calibration was cancelled'));
    }
    _pendingWaits.clear();
}

/**
 * Allows measurements again after cancelCalibration() (on enable).
 */
export function resetCalibration() {
    _cancelled = false;
}

const _sleep = wait;

function _nowUs() {
    return GLib.get_monotonic_time();
}

/**
 * Captures a screen area and returns its row signatures (or column
 * signatures, for horizontal scrolling), averaged down to roughly logical
 * resolution on scaled displays.
 *
 * The capture stays in memory and is dropped once its signatures are made.
 *
 * @returns {Promise<{rows: Float32Array[], scale: number}>} Signatures per
 *   row (or column), and captured pixels per logical pixel after averaging.
 */
async function _captureRows(x, y, width, height, vertical) {
    const shooter = new Shell.Screenshot();
    const stream = Gio.MemoryOutputStream.new_resizable();
    await shooter.screenshot_area(x, y, width, height, stream);
    stream.close(null);

    const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(
        Gio.MemoryInputStream.new_from_bytes(stream.steal_as_bytes()), null);
    const rows = (vertical ? rowSignatures : columnSignatures)(
        pixbuf.read_pixel_bytes().toArray(),
        pixbuf.get_width(),
        pixbuf.get_height(),
        pixbuf.get_rowstride(),
        pixbuf.get_n_channels());
    // Text re-rendered at a fractional scroll offset differs less once
    // averaged back to logical pixels, and the search runs scale² faster
    const scale = pixbuf.get_height() / height;
    const factor = Math.max(1, Math.round(scale));
    return {rows: downsampleRows(rows, factor), scale: scale / factor};
}

async function _scroll(device, units, vertical) {
    const steps = Math.max(1, Math.round(Math.abs(units) / STEP_UNITS));
    const step = units / steps;
    for (let i = 0; i < steps; i++) {
        device.notify_scroll_continuous(_nowUs(),
            vertical ? 0 : step, vertical ? step : 0,
            Clutter.ScrollSource.FINGER, Clutter.ScrollFinishFlags.NONE);
        await _sleep(STEP_INTERVAL_MS);
    }
    // Hold still before lifting the fingers so kinetic scrolling sees no velocity
    await _sleep(200);
    device.notify_scroll_continuous(_nowUs(), 0, 0,
        Clutter.ScrollSource.FINGER,
        vertical ? Clutter.ScrollFinishFlags.VERTICAL : Clutter.ScrollFinishFlags.HORIZONTAL);
}

// Scrolls `units` and returns how far the content in the area moved, in
// logical px (positive = moved up, or left), or null if no shift matched
// clearly, plus whether anything moved at all (so the step needs undoing).
async function _measureShift(device, area, units, vertical) {
    const before = await _captureRows(area.x, area.y, area.width, area.height, vertical);
    await _scroll(device, units, vertical);
    await _sleep(SETTLE_MS);
    const after = await _captureRows(area.x, area.y, area.width, area.height, vertical);
    const result = estimateShift(before.rows, after.rows);
    const shift = result ? result.shift / before.scale : null;
    const moved = shift !== null ? Math.abs(shift) >= 0.5 : !isUnchanged(before.rows, after.rows);
    return {shift, moved};
}

// One measurement in one direction (1 = down or right, -1 = up or left): finds a scroll
// amount that moves the content measurably, then confirms with twice that.
// Returns the gain, or throws with the reason it could not measure.
async function _measureDirection(measure, direction) {
    let units = 2;
    let shift = null;
    for (let attempt = 0; attempt < 4; attempt++) {
        shift = await measure(direction * units);
        if (shift !== null && Math.abs(shift) >= MIN_SHIFT_PX) break;
        // Matched without moving: the content is at its end in this direction
        if (shift !== null && Math.abs(shift) < 0.5)
            throw new Error('the content is at its end');
        // Too small to trust: aim for twice the minimum next time, using
        // the small shift as a first estimate of the gain when there is one
        units *= shift !== null && Math.abs(shift) >= 1
            ? Math.min(9, Math.max(2, Math.ceil(2 * MIN_SHIFT_PX / Math.abs(shift))))
            : 3;
        shift = null;
    }
    if (shift === null)
        throw new Error('the content did not scroll measurably');

    const confirm = await measure(direction * 2 * units);
    if (confirm === null || Math.abs(confirm / (2 * shift) - 1) > MAX_MISMATCH)
        throw new Error('the measurements disagree');

    return {
        gain: (shift + confirm) / (direction * 3 * units),
        shifts: [shift, confirm],
        units: [direction * units, direction * 2 * units],
    };
}

/**
 * Measures a window's scroll gain on one axis.
 *
 * Finds a scroll amount that moves the content measurably, then repeats
 * with twice that amount: content that scrolls linearly moves twice as far,
 * so a mismatch means the measurement is unreliable (repetitive content,
 * an animation, a page that hit its end). Measures scrolling down (or right)
 * first and, if that fails (a chat sitting at its bottom, for example), up
 * (or left). The pointer is moved to the window for the measurement and put
 * back afterwards, and the content is scrolled back to where it was.
 *
 * @param {Meta.Window} window - The window to measure; it needs content
 *   under its centre that scrolls on that axis, at least a screen long (or
 *   wide).
 * @param {function(string)} [log] - Receives a line per measurement step.
 * @param {boolean} [vertical] - Measure vertical (default) or horizontal scrolling.
 * @returns {Promise<{gain: number, shifts: number[], units: number[]}>}
 * @throws {Error} If no reliable gain could be measured in either direction.
 */
export async function measureWindowGain(window, log = () => {}, vertical = true) {
    const rect = window.get_frame_rect();
    // A central strip: across the window for vertical scrolling (skipping
    // the header bar / toolbars at the top), along it for horizontal
    const area = vertical
        ? {
            x: rect.x + Math.round((rect.width - Math.min(STRIP_WIDTH_PX, rect.width)) / 2),
            y: rect.y + Math.round(rect.height * 0.2),
            width: Math.min(STRIP_WIDTH_PX, rect.width),
            height: Math.round(rect.height * 0.7),
        }
        : {
            x: rect.x + Math.round(rect.width * 0.15),
            y: rect.y + Math.round(rect.height * 0.55 - Math.min(STRIP_WIDTH_PX, rect.height) / 2),
            width: Math.round(rect.width * 0.7),
            height: Math.min(STRIP_WIDTH_PX, rect.height),
        };
    const [forward, backward] = vertical ? ['down', 'up'] : ['right', 'left'];

    // GNOME 46+ reach the backend through the stage context
    const backend = global.stage.context?.get_backend() ?? Clutter.get_default_backend();
    const seat = backend.get_default_seat();
    const device = seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const [pointerX, pointerY] = global.get_pointer();

    let scrolled = 0;
    const measure = async units => {
        const {shift, moved} = await _measureShift(device, area, units, vertical);
        // Only steps that moved the content are undone: one at the content's
        // end did nothing, and undoing it would overshoot
        if (moved) scrolled += units;
        log(`scrolled ${units} units ${vertical ? 'vertically' : 'horizontally'}: ` +
            `content moved ${shift === null ? 'no clear match' : shift.toFixed(1) + ' px'}`);
        return shift;
    };

    try {
        device.notify_absolute_motion(_nowUs(), area.x + area.width / 2, area.y + area.height / 2);
        await _sleep(100);

        try {
            return await _measureDirection(measure, 1);
        } catch (e) {
            log(`scrolling ${forward} failed (${e.message}); trying ${backward}`);
            try {
                return await _measureDirection(measure, -1);
            } catch (e2) {
                throw new Error(vertical
                    ? `${e2.message}; open a long page or document, scroll to its middle and try again`
                    : `${e2.message}; open something that scrolls sideways (a wide table, long lines, a zoomed image) and try again`);
            }
        }
    } finally {
        // Undoing the scroll waits between steps, so it is skipped (or stops)
        // when the measurement was cancelled; the pointer goes back either way
        try {
            if (scrolled && !_cancelled)
                await _scroll(device, -scrolled, vertical);
        } finally {
            device.notify_absolute_motion(_nowUs(), pointerX, pointerY);
        }
    }
}
