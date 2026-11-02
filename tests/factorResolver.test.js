// Unit tests for factorResolver.js. Run with: gjs -m tests/factorResolver.test.js

import {applyMatchedFactors, factorForGain, horizontalMatchingGains, isPattern, matchesPattern, normalizeAppId, resolveFactor, validatePattern} from '../factorResolver.js';

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

function resolve(factors, appId, global = 1.0) {
    const r = resolveFactor(factors, appId, global);
    return [r.factor, r.source, r.key];
}

// normalizeAppId / isPattern
check('strips .desktop', normalizeAppId('org.gnome.Nautilus.desktop'), 'org.gnome.Nautilus');
check('keeps plain id', normalizeAppId('firefox'), 'firefox');
check('star is pattern', isPattern('brave-*'), true);
check('question mark is pattern', isPattern('app?'), true);
check('plain id is not pattern', isPattern('brave-browser'), false);

// matchesPattern
check('star matches PWA', matchesPattern('brave-*', 'brave-abcdef123-Default.desktop'), true);
check('star matches empty', matchesPattern('brave-*', 'brave-'), true);
check('whole id only', matchesPattern('brave-*', 'com.brave-x'), false);
check('ignores case', matchesPattern('BRAVE-*', 'brave-abc-Default'), true);
check('question mark is one char', matchesPattern('app?', 'app1'), true);
check('question mark is not zero chars', matchesPattern('app?', 'app'), false);
check('dot is literal', matchesPattern('org.gnome.*', 'orgXgnome.Files'), false);
check('regex characters are literal', matchesPattern('a+b*', 'a+bc'), true);
check('middle star', matchesPattern('chrome-*-Default', 'chrome-xyz-Default.desktop'), true);

// validatePattern
check('valid rule', validatePattern('brave-*'), null);
check('empty rule', typeof validatePattern(''), 'string');
check('rule without wildcard', typeof validatePattern('brave'), 'string');
check('wildcards only', typeof validatePattern('**'), 'string');
check('rule with space', typeof validatePattern('brave *'), 'string');

// resolveFactor: tiers
const f = {
    'org.mozilla.firefox': 0.4,
    'brave-*': 0.2,
    'brave-abc-Default': 0.9,
    'chrome': 0.6,
    'google-chrome-stable': 0.3,
};
check('exact', resolve(f, 'org.mozilla.firefox.desktop'), [0.4, 'exact', 'org.mozilla.firefox']);
check('exact .desktop key', resolve({'zotero.desktop': 0.25}, 'zotero'), [0.25, 'exact', 'zotero.desktop']);
check('exact ignoring case', resolve(f, 'Org.Mozilla.Firefox'), [0.4, 'exact', 'org.mozilla.firefox']);
check('exact beats rule', resolve(f, 'brave-abc-Default'), [0.9, 'exact', 'brave-abc-Default']);
check('rule for new PWA', resolve(f, 'brave-newpwa-Default.desktop'), [0.2, 'pattern', 'brave-*']);
check('rule beats partial', resolve({'brave': 0.7, 'brave-*': 0.2}, 'brave-x-Default'), [0.2, 'pattern', 'brave-*']);
check('most specific rule wins',
    resolve({'brave-*': 0.2, 'brave-*-Default': 0.5, '*': 0.9}, 'brave-x-Default'), [0.5, 'pattern', 'brave-*-Default']);
check('catch-all rule', resolve({'*': 0.9}, 'anything'), [0.9, 'pattern', '*']);
check('partial: contained, longest first',
    resolve({'chrome': 0.6, 'google-chrome': 0.3}, 'google-chrome-beta'), [0.3, 'partial', 'google-chrome']);
check('partial: containing, shortest first',
    resolve({'code-url-handler': 0.5, 'code-insiders-url-handler': 0.8}, 'code'), [0.5, 'partial', 'code-url-handler']);
check('partial is case-sensitive', resolve({'code': 0.5}, 'org.gnome.DeCODEr'), [1.0, 'global', null]);
check('global fallback', resolve(f, 'org.gnome.Calculator', 0.45), [0.45, 'global', null]);
check('rules never partial-match', resolve({'brave-*': 0.2}, 'brave'), [1.0, 'global', null]);

