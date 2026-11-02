// SPDX-License-Identifier: GPL-3.0-or-later

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {applyMatchedFactors, calibrationFromJson, horizontalMatchingGains, isPattern, normalizeAppId, resolveFactor, validatePattern} from './factorResolver.js';
import {findWSFPath, isWSFActive} from './wsf.js';

const FACTOR_MIN = 0.05;
const FACTOR_MAX = 2.0;
const FACTOR_STEP = 0.01;
const WSF_URL = 'https://github.com/daniel-g-carrasco/wayland-scroll-factor';

// Listed first in the app lists: apps whose scrolling usually needs tuning
const KNOWN_APPS = new Set([
    'chrome', 'google-chrome-stable', 'google-chrome-unstable', 'google-chrome-beta', 'google-chrome-dev',
    'com.google.Chrome', 'com.google.Chrome.unstable', 'firefox', 'firefox-developer', 'firefox-nightly',
    'code', 'code-url-handler', 'org.gnome.Terminal', 'telegram-desktop', 'discord', 'slack',
    'org.gnome.Nautilus', 'org.gnome.TextEditor', 'org.gnome.gedit', 'okular', 'org.gnome.Evince',
    'com.github.johnfactotum.Foliate',
]);

const AXES = {
    v: {name: 'Vertical', factors: 'app-factors', global: 'global-factor', other: 'h'},
    h: {name: 'Horizontal', factors: 'h-app-factors', global: 'h-global-factor', other: 'v'},
};

export default class TouchpadSpeedControlPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        window.set_default_size(850, 750);
        const wsfPath = findWSFPath();
        if (!wsfPath) {
            this._showStatus(window, _('WSF Not Installed'),
                _('Touchpad Speed Control requires Wayland Scroll Factor (WSF). Install it for your distribution, run "wsf enable", then log out and back in.'),
                _('Open WSF on GitHub'),
                () => new Gtk.UriLauncher({uri: WSF_URL}).launch(window, null, null));
        } else if (!this._wsfActive(wsfPath)) {
            const page = this._showStatus(window, _('WSF Preload Not Active'),
                _('Run "wsf enable" in a terminal, then log out and back in.'),
                _('Check Again'),
                () => {
                    if (this._wsfActive(wsfPath)) {
                        window.remove(page);
                        new SettingsUI(this, window);
                    }
                });
        } else {
            new SettingsUI(this, window);
        }
    }

    _wsfActive(wsfPath) {
        const proc = Gio.Subprocess.new([wsfPath, 'status'], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        const [, stdout] = proc.communicate_utf8(null, null);
        return isWSFActive(stdout);
    }

    _showStatus(window, title, description, buttonLabel, onClick) {
        const button = new Gtk.Button({label: buttonLabel, halign: Gtk.Align.CENTER, css_classes: ['pill', 'suggested-action']});
        button.connect('clicked', onClick);
        const status = new Adw.StatusPage({title, description, icon_name: 'dialog-warning-symbolic', child: button, vexpand: true});
        const group = new Adw.PreferencesGroup();
        group.add(status);
        const page = new Adw.PreferencesPage();
        page.add(group);
        window.add(page);
        return page;
    }
}

class SettingsUI {
    constructor(extension, window) {
        this._window = window;
        this._settings = extension.getSettings();
        this._apps = this._loadApps();
        this._lists = {};
        this._globalRows = {};
        this._ruleGroups = {};
        this._ruleRows = {v: [], h: []};

        window.add(this._buildGeneralPage());
        window.add(this._buildAxisPage('v'));
        window.add(this._buildAxisPage('h'));
        window.connect('close-request', () => {
            for (const id of this._calibrationHandlers)
                this._settings.disconnect(id);
            return false;
        });
    }

    _toast(title) {
        this._window.add_toast(new Adw.Toast({title, timeout: 2}));
    }

