// SPDX-License-Identifier: GPL-3.0-or-later

// Factor lookup and calibration maths, shared by extension.js and prefs.js.
// No GNOME imports, so tests/factorResolver.test.js runs with plain gjs.
//
// Keys of the factor dictionaries are app IDs ("org.mozilla.firefox") or
// rules with wildcards ("brave-*"): * matches any run of characters and ?
// one character, against the whole ID, ignoring case.

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const literalLength = pattern => pattern.replace(/[*?]/g, '').length;
const starCount = pattern => pattern.split('*').length - 1;

export function normalizeAppId(appId) {
    return appId.endsWith('.desktop') ? appId.slice(0, -8) : appId;
}

export function isPattern(key) {
    return key.includes('*') || key.includes('?');
}

export function validatePattern(pattern) {
    if (!pattern?.trim())
        return 'Enter a rule, for example brave-*';
    if (/\s/.test(pattern))
        return 'Rules cannot contain spaces';
    if (!isPattern(pattern))
        return 'Rules need a * or ? wildcard; set single apps in the list below';
    if (literalLength(pattern) === 0)
        return 'A rule needs at least one letter or digit besides wildcards';
    return null;
}

export function matchesPattern(pattern, appId) {
    const body = normalizeAppId(pattern).split('')
        .map(c => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
        .join('');
    return new RegExp(`^${body}$`, 'i').test(normalizeAppId(appId));
}

// First match wins: exact ID, exact ID ignoring case, most specific rule
// (most literal characters, then fewest *), then the legacy partial match
// (a stored ID inside the app ID, longest first, or the other way round,
// shortest first), then the global factor. Ties are broken alphabetically
// so the result never depends on dictionary order.
export function resolveFactor(factors, appId, globalFactor) {
    const id = normalizeAppId(appId);
    const result = (key, source) => ({factor: factors[key], source, key});

    for (const key of [id, `${id}.desktop`]) {
        if (Object.hasOwn(factors, key))
            return result(key, 'exact');
    }

    const keys = Object.keys(factors);
    const ids = keys.filter(key => !isPattern(key));
    const patterns = keys.filter(isPattern);

    const [sameIgnoringCase] = ids.filter(key => normalizeAppId(key).toLowerCase() === id.toLowerCase()).sort();
    if (sameIgnoringCase)
        return result(sameIgnoringCase, 'exact');

    const [rule] = patterns.filter(key => matchesPattern(key, id)).sort((a, b) =>
        literalLength(b) - literalLength(a) || starCount(a) - starCount(b) || b.length - a.length || compare(a, b));
    if (rule)
        return result(rule, 'pattern');

    const length = key => normalizeAppId(key).length;
    const [contained] = ids.filter(key => id.includes(normalizeAppId(key)))
        .sort((a, b) => length(b) - length(a) || compare(a, b));
    const [containing] = ids.filter(key => normalizeAppId(key).includes(id))
        .sort((a, b) => length(a) - length(b) || compare(a, b));
    if (contained ?? containing)
        return result(contained ?? containing, 'partial');

    return {factor: globalFactor, source: 'global', key: null};
}

// A gain is the logical pixels an app scrolls per unit of touchpad scroll.
// Two apps feel the same when gain × factor is equal, so this is the factor
// that matches the reference, rounded and clamped to WSF's range.
export function factorForGain(appGain, referenceGain, referenceFactor) {
    const factor = referenceGain * referenceFactor / appGain;
    return Math.min(5.0, Math.max(0.05, Math.round(factor * 100) / 100));
}

// Returns a copy of `factors` with every matched app following the reference,
// or null if nothing changes
export function applyMatchedFactors(factors, globalFactor, gains, matched, reference) {
    if (!gains[reference])
        return null;
    const referenceFactor = resolveFactor(factors, reference, globalFactor).factor;
    const updated = {...factors};
    let changed = false;
    for (const appId of matched) {
        if (appId === reference || !gains[appId])
            continue;
        const factor = factorForGain(gains[appId], gains[reference], referenceFactor);
        if (updated[normalizeAppId(appId)] !== factor) {
            updated[normalizeAppId(appId)] = factor;
            changed = true;
        }
    }
    return changed ? updated : null;
}

// Gains for matching the horizontal axis. Apps measured sideways use their
// sideways ratio to the reference, expressed on the reference's vertical
// gain. A reference not measured sideways is taken to scroll as far sideways
// as vertically; other apps keep their vertical gain.
export function horizontalMatchingGains(gains, horizontalGains, reference) {
    const result = {...gains};
    if (!gains[reference])
        return result;
    const referenceHorizontal = horizontalGains[reference] ?? gains[reference];
    for (const [appId, gain] of Object.entries(horizontalGains)) {
        if (appId !== reference && gain > 0)
            result[appId] = gain * gains[reference] / referenceHorizontal;
    }
    return result;
}

// Reads the calibration section of an exported settings file, keeping only
// well-formed entries; null if there is none
export function calibrationFromJson(section) {
    if (!section || typeof section !== 'object' || Array.isArray(section))
        return null;
    const gainsFrom = value => Object.fromEntries(Object.entries(
        value && typeof value === 'object' && !Array.isArray(value) ? value : {})
        .filter(([, gain]) => typeof gain === 'number' && Number.isFinite(gain) && gain > 0));

    const gains = gainsFrom(section.gains);
    const reference = typeof section.reference === 'string' && gains[section.reference] ? section.reference : '';
    const matched = Array.isArray(section.matched)
        ? [...new Set(section.matched.filter(id => typeof id === 'string' && gains[id] && id !== reference))]
        : [];
    return {gains, horizontalGains: gainsFrom(section.horizontal_gains), reference, matched};
}