// resolveFactor: independent of dictionary order
const forward = {'a*': 0.1, 'ab*': 0.2, 'b': 0.3};
const backward = {'b': 0.3, 'ab*': 0.2, 'a*': 0.1};
check('order independent', resolve(forward, 'abc'), resolve(backward, 'abc'));
check('? is more specific than *', resolve({'x?z': 0.1, 'x*z': 0.2}, 'xyz'), [0.1, 'pattern', 'x?z']);
check('tie broken alphabetically', resolve({'b*': 0.1, 'a*': 0.2, '*c': 0.3}, 'abc'), [0.3, 'pattern', '*c']);

// factorForGain: gain × factor is kept equal to the reference's
check('Chrome matched to Text Editor at 0.45', factorForGain(13.17, 2.0, 0.45), 0.07);
check('same gain keeps the reference factor', factorForGain(2.0, 2.0, 0.45), 0.45);
check('clamped to the WSF minimum', factorForGain(500, 2.0, 0.1), 0.05);
check('clamped to the WSF maximum', factorForGain(0.1, 2.0, 1.0), 5.0);

// applyMatchedFactors
const gains = {'org.gnome.TextEditor.desktop': 2.0, 'google-chrome.desktop': 13.17, 'zotero.desktop': 4.0};
const ref = 'org.gnome.TextEditor.desktop';
check('matched apps follow the reference (stored without .desktop)',
    applyMatchedFactors({'google-chrome': 1.0}, 0.45, gains, ['google-chrome.desktop', 'zotero.desktop'], ref),
    {'google-chrome': 0.07, 'zotero': 0.23});
check('reference uses its own factor when it has one',
    applyMatchedFactors({'org.gnome.TextEditor': 0.9}, 0.45, gains, ['zotero.desktop'], ref),
    {'org.gnome.TextEditor': 0.9, 'zotero': 0.45});
check('nothing to change returns null',
    applyMatchedFactors({'zotero': 0.23}, 0.45, gains, ['zotero.desktop'], ref), null);
check('no measured reference returns null',
    applyMatchedFactors({}, 0.45, {'zotero.desktop': 4.0}, ['zotero.desktop'], ref), null);
check('the reference itself is never rewritten',
    applyMatchedFactors({}, 0.45, gains, [ref], ref), null);
check('unmeasured matched apps are skipped',
    applyMatchedFactors({}, 0.45, gains, ['missing.desktop', 'zotero.desktop'], ref), {'zotero': 0.23});
check('rules and other apps are left alone',
    applyMatchedFactors({'chrome-*-Default': 0.08, 'firefox': 0.3}, 0.45, gains, ['zotero.desktop'], ref),
    {'chrome-*-Default': 0.08, 'firefox': 0.3, 'zotero': 0.23});
const input = {'zotero': 1.0};
applyMatchedFactors(input, 0.45, gains, ['zotero.desktop'], ref);
check('input dictionary is not modified', input, {'zotero': 1.0});

// horizontalMatchingGains
const hRef = 'org.gnome.TextEditor.desktop';
const vGains = {[hRef]: 2.0, 'google-chrome.desktop': 13.0, 'zotero.desktop': 4.0};
check('reference not measured sideways: taken to scroll as far sideways as vertically',
    horizontalMatchingGains(vGains, {'google-chrome.desktop': 20.0}, hRef)['google-chrome.desktop'], 20.0);
check('a view far faster sideways (Files column view) gets a small horizontal factor, clamped by WSF',
    applyMatchedFactors({}, 0.45, horizontalMatchingGains({[hRef]: 2.0, 'files.desktop': 4.0}, {'files.desktop': 100.0}, hRef),
        ['files.desktop'], hRef), {'files': 0.05});
check('no reference: gains unchanged',
    horizontalMatchingGains(vGains, {'google-chrome.desktop': 20.0}, 'missing.desktop'), vGains);
const hGains = horizontalMatchingGains(vGains, {[hRef]: 4.0, 'google-chrome.desktop': 20.0}, hRef);
check('horizontal ratio is used when both are measured (5x reference -> 10 on its 2.0 scale)',
    hGains['google-chrome.desktop'], 10.0);
check('apps without a horizontal measurement keep the vertical gain', hGains['zotero.desktop'], 4.0);
check('reference keeps its vertical gain', hGains[hRef], 2.0);
check('horizontal ratio drives the horizontal factor',
    applyMatchedFactors({}, 0.5, hGains, ['google-chrome.desktop'], hRef), {'google-chrome': 0.1});

print(`${count - failures}/${count} passed`);
if (failures) imports.system.exit(1);
