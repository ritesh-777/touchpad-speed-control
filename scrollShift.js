// Touchpad Speed Control - Finds how far content moved between two captures
// Author: Ritesh Seth
// License: GPL v3
// GitHub: https://github.com/ritesh-777/touchpad-speed-control
//
// Pure logic with no GNOME imports, so it can be unit tested with plain gjs
// (see tests/scrollShift.test.js).

// Luminance samples per row. Each sample averages a band of columns, which
// keeps anti-aliased text from making neighbouring rows look different.
const SAMPLES = 32;
// Only shifts that leave at least this share of the rows overlapping count
const MIN_OVERLAP = 0.35;
// Share of overlapping rows that must match; the rest may change on their
// own (ads, animations, lazily loaded images, re-rendered text)
const MATCHING_ROWS = 0.75;
// The best shift's error must be at most this share of any other offset's
const DISTINCT = 0.5;

/**
 * Reduces an RGB(A) image to one luminance signature per row.
 *
 * @param {Uint8Array} pixels - Image bytes.
 * @param {number} width - Width in pixels.
 * @param {number} height - Height in pixels.
 * @param {number} rowstride - Bytes per row.
 * @param {number} channels - Bytes per pixel (3 or 4).
 * @returns {Float32Array[]} One signature of SAMPLES values per row.
 */
export function rowSignatures(pixels, width, height, rowstride, channels) {
    const samples = Math.min(SAMPLES, width);
    const band = width / samples;
    const rows = [];
    for (let y = 0; y < height; y++) {
        const signature = new Float32Array(samples);
        const base = y * rowstride;
        for (let s = 0; s < samples; s++) {
            const from = Math.floor(s * band);
            const to = Math.max(from + 1, Math.floor((s + 1) * band));
            let sum = 0;
            for (let x = from; x < to; x++) {
                const i = base + x * channels;
                sum += 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
            }
            signature[s] = sum / (to - from);
        }
        rows.push(signature);
    }
    return rows;
}

/**
 * Averages groups of `factor` rows, e.g. to compare at logical resolution on
 * a scaled display. Re-rendered text then differs less between captures.
 *
 * @param {Float32Array[]} rows - Row signatures.
 * @param {number} factor - Rows per group (1 returns the rows unchanged).
 * @returns {Float32Array[]} The averaged signatures.
 */
export function downsampleRows(rows, factor) {
    if (factor <= 1) return rows;
    const out = [];
    for (let y = 0; y + factor <= rows.length; y += factor) {
        const row = new Float32Array(rows[y].length);
        for (let k = 0; k < factor; k++) {
            for (let s = 0; s < row.length; s++) row[s] += rows[y + k][s] / factor;
        }
        out.push(row);
    }
    return out;
}

function _rowDifference(a, b) {
    let sum = 0;
    for (let s = 0; s < a.length; s++) sum += Math.abs(a[s] - b[s]);
    return sum / a.length;
}

// Mean difference between before[y] and after[y - shift] over the overlap.
// Gives up early (returning Infinity) once it cannot beat `limit`.
function _error(before, after, shift, limit) {
    const from = Math.max(0, shift);
    const to = Math.min(before.length, before.length + shift);
    const count = to - from;
    if (count <= 0) return Infinity;
    const budget = limit * count;
    let sum = 0;
    for (let y = from; y < to; y++) {
        sum += _rowDifference(before[y], after[y - shift]);
        if (sum > budget) return Infinity;
    }
    return sum / count;
}

// Mean difference over the best-matching MATCHING_ROWS share of the overlap
function _matchingError(before, after, shift) {
    const differences = [];
    for (let y = Math.max(0, shift); y < Math.min(before.length, before.length + shift); y++) {
        differences.push(_rowDifference(before[y], after[y - shift]));
    }
    differences.sort((a, b) => a - b);
    const count = Math.max(1, Math.floor(differences.length * MATCHING_ROWS));
    let sum = 0;
    for (let i = 0; i < count; i++) sum += differences[i];
    return sum / count;
}

// How much the rows differ from each other; near zero for blank content
function _detail(rows) {
    let sum = 0;
    for (let y = 1; y < rows.length; y++) sum += _rowDifference(rows[y], rows[y - 1]);
    return rows.length > 1 ? sum / (rows.length - 1) : 0;
}

/**
 * Finds the vertical shift that best maps `before` onto `after`.
 *
 * A positive shift means the content moved up (scrolled down) by that many
 * rows: before[y] reappears at after[y - shift].
 *
 * @param {Float32Array[]} before - Row signatures before scrolling.
 * @param {Float32Array[]} after - Row signatures after scrolling.
 * @returns {{shift: number, error: number}|null} The shift in rows and its
 *   mean difference, or null if the content has too little detail or no
 *   shift matches clearly.
 */
export function estimateShift(before, after) {
    const height = before.length;
    if (height < 16 || after.length !== height) return null;

    const detail = _detail(before);
    if (detail < 0.5) return null;

    const maxShift = Math.floor(height * (1 - MIN_OVERLAP));

    // Fast pass over every shift by mean difference (with early exit); rows
    // that change on their own add about the same error to every shift, so
    // the best shift stays the best
    let best = 0;
    let bestError = Infinity;
    for (let shift = -maxShift; shift <= maxShift; shift++) {
        const error = _error(before, after, shift, bestError);
        if (error < bestError) {
            bestError = error;
            best = shift;
        }
    }

    // Judge the winner on the rows that match, so a changing ad or animation
    // does not reject a clean shift. It must also clearly beat every other
    // offset judged the same way: blank lines and repeated layout match
    // almost anywhere, so a low error alone does not make a shift real.
    const error = _matchingError(before, after, best);
    const step = Math.max(1, Math.floor(maxShift / 40));
    let background = Infinity;
    for (let shift = -maxShift; shift <= maxShift; shift += step) {
        if (Math.abs(shift - best) > 4) background = Math.min(background, _matchingError(before, after, shift));
    }
    if (error > background * DISTINCT) return null;
    return {shift: best, error};
}
