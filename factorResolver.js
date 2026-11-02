// Touchpad Speed Control - Scroll factor resolution shared by extension.js and prefs.js
// Author: Ritesh Seth
// License: GPL v3
// GitHub: https://github.com/ritesh-777/touchpad-speed-control
//
// Pure logic with no GNOME imports, so it can be unit tested with plain gjs
// (see tests/factorResolver.test.js).
//
// Keys in the app-factors dictionaries are either application IDs
// ("org.mozilla.firefox") or rules containing wildcards ("brave-*"):
//   *  matches any run of characters (including none)
//   ?  matches exactly one character
// Rules match the whole application ID, ignoring case.

/**
 * Strips a trailing ".desktop" from an application ID.
 *
 * @param {string} appId - Application or desktop-file ID.
 * @returns {string} The ID without the .desktop suffix.
 */
export function normalizeAppId(appId) {
    return appId.endsWith('.desktop') ? appId.slice(0, -8) : appId;
}

/**
 * Whether a factors-dictionary key is a wildcard rule rather than an app ID.
 *
 * @param {string} key - Dictionary key.
 * @returns {boolean} True if the key contains * or ?.
 */
export function isPattern(key) {
    return key.includes('*') || key.includes('?');
}

/**
 * Validates a wildcard rule entered by the user.
 *
 * @param {string} pattern - The rule text.
 * @returns {string|null} An error message, or null if the rule is usable.
 */
export function validatePattern(pattern) {
    if (!pattern || !pattern.trim()) return 'Enter a rule, for example brave-*';
    if (pattern !== pattern.trim() || /\s/.test(pattern)) return 'Rules cannot contain spaces';
    if (!isPattern(pattern)) return 'Rules need a * or ? wildcard; set single apps in the list below';
    if (_literalLength(pattern) === 0) return 'A rule needs at least one letter or digit besides wildcards';
    return null;
}

/**
 * Tests a wildcard rule against an application ID (whole ID, ignoring case).
 *
 * @param {string} pattern - Rule such as "brave-*".
 * @param {string} appId - Application ID, with or without .desktop.
 * @returns {boolean} True if the rule matches.
 */
export function matchesPattern(pattern, appId) {
    return _patternRegExp(normalizeAppId(pattern)).test(normalizeAppId(appId));
}

/**
 * Resolves the scroll factor for an application.
 *
 * Resolution order (first tier with a match wins):
 *   1. Exact ID (with or without .desktop)
 *   2. Exact ID ignoring case
 *   3. Wildcard rules — the most specific rule wins: most non-wildcard
 *      characters, then fewest *
 *   4. Partial match (legacy behavior, case-sensitive) — a stored ID contained
 *      in the app ID, longest first; then the app ID contained in a stored ID,
 *      shortest first
 *   5. The global factor
 * Ties are broken alphabetically, so the result never depends on dictionary order.
 *
 * @param {Object<string, number>} factors - The app-factors dictionary.
 * @param {string} appId - The application ID (e.g. 'org.mozilla.firefox.desktop').
 * @param {number} globalFactor - Fallback factor.
 * @returns {{factor: number, source: string, key: string|null}} The factor,
 *   how it was found ('exact', 'pattern', 'partial' or 'global') and the matching key.
 */
export function resolveFactor(factors, appId, globalFactor) {
    const id = normalizeAppId(appId);
    const idLower = id.toLowerCase();

    // Tier 1: exact
    for (const key of [id, id + '.desktop']) {
        if (Object.prototype.hasOwnProperty.call(factors, key)) {
            return {factor: factors[key], source: 'exact', key};
        }
    }

    const ids = [];
    const patterns = [];
    for (const key of Object.keys(factors)) {
        (isPattern(key) ? patterns : ids).push(key);
    }

    // Tier 2: exact ignoring case
    const caseMatches = ids.filter(key => normalizeAppId(key).toLowerCase() === idLower).sort();
    if (caseMatches.length) {
        return {factor: factors[caseMatches[0]], source: 'exact', key: caseMatches[0]};
    }

    // Tier 3: wildcard rules, most specific first
    const ruleMatches = patterns
        .filter(key => matchesPattern(key, id))
        .sort((a, b) =>
            _literalLength(b) - _literalLength(a) ||
            _starCount(a) - _starCount(b) ||
            b.length - a.length ||
            (a < b ? -1 : a > b ? 1 : 0));
    if (ruleMatches.length) {
        return {factor: factors[ruleMatches[0]], source: 'pattern', key: ruleMatches[0]};
    }

    // Tier 4: partial matches (case-sensitive, as before, to limit false positives)
    const contained = ids
        .filter(key => id.includes(normalizeAppId(key)))
        .sort((a, b) => normalizeAppId(b).length - normalizeAppId(a).length || (a < b ? -1 : a > b ? 1 : 0));
    if (contained.length) {
        return {factor: factors[contained[0]], source: 'partial', key: contained[0]};
    }
    const containing = ids
        .filter(key => normalizeAppId(key).includes(id))
        .sort((a, b) => normalizeAppId(a).length - normalizeAppId(b).length || (a < b ? -1 : a > b ? 1 : 0));
    if (containing.length) {
        return {factor: factors[containing[0]], source: 'partial', key: containing[0]};
    }

    // Tier 5: global
    return {factor: globalFactor, source: 'global', key: null};
}

