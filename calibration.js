// SPDX-License-Identifier: GPL-3.0-or-later

// Measures an app's scroll gain: logical pixels its content moves per unit of
// two-finger scroll. A slow scroll is sent through a virtual pointer and a
// strip of the window is captured (in memory) before and after. Virtual
// events bypass libinput, so WSF does not scale them and the gain does not
// depend on the factor currently applied.

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';

import {columnSignatures, downsampleRows, estimateShift, isUnchanged, rowSignatures} from './scrollShift.js';

// Slow enough that apps add little or no kinetic scrolling
const STEP_UNITS = 0.5;
const STEP_INTERVAL_MS = 16;
// Lets smooth-scroll animations (browsers) finish before capturing
const SETTLE_MS = 700;
const MIN_SHIFT_PX = 24;
const STRIP_SIZE_PX = 240;
const MAX_MISMATCH = 0.2;

const pendingWaits = new Map();
let cancelled = false;

export function wait(ms) {
    if (cancelled)
        return Promise.reject(new Error('calibration was cancelled'));
    return new Promise((resolve, reject) => {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            pendingWaits.delete(id);
            resolve();
            return GLib.SOURCE_REMOVE;
        });
        pendingWaits.set(id, reject);
    });
}

// Called from disable(): removes pending timeouts and stops the measurement
export function cancelCalibration() {
    cancelled = true;
    for (const [id, reject] of pendingWaits) {
        GLib.source_remove(id);
        reject(new Error('calibration was cancelled'));
    }
    pendingWaits.clear();
}

export function resetCalibration() {
    cancelled = false;
}

async function capture(area, vertical) {
    const stream = Gio.MemoryOutputStream.new_resizable();
    await new Shell.Screenshot().screenshot_area(area.x, area.y, area.width, area.height, stream);
    stream.close(null);
    const pixbuf = GdkPixbuf.Pixbuf.new_from_stream(Gio.MemoryInputStream.new_from_bytes(stream.steal_as_bytes()), null);
    const signatures = (vertical ? rowSignatures : columnSignatures)(pixbuf.read_pixel_bytes().toArray(),
        pixbuf.get_width(), pixbuf.get_height(), pixbuf.get_rowstride(), pixbuf.get_n_channels());

    // Compare at logical resolution: text redrawn at a fractional scroll
    // offset differs less, and the search is faster
    const scale = pixbuf.get_height() / area.height;
    const factor = Math.max(1, Math.round(scale));
    return {signatures: downsampleRows(signatures, factor), scale: scale / factor};
}

async function scroll(device, units, vertical) {
    const steps = Math.max(1, Math.round(Math.abs(units) / STEP_UNITS));
    for (let i = 0; i < steps; i++) {
        const delta = units / steps;
        device.notify_scroll_continuous(GLib.get_monotonic_time(), vertical ? 0 : delta, vertical ? delta : 0,
            Clutter.ScrollSource.FINGER, Clutter.ScrollFinishFlags.NONE);
        await wait(STEP_INTERVAL_MS);
    }
    // Pause before lifting the fingers so there is no kinetic scrolling
    await wait(200);
    device.notify_scroll_continuous(GLib.get_monotonic_time(), 0, 0, Clutter.ScrollSource.FINGER,
        vertical ? Clutter.ScrollFinishFlags.VERTICAL : Clutter.ScrollFinishFlags.HORIZONTAL);
}

// Finds a scroll amount that moves the content measurably, then confirms it:
// twice the scroll must move the content twice as far
async function measureDirection(measure, direction) {
    let units = 2;
    let shift = null;
    for (let attempt = 0; attempt < 4; attempt++) {
        shift = await measure(direction * units);
        if (shift !== null && Math.abs(shift) >= MIN_SHIFT_PX)
            break;
        if (shift !== null && Math.abs(shift) < 0.5)
            throw new Error('the content is at its end');
        // Aim for twice the minimum shift next time
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
    return (shift + confirm) / (direction * 3 * units);
}

// Measures the window's gain on one axis, trying down (or right) first and
// then up (or left), for content already at its end. Scrolls the content
// back and returns the pointer afterwards.
export async function measureWindowGain(window, log, vertical = true) {
    const rect = window.get_frame_rect();
    const area = vertical
        ? {
            x: rect.x + Math.round((rect.width - Math.min(STRIP_SIZE_PX, rect.width)) / 2),
            y: rect.y + Math.round(rect.height * 0.2), // below header bars
            width: Math.min(STRIP_SIZE_PX, rect.width),
            height: Math.round(rect.height * 0.7),
        }
        : {
            x: rect.x + Math.round(rect.width * 0.15),
            y: rect.y + Math.round(rect.height * 0.55 - Math.min(STRIP_SIZE_PX, rect.height) / 2),
            width: Math.round(rect.width * 0.7),
            height: Math.min(STRIP_SIZE_PX, rect.height),
        };

    const backend = global.stage.context?.get_backend() ?? Clutter.get_default_backend();
    const device = backend.get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
    const [pointerX, pointerY] = global.get_pointer();

    let scrolled = 0;
    const measure = async units => {
        const before = await capture(area, vertical);
        await scroll(device, units, vertical);
        await wait(SETTLE_MS);
        const after = await capture(area, vertical);
        const result = estimateShift(before.signatures, after.signatures);
        const shift = result ? result.shift / before.scale : null;
        // Only steps that moved the content need undoing
        if (shift !== null ? Math.abs(shift) >= 0.5 : !isUnchanged(before.signatures, after.signatures))
            scrolled += units;
        log(`scrolled ${units}: ${shift === null ? 'no clear match' : `${shift.toFixed(1)} px`}`);
        return shift;
    };

    try {
        device.notify_absolute_motion(GLib.get_monotonic_time(), area.x + area.width / 2, area.y + area.height / 2);
        await wait(100);
        try {
            return await measureDirection(measure, 1);
        } catch (e) {
            log(`${e.message}; trying the other direction`);
            try {
                return await measureDirection(measure, -1);
            } catch (e2) {
                throw new Error(vertical
                    ? `${e2.message}. Open a long page, scroll to its middle and try again.`
                    : `${e2.message}. Open something that scrolls sideways and try again.`);
            }
        }
    } finally {
        try {
            if (scrolled && !cancelled)
                await scroll(device, -scrolled, vertical);
        } finally {
            device.notify_absolute_motion(GLib.get_monotonic_time(), pointerX, pointerY);
        }
    }
}
