// SPDX-License-Identifier: GPL-3.0-or-later

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

import {cancelCalibration, measureWindowGain, resetCalibration, wait} from './calibration.js';
import {applyMatchedFactors, horizontalMatchingGains, normalizeAppId, resolveFactor} from './factorResolver.js';
import {findWSFPath, isWSFActive} from './wsf.js';

const FACTOR_MIN = 0.05;
const FACTOR_MAX = 2.0;
const FACTOR_STEP = 0.01;

const FACTOR_KEYS = [
    'app-factors', 'h-app-factors', 'global-factor', 'h-global-factor',
    'scroll-gains', 'h-scroll-gains', 'scroll-reference', 'matched-apps',
];

export default class TouchpadSpeedControlExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        resetCalibration();

        this._wsfPath = findWSFPath();
        if (!this._wsfPath) {
            Main.notify('WSF Not Installed',
                'Touchpad Speed Control requires Wayland Scroll Factor (WSF): https://github.com/daniel-g-carrasco/wayland-scroll-factor');
            return;
        }

        this._wsfCheck = new Gio.Cancellable();
        const proc = Gio.Subprocess.new([this._wsfPath, 'status'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
        proc.communicate_utf8_async(null, this._wsfCheck, (p, result) => {
            let stdout = null;
            try {
                [, stdout] = p.communicate_utf8_finish(result);
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                console.error(`[TouchpadSpeed] wsf status failed: ${e.message}`);
            }
            this._wsfCheck = null;
            if (isWSFActive(stdout))
                this._start();
            else
                Main.notify('WSF Preload Not Active', 'Run "wsf enable" and log out and back in.');
        });
    }

    disable() {
        cancelCalibration();
        this._wsfCheck?.cancel();
        this._wsfCheck = null;

        for (const id of this._settingsHandlers ?? [])
            this._settings.disconnect(id);
        this._settingsHandlers = null;
        for (const [object, id] of this._windowHandlers ?? [])
            object.disconnect(id);
        this._windowHandlers = null;

        this._stopCursorTracking();
        this._disconnectFocus();
        this._hideIndicator();
        this._hideQuickSettings();

        this._windowTracker = null;
        this._windowUnderCursor = null;
        this._applied = null;
        // A running `wsf set` finishes on its own; its callback sees it is stale
        this._wsfProcess = null;
        this._pendingFactors = null;
        this._settings = null;
    }

    _start() {
        this._windowTracker = Shell.WindowTracker.get_default();

        const toggle = (key, on, off) => () => (this._settings.get_boolean(key) ? on : off).call(this);
        const handlers = {
            'cursor-tracking-enabled': toggle('cursor-tracking-enabled', this._startCursorTracking, this._stopCursorTracking),
            'cursor-poll-interval': () => {
                if (this._settings.get_boolean('cursor-tracking-enabled')) {
                    this._stopCursorTracking();
                    this._startCursorTracking();
                }
            },
            'focus-detection-enabled': toggle('focus-detection-enabled', this._connectFocus, this._disconnectFocus),
            'show-panel-indicator': toggle('show-panel-indicator', this._showIndicator, this._hideIndicator),
            'show-quick-settings': toggle('show-quick-settings', this._showQuickSettings, this._hideQuickSettings),
            'overview-global-factor': () => this._handleChange(),
        };
        for (const key of FACTOR_KEYS) {
            handlers[key] = () => {
                this._syncMatchedApps();
                this._handleChange();
            };
        }
        this._settingsHandlers = Object.entries(handlers).map(([key, handler]) => {
            if (key.endsWith('-enabled') || key.startsWith('show-'))
                handler();
            return this._settings.connect(`changed::${key}`, handler);
        });

        // These can put a different window under a pointer that does not move
        const recheck = () => this._recheck();
        this._windowHandlers = [
            [global.display, global.display.connect('restacked', recheck)],
            [global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', recheck)],
            [Main.overview, Main.overview.connect('hidden', recheck)],
            [Main.overview, Main.overview.connect('showing', () => this._handleChange())],
        ];

        this._syncMatchedApps();
        this._handleChange();
    }

    _log(message) {
        if (this._settings?.get_boolean('debug-logging'))
            console.log(`[TouchpadSpeed] ${message}`);
    }

    _startCursorTracking() {
        if (this._cursorTracker)
            return;
        this._cursorTracker = global.backend.get_cursor_tracker();
        this._cursorHandler = this._cursorTracker.connect('position-invalidated', () => this._scheduleCursorCheck());
        this._scheduleCursorCheck(true);
    }

    _stopCursorTracking() {
        if (this._cursorTracker) {
            this._cursorTracker.disconnect(this._cursorHandler);
            this._cursorTracker = null;
            this._cursorHandler = null;
        }
        if (this._cursorCheckSource) {
            GLib.source_remove(this._cursorCheckSource);
            this._cursorCheckSource = null;
        }
        this._forceCursorCheck = false;
        this._windowUnderCursor = null;
        this._lastPointer = null;
    }

    // Pointer motion is coalesced into at most one check per poll interval
    _scheduleCursorCheck(force = false) {
        this._forceCursorCheck ||= force;
        if (this._cursorCheckSource)
            return;
        this._cursorCheckSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            this._settings.get_int('cursor-poll-interval'), () => {
                this._cursorCheckSource = null;
                const forced = this._forceCursorCheck;
                this._forceCursorCheck = false;
                this._updateCursorWindow(forced);
                return GLib.SOURCE_REMOVE;
            });
    }

    _updateCursorWindow(force) {
        const [x, y] = global.get_pointer();
        if (!force && this._lastPointer?.[0] === x && this._lastPointer?.[1] === y)
            return;
        this._lastPointer = [x, y];

        let actor = global.stage.get_actor_at_pos(Clutter.PickMode.NONE, x, y);
        while (actor && !actor.get_meta_window)
            actor = actor.get_parent();
        const window = actor?.get_meta_window() ?? null;
        if (!force && window === this._windowUnderCursor)
            return;
        this._windowUnderCursor = window;
        this._handleChange();
    }

    _recheck() {
        if (this._cursorTracker)
            this._scheduleCursorCheck(true);
        else
            this._handleChange();
    }

    _connectFocus() {
        this._focusHandler ??= global.display.connect('notify::focus-window', () => this._recheck());
    }

    _disconnectFocus() {
        if (this._focusHandler) {
            global.display.disconnect(this._focusHandler);
            this._focusHandler = null;
        }
    }

    _resolveFactor(axis, appId) {
        const factors = this._settings.get_value(axis === 'v' ? 'app-factors' : 'h-app-factors').deep_unpack();
        const global = this._settings.get_double(axis === 'v' ? 'global-factor' : 'h-global-factor');
        return resolveFactor(factors, appId, global).factor;
    }

    _handleChange() {
        if (!this._windowTracker)
            return;

        // The overview and app grid are shell UI, so swipe there at the global speed
        if (this._settings.get_boolean('overview-global-factor') && Main.overview.visible) {
            this._apply(this._settings.get_double('global-factor'), this._settings.get_double('h-global-factor'));
            return;
        }

        const window = this._windowUnderCursor ?? global.display.focus_window;
        const app = window && this._windowTracker.get_window_app(window);
        if (!app)
            return;
        const appId = app.get_id();
        const v = this._resolveFactor('v', appId);
        const h = this._resolveFactor('h', appId);
        this._log(`${appId}: V=${v} H=${h}`);
        this._apply(v, h);
    }

    _apply(v, h) {
        if (this._applied?.[0] === v && this._applied?.[1] === h)
            return;
        this._applied = [v, h];
        this._indicatorLabel?.set_text(`V: ${v.toFixed(2)}  H: ${h.toFixed(2)}`);
        if (this._quickToggle)
            this._quickToggle.subtitle = `V ${v.toFixed(2)} · H ${h.toFixed(2)}`;

        // Each `wsf set` rewrites the whole config, so runs must not overlap;
        // while one runs, only the latest request is kept
        this._pendingFactors = [v, h];
        if (!this._wsfProcess)
            this._runWsf();
    }

    _runWsf() {
        const [v, h] = this._pendingFactors;
        this._pendingFactors = null;
        const proc = Gio.Subprocess.new(
            [this._wsfPath, 'set', '--scroll-vertical', `${v}`, '--scroll-horizontal', `${h}`],
            Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
        this._wsfProcess = proc;
        proc.wait_async(null, (p, result) => {
            p.wait_finish(result);
            if (this._wsfProcess !== p)
                return;
            this._wsfProcess = null;
            if (this._pendingFactors)
                this._runWsf();
        });
    }

    // Matched apps keep their measured ratio to the reference app, so they
    // change with it when its factor (or the global one) changes
    _syncMatchedApps() {
        const matched = this._settings.get_strv('matched-apps');
        if (!matched.length)
            return;
        const reference = this._settings.get_string('scroll-reference');
        const gains = this._settings.get_value('scroll-gains').deep_unpack();
        const hGains = horizontalMatchingGains(gains, this._settings.get_value('h-scroll-gains').deep_unpack(), reference);
        for (const [key, globalKey, axisGains] of [
            ['app-factors', 'global-factor', gains],
            ['h-app-factors', 'h-global-factor', hGains],
        ]) {
            const updated = applyMatchedFactors(this._settings.get_value(key).deep_unpack(),
                this._settings.get_double(globalKey), axisGains, matched, reference);
            if (updated)
                this._settings.set_value(key, new GLib.Variant('a{sd}', updated));
        }
    }

    _showIndicator() {
        if (this._indicator)
            return;
        this._indicator = new PanelMenu.Button(0.0, 'TouchpadSpeedIndicator');
        this._indicatorLabel = new St.Label({text: 'V: -  H: -', y_align: Clutter.ActorAlign.CENTER});
        this._indicator.add_child(this._indicatorLabel);
        this._indicatorHandlers = [];
        const menu = this._indicator.menu;
        this._indicatorItems = this._addCalibrationItems(menu, this._indicatorHandlers);
        this._connect(this._indicatorHandlers, menu, 'open-state-changed',
            (m, open) => open && this._updateCalibrationItems(this._indicatorItems));
        Main.panel.addToStatusArea('touchpad-speed-indicator', this._indicator, 1, 'right');
        this._applied = null;
        this._handleChange();
    }

    _hideIndicator() {
        if (!this._indicator)
            return;
        for (const [object, id] of this._indicatorHandlers)
            object.disconnect(id);
        this._indicatorHandlers = null;
        this._indicator.destroy();
        this._indicator = null;
        this._indicatorLabel = null;
        this._indicatorItems = null;
    }

    _connect(handlers, object, signal, callback) {
        handlers.push([object, object.connect(signal, callback)]);
    }

    _addCalibrationItems(menu, handlers) {
        const items = {};
        for (const mode of ['reference', 'match', 'horizontal']) {
            items[mode] = new PopupMenu.PopupMenuItem('');
            this._connect(handlers, items[mode], 'activate', () => this._calibrate(mode));
            menu.addMenuItem(items[mode]);
        }
        return items;
    }

    _updateCalibrationItems(items) {
        const app = this._focusedApp();
        const name = app?.get_name();
        const reference = this._settings.get_string('scroll-reference');
        items.reference.label.text = name ? `Use ${name} as scroll reference` : 'Focus an app window to calibrate';
        items.match.label.text = reference ? `Match ${name ?? 'focused app'} to ${this._appName(reference)}` : 'Set a scroll reference first';
        items.horizontal.label.text = `Measure horizontal scrolling${name ? ` of ${name}` : ''}`;
        items.reference.setSensitive(!!app && !this._calibrating);
        items.match.setSensitive(!!app && !!reference && app.get_id() !== reference && !this._calibrating);
        items.horizontal.setSensitive(!!app && !this._calibrating);
    }

    _showQuickSettings() {
        if (this._quickIndicator)
            return;
        this._quickHandlers = [];
        const on = (object, signal, callback) => this._connect(this._quickHandlers, object, signal, callback);

        // Not a toggle: clicking opens the preferences, the arrow opens the menu
        this._quickToggle = new QuickSettings.QuickMenuToggle({
            title: 'Touchpad',
            iconName: 'input-touchpad-symbolic',
            toggleMode: false,
        });
        const openPreferences = () => {
            Main.panel.closeQuickSettings();
            this.openPreferences();
        };
        on(this._quickToggle, 'clicked', openPreferences);

        const menu = this._quickToggle.menu;
        this._factorRows = ['v', 'h'].map(axis => {
            const row = new PopupMenu.PopupBaseMenuItem({activate: false, hover: false, can_focus: false});
            row.add_child(new St.Label({
                text: axis === 'v' ? 'Vertical' : 'Horizontal',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
            }));
            row.value = new St.Label({y_align: Clutter.ActorAlign.CENTER, style: 'margin-right: 6px;'});
            row.add_child(row.value);
            row.buttons = [[-FACTOR_STEP, 'list-remove-symbolic'], [FACTOR_STEP, 'list-add-symbolic']].map(([step, icon]) => {
                const button = new St.Button({icon_name: icon, style_class: 'icon-button', can_focus: true});
                on(button, 'clicked', () => this._stepFactor(axis, step));
                row.add_child(button);
                return button;
            });
            menu.addMenuItem(row);
            return {axis, row};
        });

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._calibrationItems = this._addCalibrationItems(menu, this._quickHandlers);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settingsItem = new PopupMenu.PopupMenuItem('Touchpad Speed Settings');
        on(settingsItem, 'activate', openPreferences);
        menu.addMenuItem(settingsItem);
        on(menu, 'open-state-changed', (m, open) => open && this._updateQuickMenu());

        this._quickIndicator = new QuickSettings.SystemIndicator();
        this._quickIndicator.quickSettingsItems.push(this._quickToggle);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._quickIndicator);
        this._applied = null;
        this._handleChange();
    }

    _hideQuickSettings() {
        if (!this._quickIndicator)
            return;
        for (const [object, id] of this._quickHandlers)
            object.disconnect(id);
        this._quickHandlers = null;
        // Quick Settings keeps a toggle's menu in its own overlay; it is not
        // destroyed with the toggle
        this._quickToggle.menu.destroy();
        this._quickToggle.destroy();
        this._quickToggle = null;
        this._quickIndicator.destroy();
        this._quickIndicator = null;
        this._factorRows = null;
        this._calibrationItems = null;
    }

    // The focused window's app; window-backed apps ("window:123") have no
    // stable ID to store a factor under
    _focusedApp() {
        const window = global.display.focus_window;
        const app = window && this._windowTracker?.get_window_app(window);
        return app && !app.get_id().startsWith('window:') ? app : null;
    }

    _appName(appId) {
        return Shell.AppSystem.get_default().lookup_app(appId)?.get_name() ?? appId;
    }

    _updateQuickMenu() {
        const app = this._focusedApp();
        this._quickToggle.menu.setHeader('input-touchpad-symbolic', 'Touchpad Speed', app?.get_name() ?? 'No app window focused');
        for (const {axis, row} of this._factorRows) {
            row.value.text = app ? this._resolveFactor(axis, app.get_id()).toFixed(2) : '-';
            for (const button of row.buttons)
                button.reactive = !!app;
        }
        this._updateCalibrationItems(this._calibrationItems);
    }

    // Like the preferences' − / + buttons; a hand-set factor stops the app
    // following the scroll reference
    _stepFactor(axis, step) {
        const app = this._focusedApp();
        if (!app)
            return;
        const appId = app.get_id();
        const factor = Math.round(Math.min(FACTOR_MAX, Math.max(FACTOR_MIN, this._resolveFactor(axis, appId) + step)) * 100) / 100;
        this._settings.set_strv('matched-apps', this._settings.get_strv('matched-apps').filter(id => id !== appId));

        const key = axis === 'v' ? 'app-factors' : 'h-app-factors';
        const factors = this._settings.get_value(key).deep_unpack();
        factors[normalizeAppId(appId)] = factor;
        this._settings.set_value(key, new GLib.Variant('a{sd}', factors));
        this._updateQuickMenu();
    }

    async _calibrate(mode) {
        const window = global.display.focus_window;
        const app = this._focusedApp();
        if (!app || this._calibrating)
            return;
        const appId = app.get_id();
        const name = app.get_name();

        this._calibrating = true;
        Main.panel.closeQuickSettings();
        this._indicator?.menu.close();
        try {
            // Let the menu close and release its grab before scrolling
            await wait(300);
            const gain = await measureWindowGain(window, step => this._log(`Calibrate ${appId}: ${step}`), mode !== 'horizontal');
            if (this._settings)
                Main.notify(name, this._storeMeasurement(mode, appId, gain));
        } catch (e) {
            // Stay quiet if the extension was disabled meanwhile (screen locked)
            if (this._settings)
                Main.notify(`Calibration failed: ${name}`, e.message);
        } finally {
            this._calibrating = false;
        }
    }

    _storeMeasurement(mode, appId, gain) {
        const s = this._settings;
        const store = (key, value) => {
            const gains = s.get_value(key).deep_unpack();
            gains[appId] = value;
            s.set_value(key, new GLib.Variant('a{sd}', gains));
            return gains;
        };
        const reference = s.get_string('scroll-reference');
        const matched = s.get_strv('matched-apps');

        if (mode === 'horizontal') {
            const vGain = s.get_value('scroll-gains').deep_unpack()[appId];
            store('h-scroll-gains', gain);
            let text = `Scrolls ${gain.toFixed(2)} px per unit sideways`;
            if (vGain && Math.abs(Math.log(gain / vGain)) > Math.log(1.5))
                text += `, ${(gain / vGain).toFixed(1)}× its vertical speed`;
            if (matched.includes(appId))
                text += `. Horizontal speed set to ${this._resolveFactor('h', appId).toFixed(2)}`;
            return `${text}.`;
        }

        const gains = store('scroll-gains', gain);
        if (mode === 'reference') {
            s.set_strv('matched-apps', matched.filter(id => id !== appId));
            s.set_string('scroll-reference', appId);
            return `Scrolls ${gain.toFixed(2)} px per unit. Matched apps now follow it.`;
        }

        if (!gains[reference])
            return 'Measure the reference app again first.';
        if (!matched.includes(appId))
            s.set_strv('matched-apps', [...matched, appId]);
        this._syncMatchedApps();
        return `Scrolls ${(gain / gains[reference]).toFixed(2)}× as far as ${this._appName(reference)}. ` +
            `Speed set to ${this._resolveFactor('v', appId).toFixed(2)} (vertical) and ` +
            `${this._resolveFactor('h', appId).toFixed(2)} (horizontal).`;
    }
}