/**
 * Factor that makes an app scroll as far per swipe as the reference app.
 *
 * Calibration measures each app's gain (logical pixels scrolled per unit of
 * touchpad scroll, before any factor). Two apps feel the same when
 * gain × factor is the same for both.
 *
 * @param {number} appGain - Measured gain of the app.
 * @param {number} referenceGain - Measured gain of the reference app.
 * @param {number} referenceFactor - Factor the reference app uses.
 * @returns {number} The matching factor, rounded to 0.01 and clamped to
 *   WSF's 0.05–5.0 range.
 */
export function factorForGain(appGain, referenceGain, referenceFactor) {
    const factor = (referenceGain * referenceFactor) / appGain;
    return Math.min(5.0, Math.max(0.05, Math.round(factor * 100) / 100));
}

/**
 * Sets the factor of every matched app so it scrolls like the reference app
 * at the reference's current factor (one axis).
 *
 * @param {Object<string, number>} factors - The app-factors dictionary.
 * @param {number} globalFactor - The global factor.
 * @param {Object<string, number>} gains - Measured gains by app ID.
 * @param {string[]} matched - App IDs that follow the reference.
 * @param {string} reference - The reference app ID.
 * @returns {Object<string, number>|null} An updated copy of `factors`, or null
 *   if nothing needs to change (or there is no measured reference).
 */
export function applyMatchedFactors(factors, globalFactor, gains, matched, reference) {
    const referenceGain = gains[reference];
    if (!reference || !referenceGain) return null;

    const referenceFactor = resolveFactor(factors, reference, globalFactor).factor;
    const updated = {...factors};
    let changed = false;
    for (const appId of matched) {
        if (appId === reference || !gains[appId]) continue;
        const key = normalizeAppId(appId);
        const factor = factorForGain(gains[appId], referenceGain, referenceFactor);
        if (updated[key] !== factor) {
            updated[key] = factor;
            changed = true;
        }
    }
    return changed ? updated : null;
}

/**
 * Gains to match the horizontal axis with. An app measured horizontally
 * uses its horizontal ratio to the reference, expressed on the reference's
 * vertical gain so it can be passed to applyMatchedFactors with the same
 * gains dictionary. A reference without a horizontal measurement is taken to
 * scroll as far sideways as vertically, which holds for ordinary apps (and
 * the reference is usually a plain text or file view). Every app without a
 * horizontal measurement keeps its vertical gain, so its horizontal factor
 * follows the vertical ratio.
 *
 * @param {Object<string, number>} gains - Vertical gains by app ID.
 * @param {Object<string, number>} horizontalGains - Horizontal gains by app ID.
 * @param {string} reference - The reference app ID.
 * @returns {Object<string, number>} Gains for the horizontal axis.
 */
export function horizontalMatchingGains(gains, horizontalGains, reference) {
    const result = {...gains};
    const referenceGain = gains[reference];
    const referenceHorizontal = horizontalGains[reference] ?? referenceGain;
    if (!referenceGain) return result;
    for (const [appId, gain] of Object.entries(horizontalGains)) {
        if (appId !== reference && gain > 0)
            result[appId] = gain * referenceGain / referenceHorizontal;
    }
    return result;
}

function _literalLength(pattern) {
    return pattern.replace(/[*?]/g, '').length;
}

function _starCount(pattern) {
    return pattern.split('*').length - 1;
}

function _patternRegExp(pattern) {
    const body = pattern
        .split('')
        .map(c => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
        .join('');
    return new RegExp('^' + body + '$', 'i');
}