    _buildGeneralPage() {
        const page = new Adw.PreferencesPage({title: _('General'), icon_name: 'preferences-system-symbolic'});

        const general = new Adw.PreferencesGroup({title: _('General')});
        const bind = (key, row) => {
            this._settings.bind(key, row, row instanceof Adw.SpinRow ? 'value' : 'active', Gio.SettingsBindFlags.DEFAULT);
            general.add(row);
        };
        bind('cursor-tracking-enabled', new Adw.SwitchRow({
            title: _('Cursor tracking'),
            subtitle: _('Use the speed of the window under the pointer, even if it is not focused'),
        }));
        bind('cursor-poll-interval', new Adw.SpinRow({
            title: _('Cursor check interval (ms)'),
            adjustment: new Gtk.Adjustment({lower: 50, upper: 2000, step_increment: 10, page_increment: 100}),
        }));
        bind('focus-detection-enabled', new Adw.SwitchRow({title: _('Focus detection')}));
        bind('overview-global-factor', new Adw.SwitchRow({
            title: _('Use global speed in the Overview'),
            subtitle: _('Scroll and swipe at the global speed while the Activities overview or app grid is open'),
        }));
        bind('show-quick-settings', new Adw.SwitchRow({
            title: _('Quick Settings tile'),
            subtitle: _('Shows the applied speeds, with − / + for the focused app and the calibration actions'),
        }));
        page.add(general);

        page.add(this._buildCalibrationGroup());

        const backup = new Adw.PreferencesGroup({
            title: _('Backup'),
            description: _('Save or restore all speeds, rules and calibration as a JSON file.'),
        });
        for (const [title, callback] of [[_('Export Settings'), () => this._export()], [_('Import Settings'), () => this._import()]]) {
            const row = new Adw.ActionRow({title, activatable: true});
            row.add_suffix(new Gtk.Image({icon_name: 'go-next-symbolic'}));
            row.connect('activated', callback);
            backup.add(row);
        }
        page.add(backup);

        const debug = new Adw.PreferencesGroup({title: _('Debugging')});
        for (const [key, title, subtitle] of [
            ['show-panel-indicator', _('Panel indicator'), _('Shows the applied speeds in the top bar')],
            ['debug-logging', _('Debug logging'), _('View with: journalctl -f -o cat | grep TouchpadSpeed')],
        ]) {
            const row = new Adw.SwitchRow({title, subtitle});
            this._settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            debug.add(row);
        }
        page.add(debug);
        return page;
    }

    _buildAxisPage(axis) {
        const {global, other} = AXES[axis];
        const name = _(AXES[axis].name);
        const page = new Adw.PreferencesPage({
            title: name,
            icon_name: axis === 'v' ? 'object-flip-vertical-symbolic' : 'object-flip-horizontal-symbolic',
        });

        const globalGroup = new Adw.PreferencesGroup({
            title: _('%s Scroll').replace('%s', name),
            description: _('Speed for apps without their own setting. Moving it sets every app to the same speed.'),
        });
        const actions = new Gtk.Box({spacing: 6});
        for (const [label, callback] of [
            [_('Reset'), () => this._reset(axis)],
            [_('Copy to %s').replace('%s', _(AXES[other].name)), () => this._copyAxis(axis)],
        ]) {
            const button = new Gtk.Button({label, css_classes: ['flat']});
            button.connect('clicked', callback);
            actions.append(button);
        }
        globalGroup.set_header_suffix(actions);
        this._globalRows[axis] = this._factorRow({
            title: _('Global speed'),
            iconName: axis === 'v' ? 'go-down-symbolic' : 'go-next-symbolic',
            value: this._settings.get_double(global),
            onChange: value => this._setGlobal(axis, value),
        });
        globalGroup.add(this._globalRows[axis]);
        page.add(globalGroup);

        const rules = new Adw.PreferencesGroup({
            title: _('Rules'),
            description: _('Give every app whose ID matches a rule the same speed, including apps installed later. ' +
                '* matches anything, ? one character, for example brave-* for all Brave web apps. ' +
                'A speed set for a single app takes priority.'),
        });
        const entry = new Adw.EntryRow({title: _('New rule'), show_apply_button: true});
        entry.connect('apply', () => {
            if (this._addRule(axis, entry.text))
                entry.text = '';
        });
        rules.add(entry);
        this._ruleGroups[axis] = rules;
        page.add(rules);

        const apps = new Adw.PreferencesGroup({title: _('Applications')});
        const search = new Gtk.SearchEntry({placeholder_text: _('Search applications'), margin_bottom: 12});
        const list = new Gtk.ListBox({selection_mode: Gtk.SelectionMode.NONE, css_classes: ['boxed-list']});
        list.set_filter_func(row => {
            const text = search.text.toLowerCase();
            return row.app.name.toLowerCase().includes(text) || row.app.id.toLowerCase().includes(text);
        });
        search.connect('search-changed', () => list.invalidate_filter());
        apps.add(search);
        apps.add(list);
        this._lists[axis] = list;
        page.add(apps);

        this._render(axis);
        return page;
    }

