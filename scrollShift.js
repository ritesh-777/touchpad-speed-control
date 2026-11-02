// SPDX-License-Identifier: GPL-3.0-or-later

// Finds how far content moved between two captures. Each capture is reduced
// to one luminance signature per row (or column) and the shift that best
// maps one onto the other is searched. No GNOME imports, so
// tests/scrollShift.test.js runs with plain gjs.

// Samples per signature; each averages a band, so anti-aliased text does not
// make neighbouring rows look different
const SAMPLES = 32;
// Shifts must leave at least this share of the rows overlapping
const MIN_OVERLAP = 0.35;
// Share of rows that must match; the rest may change on their own (ads,
// animations, lazily loaded images)
const MATCHING_ROWS = 0.75;
// The best shift must have at most this share of any other shift's error
const DISTINCT = 0.5;

function signatures(pixels, width, height, rowstride, channels, byColumn) {
    const [lines, across] = byColumn ? [width, height] : [height, width];
    const samples = Math.min(SAMPLES, across);
    const band = across / samples;
    const result = [];
    for (let line = 0; line < lines; line++) {
        const signature = new Float32Array(samples);
        for (let s = 0; s < samples; s++) {
            const from = Math.floor(s * band);
            const to = Math.max(from + 1, Math.floor((s + 1) * band));
            let sum = 0;
            for (let k = from; k < to; k++) {
                const [x, y] = byColumn ? [line, k] : [k, line];
                const i = y * rowstride + x * channels;
                sum += 0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
            }
            signature[s] = sum / (to - from);
        }
        result.push(signature);
    }
    return result;
}

export function rowSignatures(pixels, width, height, rowstride, channels) {
    return signatures(pixels, width, height, rowstride, channels, false);
}

export function columnSignatures(pixels, width, height, rowstride, channels) {
    return signatures(pixels, width, height, rowstride, channels, true);
}

// Averages groups of `factor` signatures (to compare at logical resolution)
export function downsampleRows(rows, factor) {
    if (factor <= 1)
        return rows;
    const result = [];
    for (let y = 0; y + factor <= rows.length; y += factor) {
        const row = new Float32Array(rows[y].length);
        for (let k = 0; k < factor; k++) {
            for (let s = 0; s < row.length; s++)
                row[s] += rows[y + k][s] / factor;
        }
        result.push(row);
    }
    return result;
}

function difference(a, b) {
    let sum = 0;
    for (let s = 0; s < a.length; s++)
        sum += Math.abs(a[s] - b[s]);
    return sum / a.length;
}

// Mean difference between before[y] and after[y - shift]; gives up (Infinity)
// once it cannot beat `limit`
function meanError(before, after, shift, limit) {
    const from = Math.max(0, shift);
    const to = Math.min(before.length, before.length + shift);
    const budget = limit * (to - from);
    let sum = 0;
    for (let y = from; y < to; y++) {
        sum += difference(before[y], after[y - shift]);
        if (sum > budget)
            return Infinity;
    }
    return to > from ? sum / (to - from) : Infinity;
}

// Mean difference over the best-matching MATCHING_ROWS of the overlap
function matchingError(before, after, shift) {
    const differences = [];
    for (let y = Math.max(0, shift); y < Math.min(before.length, before.length + shift); y++)
        differences.push(difference(before[y], after[y - shift]));
    differences.sort((a, b) => a - b);
    const count = Math.max(1, Math.floor(differences.length * MATCHING_ROWS));
    return differences.slice(0, count).reduce((sum, d) => sum + d, 0) / count;
}

// How much neighbouring rows differ; near zero for blank content
function detail(rows) {
    let sum = 0;
    for (let y = 1; y < rows.length; y++)
        sum += difference(rows[y], rows[y - 1]);
    return rows.length > 1 ? sum / (rows.length - 1) : 0;
}

// Whether nothing moved, apart from small changes such as a blinking cursor
export function isUnchanged(before, after) {
    if (before.length !== after.length || before.length === 0)
        return false;
    return matchingError(before, after, 0) <= Math.max(0.5, detail(before) * 0.1);
}

// The shift (in rows) that best maps `before` onto `after`, positive when the
// content moved up: before[y] reappears at after[y - shift]. Null if the
// content has too little detail or no shift matches clearly.
export function estimateShift(before, after) {
    const height = before.length;
    if (height < 16 || after.length !== height || detail(before) < 0.5)
        return null;
    const maxShift = Math.floor(height * (1 - MIN_OVERLAP));

    // Rows that change on their own add about the same error to every
    // shift, so the plain mean still finds the best one
    let best = 0;
    let bestError = Infinity;
    for (let shift = -maxShift; shift <= maxShift; shift++) {
        const error = meanError(before, after, shift, bestError);
        if (error < bestError) {
            bestError = error;
            best = shift;
        }
    }

    // Judged on the rows that match, it must clearly beat every other shift:
    // blank lines and repeated layout match almost anywhere
    const error = matchingError(before, after, best);
    const step = Math.max(1, Math.floor(maxShift / 40));
    let background = Infinity;
    for (let shift = -maxShift; shift <= maxShift; shift += step) {
        if (Math.abs(shift - best) > 4)
            background = Math.min(background, matchingError(before, after, shift));
    }
    return error > background * DISTINCT ? null : {shift: best, error};
}
