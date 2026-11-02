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

import { columnSignatures, downsampleRows, estimateShift, rowSignatures } from './scrollShift.js';

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

function _sleep(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

function _nowUs() {
    return GLib.get_monotonic_time();
}

/**
 * Captures a screen area and returns its row signatures (or column
 * signatures, for horizontal scrolling), averaged down to roughly logical
 * resolution on scaled displays.
 *
 * @returns {Promise<{rows: Float32Array[], scale: number, png: GLib.Bytes}>}
 *   Signatures per row (or column), captured pixels per logical pixel after
 *   averaging, and the captured PNG.
 */
async function _captureRows(x, y, width, height, vertical) {
    const shooter = new Shell.Screenshot();
    const stream = Gio.MemoryOutputStream.new_resizable();
    await shooter.screenshot_area(x, y, width, height, stream);
    stream.close(null);

    const png = stream.steal_as_bytes();
    const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(
        Gio.MemoryInputStream.new_from_bytes(png), null);
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
    return {rows: downsampleRows(rows, factor), scale: scale / factor, png};
}

// Saves a failed step's captures for diagnosis (debug logging only)
function _saveCaptures(dir, label, before, after) {
    try {
        GLib.mkdir_with_parents(dir, 0o700);
        for (const [name, capture] of [['before', before], ['after', after]]) {
            Gio.File.new_for_path(GLib.build_filenamev([dir, `${label}-${name}.png`]))
                .replace_contents_bytes_async(capture.png, null, false,
                    Gio.FileCreateFlags.PRIVATE | Gio.FileCreateFlags.REPLACE_DESTINATION, null, null);
        }
    } catch (e) {
        console.warn('[TouchpadSpeed] could not save calibration captures: ' + e.message);
    }
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
// clearly. With `saveDir`, the captures of a step without a clear match are
// saved there.
async function _measureShift(device, area, units, vertical, saveDir, label) {
    const before = await _captureRows(area.x, area.y, area.width, area.height, vertical);
    await _scroll(device, units, vertical);
    await _sleep(SETTLE_MS);
    const after = await _captureRows(area.x, area.y, area.width, area.height, vertical);
    const result = estimateShift(before.rows, after.rows);
    if (!result && saveDir) _saveCaptures(saveDir, label, before, after);
    return result ? result.shift / before.scale : null;
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
 * @param {string} [saveDir] - Where to save the captures of steps that found
 *   no clear match, for diagnosis. Nothing is saved without it.
 * @param {boolean} [vertical] - Measure vertical (default) or horizontal scrolling.
 * @returns {Promise<{gain: number, shifts: number[], units: number[]}>}
 * @throws {Error} If no reliable gain could be measured in either direction.
 */
export async function measureWindowGain(window, log = () => {}, saveDir = null, vertical = true) {
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
    let step = 0;
    const measure = async units => {
        step++;
        const label = `${vertical ? 'v' : 'h'}-step${step}-${units}units`;
        const shift = await _measureShift(device, area, units, vertical, saveDir, label);
        // A step that clearly did not move (content at its end) needs no undo
        if (shift === null || Math.abs(shift) >= 0.5) scrolled += units;
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
        if (scrolled)
            await _scroll(device, -scrolled, vertical);
        device.notify_absolute_motion(_nowUs(), pointerX, pointerY);
    }
}