    // A row with a slider, − / + and the value; saves when the slider stops
    // moving rather than on every step of a drag
    _factorRow({title, gicon = null, iconName = null, value, tooltip = null, onChange}) {
        const row = new Adw.ActionRow({title, use_markup: false, title_lines: 1});
        if (gicon || iconName)
            row.add_prefix(new Gtk.Image(gicon ? {gicon, pixel_size: 32} : {icon_name: iconName, pixel_size: 32}));

        const adjustment = new Gtk.Adjustment({lower: FACTOR_MIN, upper: FACTOR_MAX, step_increment: FACTOR_STEP, page_increment: 0.1, value});
        const scale = new Gtk.Scale({adjustment, width_request: 180, draw_value: false, valign: Gtk.Align.CENTER});
        for (const mark of [0.15, 0.35, 0.5, 1.0])
            scale.add_mark(mark, Gtk.PositionType.BOTTOM, null);
        const label = new Gtk.Label({label: value.toFixed(2), width_chars: 5, xalign: 1, css_classes: ['dim-label'], tooltip_text: tooltip});

        let source = 0;
        adjustment.connect('value-changed', () => {
            label.label = adjustment.value.toFixed(2);
            if (row.quiet)
                return;
            if (source)
                GLib.source_remove(source);
            source = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                source = 0;
                onChange(Math.round(adjustment.value * 100) / 100);
                return GLib.SOURCE_REMOVE;
            });
        });
        const stepButton = (text, delta) => {
            const button = new Gtk.Button({label: text, valign: Gtk.Align.CENTER, css_classes: ['circular', 'flat']});
            button.connect('clicked', () => adjustment.set_value(adjustment.value + delta));
            return button;
        };
        row.add_suffix(scale);
        row.add_suffix(stepButton('−', -FACTOR_STEP));
        row.add_suffix(label);
        row.add_suffix(stepButton('+', FACTOR_STEP));
        row.setValue = newValue => {
            row.quiet = true;
            adjustment.value = newValue;
            row.quiet = false;
        };
        return row;
    }

    _loadApps() {
        const apps = new Map();
        for (const info of Gio.AppInfo.get_all()) {
            const id = normalizeAppId(info.get_id() ?? '');
            if (info.should_show() && id && !apps.has(id))
                apps.set(id, {id, name: info.get_display_name(), gicon: info.get_icon(), exec: info.get_commandline() ?? ''});
        }
        // Hide URL-handler duplicates (code-url-handler next to code)
        for (const [id, app] of apps) {
            const base = id.replace('-url-handler', '').replace('-default', '');
            if (base !== id && apps.has(base) && / %[uU]\b/.test(app.exec))
                apps.delete(id);
        }
        return [...apps.values()].sort((a, b) =>
            (KNOWN_APPS.has(b.id) - KNOWN_APPS.has(a.id)) || a.name.localeCompare(b.name));
    }

    _render(axis) {
        const {factors: key, global} = AXES[axis];
        const factors = this._settings.get_value(key).deep_unpack();
        const globalFactor = this._settings.get_double(global);
        this._globalRows[axis].setValue(globalFactor);

        const row = (title, id, extra) => {
            const resolved = resolveFactor(factors, id, globalFactor);
            return this._factorRow({
                title,
                value: resolved.factor,
                tooltip: ['pattern', 'partial'].includes(resolved.source) ? _('Set by %s').replace('%s', resolved.key) : null,
                onChange: value => this._setAppFactor(axis, id, value),
                ...extra,
            });
        };

        const list = this._lists[axis];
        list.remove_all();
        for (const app of this._apps) {
            const appRow = row(app.name, app.id, {gicon: app.gicon ?? null, iconName: app.gicon ? null : 'application-x-executable'});
            appRow.app = app;
            list.append(appRow);
        }

        for (const ruleRow of this._ruleRows[axis])
            this._ruleGroups[axis].remove(ruleRow);
        this._ruleRows[axis] = Object.keys(factors).filter(isPattern).sort().map(rule => {
            const ruleRow = row(rule, rule, {iconName: 'edit-find-symbolic'});
            const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', tooltip_text: _('Remove rule'), valign: Gtk.Align.CENTER, css_classes: ['flat']});
            remove.connect('clicked', () => this._removeRule(axis, rule));
            ruleRow.add_suffix(remove);
            this._ruleGroups[axis].add(ruleRow);
            return ruleRow;
        });
    }

    // Writes factors for one axis, keeping calibrated apps matched to the reference
    _writeFactors(axis, factors) {
        const {factors: key, global} = AXES[axis];
        const reference = this._settings.get_string('scroll-reference');
        let gains = this._settings.get_value('scroll-gains').deep_unpack();
        if (axis === 'h')
            gains = horizontalMatchingGains(gains, this._settings.get_value('h-scroll-gains').deep_unpack(), reference);
        const matched = applyMatchedFactors(factors, this._settings.get_double(global), gains,
            this._settings.get_strv('matched-apps'), reference);
        this._settings.set_value(key, new GLib.Variant('a{sd}', matched ?? factors));
    }

    _setGlobal(axis, value) {
        this._settings.set_double(AXES[axis].global, value);
        const factors = this._settings.get_value(AXES[axis].factors).deep_unpack();
        for (const id of Object.keys(factors))
            factors[id] = value;
        this._writeFactors(axis, factors);
        this._render(axis);
    }

    _setAppFactor(axis, id, value) {
        // A hand-set speed stops the app following the scroll reference
        const matched = this._settings.get_strv('matched-apps');
        const stillMatched = matched.filter(appId => normalizeAppId(appId) !== normalizeAppId(id));
        if (stillMatched.length !== matched.length) {
            this._settings.set_strv('matched-apps', stillMatched);
            this._toast(_('%s no longer follows the scroll reference').replace('%s', this._appName(id)));
        }
        const factors = this._settings.get_value(AXES[axis].factors).deep_unpack();
        factors[id] = value;
        this._settings.set_value(AXES[axis].factors, new GLib.Variant('a{sd}', factors));
        if (isPattern(id))
            this._render(axis);
    }

    _reset(axis) {
        this._setGlobal(axis, 1.0);
        this._toast(_('%s speeds reset').replace('%s', _(AXES[axis].name)));
    }

    _copyAxis(axis) {
        const from = AXES[axis];
        const to = AXES[from.other];
        this._settings.set_double(to.global, this._settings.get_double(from.global));
        this._writeFactors(from.other, this._settings.get_value(from.factors).deep_unpack());
        this._render(from.other);
        this._toast(_('Copied to %s').replace('%s', _(to.name)));
    }

    _addRule(axis, rule) {
        const error = validatePattern(rule);
        const factors = this._settings.get_value(AXES[axis].factors).deep_unpack();
        if (error || Object.hasOwn(factors, rule)) {
            this._toast(error ? _(error) : _('That rule already exists'));
            return false;
        }
        this._setAppFactor(axis, rule, this._settings.get_double(AXES[axis].global));
        return true;
    }

    _removeRule(axis, rule) {
        const factors = this._settings.get_value(AXES[axis].factors).deep_unpack();
        delete factors[rule];
        this._settings.set_value(AXES[axis].factors, new GLib.Variant('a{sd}', factors));
        this._render(axis);
    }

    _appName(appId) {
        const id = normalizeAppId(appId);
        return this._apps.find(app => app.id === id)?.name ?? id;
    }

    _buildCalibrationGroup() {
        this._calibrationGroup = new Adw.PreferencesGroup({
            title: _('Calibration'),
            description: _('Match apps to one reference app so a swipe scrolls the same distance everywhere. ' +
                'To measure an app, open a long page in it, click into it, and choose "Use … as scroll reference" or ' +
                '"Match …" in the Touchpad tile\'s menu in Quick Settings. For horizontal scrolling, also choose ' +
                '"Measure horizontal scrolling" on something that scrolls sideways.'),
        });
        const clear = new Gtk.Button({label: _('Clear'), valign: Gtk.Align.CENTER, css_classes: ['flat'],
            tooltip_text: _('Forget all measurements. Speeds stay as they are.')});
        clear.connect('clicked', () => {
            this._settings.set_strv('matched-apps', []);
            this._settings.set_string('scroll-reference', '');
            this._settings.set_value('h-scroll-gains', new GLib.Variant('a{sd}', {}));
            this._settings.set_value('scroll-gains', new GLib.Variant('a{sd}', {}));
        });
        this._calibrationGroup.set_header_suffix(clear);
        this._calibrationClear = clear;
        this._calibrationRows = [];
        this._calibrationHandlers = ['scroll-gains', 'h-scroll-gains', 'scroll-reference', 'matched-apps']
            .map(key => this._settings.connect(`changed::${key}`, () => this._renderCalibration()));
        this._renderCalibration();
        return this._calibrationGroup;
    }

    _renderCalibration() {
        for (const row of this._calibrationRows)
            this._calibrationGroup.remove(row);
        const s = this._settings;
        const gains = s.get_value('scroll-gains').deep_unpack();
        const hGains = s.get_value('h-scroll-gains').deep_unpack();
        const reference = s.get_string('scroll-reference');
        const state = {
            gains, hGains, reference,
            matched: s.get_strv('matched-apps'),
            referenceGain: gains[reference],
            referenceHorizontal: hGains[reference] ?? gains[reference],
        };

        const ids = [...new Set([...Object.keys(gains), ...Object.keys(hGains)])]
            .sort((a, b) => (b === reference) - (a === reference) || this._appName(a).localeCompare(this._appName(b)));
        this._calibrationClear.sensitive = ids.length > 0;
        this._calibrationRows = ids.length
            ? ids.map(id => this._calibrationRow(id, state))
            : [new Adw.ActionRow({title: _('No apps measured yet')})];
        for (const row of this._calibrationRows)
            this._calibrationGroup.add(row);
    }

    _calibrationRow(id, {gains, hGains, reference, matched, referenceGain, referenceHorizontal}) {
        const s = this._settings;
        const parts = [];
        if (!gains[id])
            parts.push(_('Not measured vertically'));
        else if (id === reference)
            parts.push(_('Reference'), _('%s px per unit').replace('%s', gains[id].toFixed(2)));
        else if (referenceGain)
            parts.push(_('%s× the reference').replace('%s', (gains[id] / referenceGain).toFixed(2)), _('%s px per unit').replace('%s', gains[id].toFixed(2)));
        else
            parts.push(_('%s px per unit').replace('%s', gains[id].toFixed(2)));
        if (hGains[id]) {
            parts.push(id !== reference && referenceHorizontal
                ? _('sideways %s× the reference').replace('%s', (hGains[id] / referenceHorizontal).toFixed(2))
                : _('sideways %s px per unit').replace('%s', hGains[id].toFixed(2)));
        }
        const row = new Adw.ActionRow({title: this._appName(id), subtitle: parts.join(' · '), use_markup: false});

        if (gains[id] && id !== reference) {
            const makeReference = new Gtk.Button({icon_name: 'starred-symbolic', tooltip_text: _('Use as the scroll reference'),
                valign: Gtk.Align.CENTER, css_classes: ['flat']});
            makeReference.connect('clicked', () => {
                s.set_strv('matched-apps', s.get_strv('matched-apps').filter(m => m !== id));
                s.set_string('scroll-reference', id);
            });
            row.add_suffix(makeReference);

            const follow = new Gtk.Switch({active: matched.includes(id), sensitive: !!referenceGain, valign: Gtk.Align.CENTER,
                tooltip_text: _('Follow the reference')});
            follow.connect('notify::active', () => {
                const others = s.get_strv('matched-apps').filter(m => m !== id);
                s.set_strv('matched-apps', follow.active ? [...others, id] : others);
            });
            row.add_suffix(follow);
        }

        const forget = new Gtk.Button({icon_name: 'user-trash-symbolic', tooltip_text: _('Forget this measurement'),
            valign: Gtk.Align.CENTER, css_classes: ['flat']});
        forget.connect('clicked', () => {
            const without = key => {
                const values = s.get_value(key).deep_unpack();
                delete values[id];
                return new GLib.Variant('a{sd}', values);
            };
            s.set_strv('matched-apps', s.get_strv('matched-apps').filter(m => m !== id));
            if (s.get_string('scroll-reference') === id)
                s.set_string('scroll-reference', '');
            s.set_value('h-scroll-gains', without('h-scroll-gains'));
            s.set_value('scroll-gains', without('scroll-gains'));
        });
        row.add_suffix(forget);
        return row;
    }

    _export() {
        const s = this._settings;
        const data = {
            version: 1,
            vertical: {global_factor: s.get_double('global-factor'), app_factors: s.get_value('app-factors').deep_unpack()},
            horizontal: {global_factor: s.get_double('h-global-factor'), app_factors: s.get_value('h-app-factors').deep_unpack()},
            calibration: {
                gains: s.get_value('scroll-gains').deep_unpack(),
                horizontal_gains: s.get_value('h-scroll-gains').deep_unpack(),
                reference: s.get_string('scroll-reference'),
                matched: s.get_strv('matched-apps'),
            },
        };
        const dialog = new Gtk.FileDialog({title: _('Export Settings'), initial_name: 'touchpad-speed-control-settings.json'});
        dialog.save(this._window, null, (d, result) => {
            let file;
            try {
                file = d.save_finish(result);
            } catch {
                return; // cancelled
            }
            const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(data, null, 2)));
            file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.NONE, null, (f, res) => {
                try {
                    f.replace_contents_finish(res);
                    this._toast(_('Settings exported'));
                } catch {
                    this._toast(_('Failed to export settings'));
                }
            });
        });
    }

    _import() {
        const dialog = new Gtk.FileDialog({title: _('Import Settings')});
        dialog.open(this._window, null, (d, result) => {
            let file;
            try {
                file = d.open_finish(result);
            } catch {
                return; // cancelled
            }
            file.load_contents_async(null, (f, res) => {
                let data;
                try {
                    data = JSON.parse(new TextDecoder().decode(f.load_contents_finish(res)[1]));
                } catch {
                    this._toast(_('Could not read the file'));
                    return;
                }
                if (data?.version !== 1 || !data.vertical || !data.horizontal) {
                    this._toast(_('Invalid file format'));
                    return;
                }

                // Rules and installed apps only
                const installed = new Set(this._apps.map(app => app.id));
                for (const [axis, section] of [['v', data.vertical], ['h', data.horizontal]]) {
                    if (typeof section.global_factor === 'number')
                        this._settings.set_double(AXES[axis].global, section.global_factor);
                    if (section.app_factors && typeof section.app_factors === 'object') {
                        const factors = Object.fromEntries(Object.entries(section.app_factors)
                            .filter(([id, factor]) => typeof factor === 'number' && (installed.has(id) || isPattern(id))));
                        this._settings.set_value(AXES[axis].factors, new GLib.Variant('a{sd}', factors));
                    }
                }
                // Files from older versions have no calibration; keep the current one
                const calibration = calibrationFromJson(data.calibration);
                if (calibration) {
                    this._settings.set_value('scroll-gains', new GLib.Variant('a{sd}', calibration.gains));
                    this._settings.set_value('h-scroll-gains', new GLib.Variant('a{sd}', calibration.horizontalGains));
                    this._settings.set_string('scroll-reference', calibration.reference);
                    this._settings.set_strv('matched-apps', calibration.matched);
                }
                this._render('v');
                this._render('h');
                this._toast(_('Settings imported'));
            });
        });
    }
}
