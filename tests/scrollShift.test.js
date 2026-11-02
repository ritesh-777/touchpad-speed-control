// Unit tests for scrollShift.js. Run with: gjs -m tests/scrollShift.test.js

import {columnSignatures, downsampleRows, estimateShift, rowSignatures} from '../scrollShift.js';

let failures = 0;
let count = 0;

function check(name, actual, expected) {
    count++;
    const a = JSON.stringify(actual);
    const e = JSON.stringify(expected);
    if (a === e) return;
    failures++;
    print(`FAIL ${name}\n  expected ${e}\n  actual   ${a}`);
}

// A "document": text-like dark runs on white, deterministic per content line
function documentPixel(line, x) {
    const textLine = Math.floor(line / 18);
    const row = line % 18;
    if (row > 11) return 250;
    // Glyph shapes vary per word and per row within the text line
    const word = Math.floor(x / 9);
    const hash = Math.imul(textLine * 131 + word, 2654435761) ^ Math.imul(row + 1, 40503);
    return (hash >>> (x % 9 + 3)) & 1 ? 30 : 250;
}

// Captures a viewport of `height` rows starting at document line `offset`
function capture(offset, height, width = 120, channels = 4) {
    const rowstride = width * channels + 8;
    const pixels = new Uint8Array(rowstride * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const v = documentPixel(offset + y, x);
            const i = y * rowstride + x * channels;
            pixels[i] = pixels[i + 1] = pixels[i + 2] = v;
            if (channels === 4) pixels[i + 3] = 255;
        }
    }
    return rowSignatures(pixels, width, height, rowstride, channels);
}

// Like capture(), but rows [from, to) show changing content (an animation)
function captureWithAnimation(offset, height, from, to, seed) {
    const rows = capture(offset, height);
    for (let y = from; y < to; y++) {
        for (let s = 0; s < rows[y].length; s++) rows[y][s] = ((Math.imul(y * 31 + s, seed) >>> 0) % 220) + 20;
    }
    return rows;
}

// Like capture(), but every pixel is off by a little, as with text re-rendered
// at a different subpixel position
function captureWithJitter(offset, height, amount) {
    return capture(offset, height).map((row, y) =>
        row.map((v, s) => v + (((Math.imul(y + 7, s + 3) >>> 0) % (2 * amount + 1)) - amount)));
}

function shift(from, to, height = 300, channels = 4) {
    const r = estimateShift(capture(from, height, 120, channels), capture(to, height, 120, channels));
    return r ? r.shift : null;
}

check('no movement', shift(100, 100), 0);
check('scrolled down 37', shift(100, 137), 37);
check('scrolled up 52', shift(400, 348), -52);
check('large shift (60% of height)', shift(0, 180), 180);
check('one-row shift', shift(10, 11), 1);
check('RGB without alpha', shift(50, 90, 300, 3), 40);
check('beyond the overlap limit is rejected', shift(0, 250), null);

const animated = estimateShift(captureWithAnimation(100, 300, 120, 170, 2654435761), captureWithAnimation(130, 300, 120, 170, 40503));
check('a changing region (17% of rows) does not block the match', animated ? animated.shift : null, 30);
const jittered = estimateShift(captureWithJitter(100, 300, 6), captureWithJitter(126, 300, 6));
check('small per-pixel rendering differences still match', jittered ? jittered.shift : null, 26);

const doubled = capture(100, 300).flatMap(row => [row, row]);
const doubledAfter = capture(122, 300).flatMap(row => [row, row]);
check('downsampling a 2x capture keeps the logical shift', estimateShift(downsampleRows(doubled, 2), downsampleRows(doubledAfter, 2)).shift, 22);
check('downsample factor 1 is a no-op', downsampleRows(doubled, 1) === doubled, true);

// Horizontal: the same document turned sideways (columns become lines)
function captureSideways(offset, width, height = 120, channels = 4) {
    const rowstride = width * channels;
    const pixels = new Uint8Array(rowstride * height);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const v = documentPixel(offset + x, y);
            const i = y * rowstride + x * channels;
            pixels[i] = pixels[i + 1] = pixels[i + 2] = v;
        }
    }
    return columnSignatures(pixels, width, height, rowstride, channels);
}
const sideways = estimateShift(captureSideways(100, 300), captureSideways(143, 300));
check('scrolled right 43 (column signatures)', sideways ? sideways.shift : null, 43);
const sidewaysBack = estimateShift(captureSideways(200, 300), captureSideways(170, 300));
check('scrolled left 30 (column signatures)', sidewaysBack ? sidewaysBack.shift : null, -30);

const blank = rowSignatures(new Uint8Array(4 * 50 * 100).fill(255), 50, 100, 200, 4);
check('blank content gives no result', estimateShift(blank, blank), null);
check('mismatched heights give no result', estimateShift(capture(0, 100), capture(0, 90)), null);

print(`${count - failures}/${count} passed`);
if (failures) imports.system.exit(1);
