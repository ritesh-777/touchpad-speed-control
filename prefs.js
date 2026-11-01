// Touchpad Speed Control - Preferences UI
// Author: Ritesh Seth
// License: GPL v3
// GitHub: https://github.com/ritesh-777/touchpad-speed-control
//
// This module provides the preferences UI for the Touchpad Speed Control extension.
// It uses libadwaita (Adw) and GTK4 to create a modern GNOME settings interface.
//
// Architecture:
//   - Three-page system: WSF missing → WSF inactive → Main tabbed UI
//   - Three tabs: General, Vertical Scroll and Horizontal Scroll (Gtk.Stack + Gtk.StackSwitcher)
//   - Each tab has: global factor slider, wildcard rules, per-app sliders, search, reset, and sync buttons
//   - _suppressSave flag prevents cascading GSettings writes during programmatic updates
//   - Direct-data rendering for sync operations bypasses GSettings cache staleness

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import { isPattern, normalizeAppId, resolveFactor, validatePattern } from './factorResolver.js';
import { findWSFPath, isWSFActive } from './wsf.js';

/**
 * TouchpadSpeedControlPreferences
 *
 * Entry point for the preferences dialog.
 *
 * On open, checks WSF status and displays one of three pages:
 *   1. _showMissingPage() — WSF binary not found, with installation instructions
 *   2. _showInactivePage() — WSF installed but preload not enabled
 *   3. _showMainUI() — WSF active, shows the full tabbed settings interface
 */
export default class TouchpadSpeedControlPreferences extends ExtensionPreferences {
    /**
     * Called by GNOME Settings to populate the preferences window.
     *
     * @param {Adw.PreferencesWindow} window - The preferences window instance.
     */
    fillPreferencesWindow(window) {
        window._settings = this.getSettings();

        window.set_default_size(850, 750);

        // Check WSF status before building any UI
        const wsfStatus = this._checkWSFStatus();

        if (!wsfStatus.installed) {
            this._showMissingPage(window);
            return;
        }

        if (!wsfStatus.active) {
            this._showInactivePage(window);
            return;
        }

        this._showMainUI(window);
    }

    /**
     * Checks if WSF is installed and active.
     *
     * Runs `wsf status` and parses output for:
     *   - "enabled: yes" — environment.d config present
     *   - "gnome-shell library mapped: yes" — preload library loaded into gnome-shell
     *
     * @returns {Object} { installed: boolean, active: boolean }
     */
     _checkWSFStatus() {
        const wsfPath = findWSFPath();
        if (!wsfPath) {
            return { installed: false, active: false };
        }

        try {
            const subprocess = Gio.Subprocess.new(
                [wsfPath, 'status'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE
            );
            const [, stdout] = subprocess.communicate_utf8(null, null);
            subprocess.wait(null);

            return { installed: true, active: isWSFActive(stdout) };
        } catch (e) {
            return { installed: true, active: false };
        }
    }

    /**
     * Displays the "WSF Not Installed" page.
     *
     * Shows an Adw.StatusPage with installation instructions and a button
     * to open the WSF GitHub repository in the default browser.
     * All scroll controls are hidden — the user must install WSF first.
     *
     * @param {Adw.PreferencesWindow} window - The preferences window instance.
     */
    _showMissingPage(window) {
        const page = new Adw.PreferencesPage({
            title: _('Touchpad Speed Control'),
            icon_name: 'input-mouse-symbolic'
        });

        const group = new Adw.PreferencesGroup();

        const statusPage = new Adw.StatusPage({
            title: _('WSF Not Installed'),
            description: _('Touchpad Speed Control requires Wayland Scroll Factor (WSF) to function.'),
            icon_name: 'dialog-warning-symbolic',
            vexpand: true
        });

        const installBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 24,
            margin_end: 24
        });

        const stepsLabel = new Gtk.Label({
            label: _('To install WSF:\n\n1. Visit: https://github.com/daniel-g-carrasco/wayland-scroll-factor\n2. Follow the installation instructions for your distribution\n3. After installation, run: wsf enable\n4. Log out and log back in'),
            wrap: true,
            xalign: 0,
            css_classes: ['body']
        });
        installBox.append(stepsLabel);

        const openButton = new Gtk.Button({
            label: _('Open GitHub'),
            halign: Gtk.Align.CENTER,
            margin_top: 8
        });
        openButton.connect('clicked', () => {
            const launcher = Gtk.UriLauncher.new('https://github.com/daniel-g-carrasco/wayland-scroll-factor');
            launcher.launch(window, null, (obj, res) => {
                try {
                    obj.launch_finish(res);
                } catch (e) {}
            });
        });
        installBox.append(openButton);

        group.add(statusPage);
        group.add(installBox);
        page.add(group);
        window.add(page);
    }

    /**
     * Displays the "WSF Preload Not Active" page.
     *
     * Shows an Adw.StatusPage with activation instructions and a "Check Again"
     * button that re-runs the WSF status check. If WSF is now active, closes the
     * current window and opens a new one with the main UI.
     *
     * @param {Adw.PreferencesWindow} window - The preferences window instance.
     */
    _showInactivePage(window) {
        const page = new Adw.PreferencesPage({
            title: _('Touchpad Speed Control'),
            icon_name: 'input-mouse-symbolic'
        });

        const group = new Adw.PreferencesGroup();

        const statusPage = new Adw.StatusPage({
            title: _('WSF Preload Not Active'),
            description: _('The WSF preload library must be enabled for scroll factor changes to take effect.'),
            icon_name: 'dialog-warning-symbolic',
            vexpand: true
        });

        const stepsBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 12,
            margin_top: 12,
            margin_bottom: 12,
            margin_start: 24,
            margin_end: 24
        });

        const stepsLabel = new Gtk.Label({
            label: _('To activate WSF:\n\n1. Open a terminal\n2. Run: wsf enable\n3. Log out of your session\n4. Log back in\n\nAfter logging in, reopen the extension settings.'),
            wrap: true,
            xalign: 0,
            css_classes: ['body']
        });
        stepsBox.append(stepsLabel);

        const checkButton = new Gtk.Button({
            label: _('Check Again'),
            halign: Gtk.Align.CENTER,
            margin_top: 8,
            css_classes: ['suggested-action']
        });
        checkButton.connect('clicked', () => {
            const wsfStatus = this._checkWSFStatus();
            if (wsfStatus.active) {
                window.close();
                this._openPrefsWindow();
            }
        });
        stepsBox.append(checkButton);

        group.add(statusPage);
        group.add(stepsBox);
        page.add(group);
        window.add(page);
    }

    /**
     * Opens a new preferences window with the main UI.
     * Used after the user clicks "Check Again" and WSF is now active.
     */
    _openPrefsWindow() {
        const window = new Adw.PreferencesWindow();
        window.set_default_size(850, 750);
        this._showMainUI(window);
        window.present();
    }

    /**
     * Displays the main tabbed settings interface.
     *
     * Structure:
     *   - Vertical Scroll tab: global slider, per-app sliders, search, reset, sync
     *   - Horizontal Scroll tab: same layout, independent settings
     *   - Gtk.StackSwitcher for tab navigation
     *
     * @param {Adw.PreferencesWindow} window - The preferences window instance.
     */
    _showMainUI(window) {
        window._settings = this.getSettings();
        const settingsUI = new Settings(window._settings);
        settingsUI._window = window;

        const page = new Adw.PreferencesPage({
            title: _('Touchpad Speed Control'),
            icon_name: 'input-mouse-symbolic'
        });

        // General tab content
        const generalGroup = new Adw.PreferencesGroup({
            title: _('General'),
            description: _('Configure detection behavior and performance. Export/import your settings at the bottom.')
        });

        const cursorRow = new Adw.PreferencesRow({ activatable: false });
        const cursorBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            margin_start: 12,
            margin_end: 12,
            margin_top: 8,
            margin_bottom: 8
        });
        const cursorLabel = new Gtk.Label({
            label: _('Enable cursor tracking'),
            hexpand: true,
            xalign: 0
        });
        const cursorSwitch = new Gtk.Switch({
            active: window._settings.get_boolean('cursor-tracking-enabled'),
            valign: Gtk.Align.CENTER
        });
        cursorSwitch.connect('notify::active', () => {
            window._settings.set_boolean('cursor-tracking-enabled', cursorSwitch.get_active());
        });
        cursorBox.append(cursorLabel);
        cursorBox.append(cursorSwitch);
        cursorRow.set_child(cursorBox);
        generalGroup.add(cursorRow);

        const intervalRow = new Adw.PreferencesRow({ activatable: false });
        const intervalBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            margin_start: 12,
            margin_end: 12,
            margin_top: 8,
            margin_bottom: 8
        });
        const intervalLabel = new Gtk.Label({
            label: _('Cursor check interval (ms)'),
            hexpand: true,
            xalign: 0
        });
        const intervalSpin = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 50,
                upper: 2000,
                step_increment: 10,
                page_increment: 100,
                value: window._settings.get_int('cursor-poll-interval')
            }),
            valign: Gtk.Align.CENTER
        });
        intervalSpin.connect('value-changed', () => {
            window._settings.set_int('cursor-poll-interval', intervalSpin.get_value_as_int());
        });
        intervalBox.append(intervalLabel);
        intervalBox.append(intervalSpin);
        intervalRow.set_child(intervalBox);
        generalGroup.add(intervalRow);

        const focusRow = new Adw.PreferencesRow({ activatable: false });
        const focusBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            margin_start: 12,
            margin_end: 12,
            margin_top: 8,
            margin_bottom: 8
        });
        const focusLabel = new Gtk.Label({
            label: _('Enable focus detection'),
            hexpand: true,
            xalign: 0
        });
        const focusSwitch = new Gtk.Switch({
            active: window._settings.get_boolean('focus-detection-enabled'),
            valign: Gtk.Align.CENTER
        });
        focusSwitch.connect('notify::active', () => {
            window._settings.set_boolean('focus-detection-enabled', focusSwitch.get_active());
        });
        focusBox.append(focusLabel);
        focusBox.append(focusSwitch);
        focusRow.set_child(focusBox);
        generalGroup.add(focusRow);

        const overviewRow = new Adw.PreferencesRow({ activatable: false });
        const overviewBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            margin_start: 12,
            margin_end: 12,
            margin_top: 8,
            margin_bottom: 8
        });
        const overviewLabels = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true
        });
        overviewLabels.append(new Gtk.Label({
            label: _('Use global speed in the Overview'),
            xalign: 0
        }));
        overviewLabels.append(new Gtk.Label({
            label: _('While the Activities overview or app grid is open, scroll and swipe at the global speed instead of the focused app\'s.'),
            xalign: 0,
            wrap: true,
            css_classes: ['dim-label', 'caption']
        }));
        const overviewSwitch = new Gtk.Switch({
            active: window._settings.get_boolean('overview-global-factor'),
            valign: Gtk.Align.CENTER
        });
        overviewSwitch.connect('notify::active', () => {
            window._settings.set_boolean('overview-global-factor', overviewSwitch.get_active());
        });
        overviewBox.append(overviewLabels);
        overviewBox.append(overviewSwitch);
        overviewRow.set_child(overviewBox);
        generalGroup.add(overviewRow);

        // Debugging information group
        const debugGroup = new Adw.PreferencesGroup({
            title: _('Debugging Information'),
            description: _('Diagnostics for checking which speed is applied.')
        });

        const panelRow = new Adw.PreferencesRow({ activatable: false });
        const panelBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            margin_start: 12,
            margin_end: 12,
            margin_top: 8,
            margin_bottom: 8
        });
        const panelLabel = new Gtk.Label({
            label: _('Panel indicator'),
            hexpand: true,
            xalign: 0
        });
        const panelSwitch = new Gtk.Switch({
            active: window._settings.get_boolean('show-panel-indicator'),
            valign: Gtk.Align.CENTER
        });
        panelSwitch.connect('notify::active', () => {
            window._settings.set_boolean('show-panel-indicator', panelSwitch.get_active());
        });
        panelBox.append(panelLabel);
        panelBox.append(panelSwitch);
        panelRow.set_child(panelBox);
        debugGroup.add(panelRow);

        const debugLogRow = new Adw.PreferencesRow({ activatable: false });
        const debugLogBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            margin_start: 12,
            margin_end: 12,
            margin_top: 8,
            margin_bottom: 8
        });
        const debugLogLabels = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            hexpand: true
        });
        debugLogLabels.append(new Gtk.Label({
            label: _('Debug logging'),
            xalign: 0
        }));
        debugLogLabels.append(new Gtk.Label({
            label: _('Log detected apps and applied speeds. View with: journalctl -f -o cat | grep TouchpadSpeed'),
            xalign: 0,
            wrap: true,
            selectable: true,
            css_classes: ['dim-label', 'caption']
        }));
        const debugLogSwitch = new Gtk.Switch({
            active: window._settings.get_boolean('debug-logging'),
            valign: Gtk.Align.CENTER
        });
        debugLogSwitch.connect('notify::active', () => {
            window._settings.set_boolean('debug-logging', debugLogSwitch.get_active());
        });
        debugLogBox.append(debugLogLabels);
        debugLogBox.append(debugLogSwitch);
        debugLogRow.set_child(debugLogBox);
        debugGroup.add(debugLogRow);

        // Import/Export: add buttons at the bottom of the General group
        const ioBox = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 6,
            margin_top: 10,
            margin_bottom: 10
        });

        const ioDesc = new Gtk.Label({
            label: _('Backup or restore all scroll factor settings as a JSON file.'),
            css_classes: ['dim-label'],
            xalign: 0.5,
            wrap: true,
            max_width_chars: 40
        });
        ioBox.append(ioDesc);

        const ioBtnBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
            halign: Gtk.Align.CENTER
        });

        const exportBtn = new Gtk.Button({
            label: _('Export Settings'),
            css_classes: ['flat']
        });
        exportBtn.connect('clicked', () => settingsUI._exportSettings());
        ioBtnBox.append(exportBtn);

        const importBtn = new Gtk.Button({
            label: _('Import Settings'),
            css_classes: ['flat']
        });
        importBtn.connect('clicked', () => settingsUI._importSettings());
        ioBtnBox.append(importBtn);

        ioBox.append(ioBtnBox);

        const ioRow = new Adw.PreferencesRow({ activatable: false });
        ioRow.set_child(ioBox);
        generalGroup.add(ioRow);

        // General tab uses an Adw.PreferencesPage to properly render group headings
        const generalPage = new Adw.PreferencesPage();
        generalPage.add(generalGroup);
        debugGroup.margin_top = 12;
        generalPage.add(debugGroup);

        // Vertical tab content
        const vGroup = new Adw.PreferencesGroup({
            title: _('Vertical Scroll'),
            description: _('Per-application vertical scroll factor control.')
        });
        vGroup.add(settingsUI.createFactorRow('v'));
        vGroup.add(settingsUI.vActionBox);
        vGroup.add(settingsUI.vRulesBox);
        vGroup.add(settingsUI.vSearchEntry);
        vGroup.add(settingsUI.vAppList);

        // Horizontal tab content
        const hGroup = new Adw.PreferencesGroup({
            title: _('Horizontal Scroll'),
            description: _('Per-application horizontal scroll factor control.')
        });
        hGroup.add(settingsUI.createFactorRow('h'));
        hGroup.add(settingsUI.hActionBox);
        hGroup.add(settingsUI.hRulesBox);
        hGroup.add(settingsUI.hSearchEntry);
        hGroup.add(settingsUI.hAppList);

        // Gtk.Stack for tab switching
        const stack = new Gtk.Stack({
            transition_type: Gtk.StackTransitionType.SLIDE_LEFT_RIGHT,
            hhomogeneous: false
        });

        stack.add_titled(generalPage, 'general', _('General'));
        stack.add_titled(vGroup, 'vertical', _('Vertical'));
        stack.add_titled(hGroup, 'horizontal', _('Horizontal'));

        // Tab switcher widget
        const stackSwitcher = new Gtk.StackSwitcher({
            stack: stack,
            halign: Gtk.Align.CENTER,
            margin_top: 10,
            margin_bottom: 10
        });

        // Container group holds both the switcher and the stack
        const containerGroup = new Adw.PreferencesGroup();
        containerGroup.add(stackSwitcher);
        containerGroup.add(stack);

        page.add(containerGroup);
        window.add(page);

        // Scan and populate the app list (shared between both tabs)
        settingsUI.loadApps();
    }
}

/**
 * Settings
 *
 * Manages the preferences UI: app discovery, factor sliders, search, reset, and sync.
 *
 * Key design decisions:
 *   - _suppressSave flag prevents cascading GSettings writes when programmatically
 *     updating slider values (e.g., during sync or reset operations)
 *   - renderAppListWithFactors() passes factor data to createAppRow()
 *     directly instead of re-reading from GSettings, avoiding cache staleness issues
 *   - loadApps() reads the installed apps once (via Gio.AppInfo) and shares the result between both tabs
 *   - Debounced saves (200ms) prevent excessive D-Bus traffic during slider dragging
 */
class Settings {
    /**
     * @param {Gio.Settings} schema - The GSettings instance for this extension.
     */
    constructor(schema) {
        this.schema = schema;
        this.apps = [];
        this.vFilteredApps = [];
        this.hFilteredApps = [];
        // Prevents value-changed handlers from triggering GSettings writes
        // during programmatic slider updates (sync, reset, global slider changes)
        this._suppressSave = false;

        // Vertical search entry
        this.vSearchEntry = new Gtk.SearchEntry({
            placeholder_text: _('Search applications...'),
            hexpand: true,
            margin_top: 10,
            margin_bottom: 10,
            margin_start: 10,
            margin_end: 10
        });

        // Vertical app list (scrolled window containing a list box)
        this.vAppList = new Gtk.ScrolledWindow({
            vexpand: true,
            hexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            min_content_height: 400
        });

        this.vListBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list']
        });

        this.vAppList.set_child(this.vListBox);

        // Vertical action box (reset + sync buttons)
        this.vActionBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
            margin_top: 10,
            margin_bottom: 10,
            margin_start: 10,
            margin_end: 10,
            halign: Gtk.Align.END
        });

        const vResetButton = new Gtk.Button({
            label: _('Reset to Defaults'),
            css_classes: ['flat']
        });
        vResetButton.connect('clicked', () => this.resetVToDefaults());
        this.vActionBox.append(vResetButton);

        const vSyncButton = new Gtk.Button({
            label: _('Sync to Horizontal'),
            css_classes: ['flat']
        });
        vSyncButton.connect('clicked', () => this.syncVToH());
        this.vActionBox.append(vSyncButton);

        // Horizontal search entry
        this.hSearchEntry = new Gtk.SearchEntry({
            placeholder_text: _('Search applications...'),
            hexpand: true,
            margin_top: 10,
            margin_bottom: 10,
            margin_start: 10,
            margin_end: 10
        });

        // Horizontal app list
        this.hAppList = new Gtk.ScrolledWindow({
            vexpand: true,
            hexpand: true,
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            min_content_height: 400
        });

        this.hListBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list']
        });

        this.hAppList.set_child(this.hListBox);

        // Horizontal action box
        this.hActionBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 10,
            margin_top: 10,
            margin_bottom: 10,
            margin_start: 10,
            margin_end: 10,
            halign: Gtk.Align.END
        });

        const hResetButton = new Gtk.Button({
            label: _('Reset to Defaults'),
            css_classes: ['flat']
        });
        hResetButton.connect('clicked', () => this.resetHToDefaults());
        this.hActionBox.append(hResetButton);

        const hSyncButton = new Gtk.Button({
            label: _('Sync to Vertical'),
            css_classes: ['flat']
        });
        hSyncButton.connect('clicked', () => this.syncHToV());
        this.hActionBox.append(hSyncButton);

        // Wildcard rules (e.g. brave-*) for each axis
        this.vRulesBox = this._createRulesBox('v');
        this.hRulesBox = this._createRulesBox('h');

        // Search handlers — filter and re-render on text change
        this.vSearchEntry.connect('search-changed', () => {
            this.filterApps('v');
        });

        this.hSearchEntry.connect('search-changed', () => {
            this.filterApps('h');
        });
    }

    /**
     * Creates a global factor slider row for the given axis.
     *
     * The global factor slider controls the default fallback value for all apps
     * that don't have a per-app override. Changing it updates all per-app factors
     * to match (after a 200ms debounce).
     *
     * @param {string} axis - 'v' for vertical, 'h' for horizontal.
     * @returns {Adw.PreferencesRow} The constructed preferences row.
     */
    createFactorRow(axis) {
        const row = new Adw.PreferencesRow({
            activatable: false
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            margin_start: 12,
            margin_end: 12,
            margin_top: 8,
            margin_bottom: 8
        });

        // Axis-specific icon: down arrow for vertical, right arrow for horizontal
        const icon = new Gtk.Image({
            icon_name: axis === 'v' ? 'go-down-symbolic' : 'go-next-symbolic',
            pixel_size: 32
        });

        const label = new Gtk.Label({
            label: axis === 'v' ? _('Global vertical factor') : _('Global horizontal factor'),
            xalign: 0,
            width_chars: 18,
            max_width_chars: 18,
            ellipsize: Pango.EllipsizeMode.END,
            css_classes: ['heading']
        });

        const globalFactorKey = axis === 'v' ? 'global-factor' : 'h-global-factor';
        const currentFactor = this.schema.get_double(globalFactorKey);

        const valueLabel = new Gtk.Label({
            label: currentFactor.toFixed(2),
            width_chars: 5,
            xalign: 1,
            css_classes: ['dim-label']
        });

        // Store references for programmatic updates during sync/reset
        if (axis === 'v') {
            this.vFactorLabel = valueLabel;
        } else {
            this.hFactorLabel = valueLabel;
        }

        const adjustment = new Gtk.Adjustment({
            lower: 0.05,
            upper: 2.00,
            step_increment: 0.01,
            page_increment: 0.1,
            value: currentFactor
        });

        if (axis === 'v') {
            this.vFactorAdjustment = adjustment;
        } else {
            this.hFactorAdjustment = adjustment;
        }

        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: adjustment,
            hexpand: true,
            width_request: 180,
            draw_value: false,
            digits: 2
        });

        // Visual marks at common factor values
        scale.add_mark(0.15, Gtk.PositionType.BOTTOM, null);
        scale.add_mark(0.35, Gtk.PositionType.BOTTOM, null);
        scale.add_mark(0.50, Gtk.PositionType.BOTTOM, null);
        scale.add_mark(1.00, Gtk.PositionType.BOTTOM, null);

        // Debounced save: updates global factor and all per-app factors
        let saveTimeout = null;
        adjustment.connect('value-changed', () => {
            if (this._suppressSave) {
                if (saveTimeout) {
                    GLib.source_remove(saveTimeout);
                    saveTimeout = null;
                }
                return;
            }
            const newValue = adjustment.get_value();
            valueLabel.set_label(newValue.toFixed(2));
            if (saveTimeout) GLib.source_remove(saveTimeout);
            saveTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this.updateAllFactors(axis, newValue);
                saveTimeout = null;
                return GLib.SOURCE_REMOVE;
            });
        });

        // Minus button (decrease by 0.01)
        const minusBtn = new Gtk.Button({
            label: '−',
            css_classes: ['circular', 'flat'],
            width_request: 32,
            height_request: 32
        });
        minusBtn.connect('clicked', () => {
            const currentValue = adjustment.get_value();
            const newValue = Math.max(0.05, currentValue - 0.01);
            adjustment.set_value(newValue);
        });

        // Plus button (increase by 0.01)
        const plusBtn = new Gtk.Button({
            label: '+',
            css_classes: ['circular', 'flat'],
            width_request: 32,
            height_request: 32
        });
        plusBtn.connect('clicked', () => {
            const currentValue = adjustment.get_value();
            const newValue = Math.min(2.00, currentValue + 0.01);
            adjustment.set_value(newValue);
        });

        box.append(icon);
        box.append(label);
        box.append(scale);
        box.append(minusBtn);
        box.append(valueLabel);
        box.append(plusBtn);

        row.set_child(box);
        return row;
    }

    /**
     * Discovers installed applications through GIO (the same list GNOME uses)
     * and populates this.apps with app metadata.
     *
     * Filtering rules:
     *   - Skips apps GNOME would not show (NoDisplay, Hidden, OnlyShowIn/NotShowIn)
     *   - Skips URL handler variants (e.g. code-url-handler) when the base app exists
     *
     * Sorting: known apps (Chrome, Firefox, VS Code, etc.) are prioritized to the top,
     * then alphabetically within each group.
     */
    loadApps() {
        // Common apps to prioritize at the top of the list
        const knownApps = [
            'chrome', 'google-chrome-stable', 'google-chrome-unstable',
            'google-chrome-beta', 'google-chrome-dev', 'com.google.Chrome',
            'com.google.Chrome.unstable', 'firefox', 'firefox-developer',
            'firefox-nightly', 'code', 'code-url-handler', 'org.gnome.Terminal',
            'telegram-desktop', 'discord', 'slack', 'org.gnome.Nautilus',
            'org.gnome.TextEditor', 'org.gnome.gedit', 'okular',
            'org.gnome.Evince', 'com.github.johnfactotum.Foliate'
        ];

        const appMap = new Map();

        for (const info of Gio.AppInfo.get_all()) {
            if (!info.should_show()) continue;

            const appId = normalizeAppId(info.get_id() || '');
            if (!appId || appMap.has(appId)) continue;

            appMap.set(appId, {
                id: appId,
                name: info.get_display_name(),
                gicon: info.get_icon(),
                icon: 'application-x-executable',
                exec: info.get_commandline() || ''
            });
        }

        // Skip URL handler variants if the base app exists. Done after
        // collecting everything so the result does not depend on scan order.
        for (const [appId, app] of [...appMap]) {
            if (!/ %[uU]\b/.test(app.exec)) continue;
            const baseAppId = appId.replace('-url-handler', '').replace('-default', '');
            if (baseAppId !== appId && appMap.has(baseAppId)) {
                appMap.delete(appId);
            }
        }

        this.apps = Array.from(appMap.values());
        this.apps.sort((a, b) => a.name.localeCompare(b.name));

        // Prioritize known apps to the top
        const knownAppsSet = new Set(knownApps);
        this.apps.sort((a, b) => {
            const aKnown = knownAppsSet.has(a.id) ? 0 : 1;
            const bKnown = knownAppsSet.has(b.id) ? 0 : 1;
            return aKnown - bKnown || a.name.localeCompare(b.name);
        });

        this.filterApps('v');
        this.filterApps('h');
    }

    /**
     * Filters the app list based on search text for the given axis.
     * Searches both app name and app ID.
     *
     * @param {string} axis - 'v' for vertical, 'h' for horizontal.
     */
    filterApps(axis) {
        const searchText = axis === 'v'
            ? this.vSearchEntry.get_text().toLowerCase()
            : this.hSearchEntry.get_text().toLowerCase();

        const filtered = this.apps.filter(app =>
            app.name.toLowerCase().includes(searchText) ||
            app.id.toLowerCase().includes(searchText)
        );

        if (axis === 'v') {
            this.vFilteredApps = filtered;
            this.renderAppList('v');
        } else {
            this.hFilteredApps = filtered;
            this.renderAppList('h');
        }
    }

    /**
     * Renders the per-app factor slider list for the given axis.
     * Reads factors from GSettings and creates a row for each filtered app.
     *
     * @param {string} axis - 'v' for vertical, 'h' for horizontal.
     */
    renderAppList(axis) {
        this._renderAppRows(axis);
        this.renderRuleList(axis);
    }

    /**
     * Renders only the per-app rows (not the rules) for the given axis.
     *
     * @param {string} axis - 'v' for vertical, 'h' for horizontal.
     */
    _renderAppRows(axis) {
        const listBox = axis === 'v' ? this.vListBox : this.hListBox;

        while (listBox.get_first_child()) {
            listBox.remove(listBox.get_first_child());
        }

        const factorsKey = axis === 'v' ? 'app-factors' : 'h-app-factors';
        const factors = this.schema.get_value(factorsKey).deep_unpack();

        const apps = axis === 'v' ? this.vFilteredApps : this.hFilteredApps;

        for (const app of apps) {
            const row = this.createAppRow(app, factors, axis);
            listBox.append(row);
        }
    }

    /**
     * Creates a per-app factor slider row.
     *
     * @param {Object} app - App metadata { id, name, icon, gicon, exec }.
     * @param {Object} factors - The per-app factors dictionary.
     * @param {string} axis - 'v' for vertical, 'h' for horizontal.
     * @param {function|null} [onRemove] - Adds a remove button (used for rules).
     * @param {number|null} [globalFactor] - Global factor to fall back to; read
     *   from GSettings if null.
     * @returns {Adw.PreferencesRow} The constructed preferences row.
     */
    createAppRow(app, factors, axis, onRemove = null, globalFactor = null) {
        const globalFactorKey = axis === 'v' ? 'global-factor' : 'h-global-factor';
        if (globalFactor === null) globalFactor = this.schema.get_double(globalFactorKey);
        const resolved = resolveFactor(factors, app.id, globalFactor);
        const factor = resolved.factor;

        const row = new Adw.PreferencesRow({
            activatable: false,
            css_classes: ['property-row']
        });

        const box = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 12,
            margin_start: 12,
            margin_end: 12,
            margin_top: 8,
            margin_bottom: 8
        });

        const icon = new Gtk.Image({
            pixel_size: 32
        });
        if (app.gicon) {
            icon.set_from_gicon(app.gicon);
        } else {
            icon.set_from_icon_name(app.icon);
        }

        // Fallback for missing icons
        icon.connect('notify::gicon', () => {
            if (!icon.get_icon_name() && !icon.get_gicon()) {
                icon.set_from_icon_name('application-x-executable');
            }
        });

        const nameLabel = new Gtk.Label({
            label: app.name,
            xalign: 0,
            width_chars: 18,
            max_width_chars: 18,
            ellipsize: Pango.EllipsizeMode.END,
            tooltip_text: app.name,
            css_classes: ['heading']
        });

        const valueLabel = new Gtk.Label({
            label: factor.toFixed(2),
            width_chars: 5,
            xalign: 1,
            css_classes: ['dim-label']
        });
        if (resolved.source === 'pattern' || resolved.source === 'partial') {
            valueLabel.set_tooltip_text(_('Set by') + ' ' + resolved.key);
        }

        const adjustment = new Gtk.Adjustment({
            lower: 0.05,
            upper: 2.00,
            step_increment: 0.01,
            page_increment: 0.1,
            value: factor
        });

        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: adjustment,
            hexpand: true,
            width_request: 180,
            draw_value: false,
            digits: 2
        });

        scale.add_mark(0.15, Gtk.PositionType.BOTTOM, null);
        scale.add_mark(0.35, Gtk.PositionType.BOTTOM, null);
        scale.add_mark(0.50, Gtk.PositionType.BOTTOM, null);
        scale.add_mark(1.00, Gtk.PositionType.BOTTOM, null);

        // Debounced save for per-app factor
        let saveTimeout = null;
        adjustment.connect('value-changed', () => {
            if (this._suppressSave) {
                if (saveTimeout) {
                    GLib.source_remove(saveTimeout);
                    saveTimeout = null;
                }
                return;
            }
            const newValue = adjustment.get_value();
            valueLabel.set_label(newValue.toFixed(2));
            if (saveTimeout) GLib.source_remove(saveTimeout);
            saveTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                this.updateAppFactor(app.id, newValue, axis);
                saveTimeout = null;
                return GLib.SOURCE_REMOVE;
            });
        });

        const minusBtn = new Gtk.Button({
            label: '−',
            css_classes: ['circular', 'flat'],
            width_request: 32,
            height_request: 32
        });
        minusBtn.connect('clicked', () => {
            const currentValue = adjustment.get_value();
            const newValue = Math.max(0.05, currentValue - 0.01);
            adjustment.set_value(newValue);
        });

        const plusBtn = new Gtk.Button({
            label: '+',
            css_classes: ['circular', 'flat'],
            width_request: 32,
            height_request: 32
        });
        plusBtn.connect('clicked', () => {
            const currentValue = adjustment.get_value();
            const newValue = Math.min(2.00, currentValue + 0.01);
            adjustment.set_value(newValue);
        });

        box.append(icon);
        box.append(nameLabel);
        box.append(scale);
        box.append(minusBtn);
        box.append(valueLabel);
        box.append(plusBtn);

        if (onRemove) {
            const removeBtn = new Gtk.Button({
                icon_name: 'user-trash-symbolic',
                tooltip_text: _('Remove rule'),
                css_classes: ['circular', 'flat'],
                valign: Gtk.Align.CENTER
            });
            removeBtn.connect('clicked', onRemove);
            box.append(removeBtn);
        }

        row.set_child(box);

        return row;
    }

    /**
     * Updates the global factor and sets ALL per-app factors to the same value.
     *
     * Uses _suppressSave to prevent the global slider's value-changed handler
     * from triggering another updateAllFactors call (which would cause an infinite loop).
     *
     * @param {string} axis - 'v' for vertical, 'h' for horizontal.
     * @param {number} factor - The new factor value.
     */
    updateAllFactors(axis, factor) {
        this._suppressSave = true;

        const factorsKey = axis === 'v' ? 'app-factors' : 'h-app-factors';
        const globalFactorKey = axis === 'v' ? 'global-factor' : 'h-global-factor';

        this.schema.set_double(globalFactorKey, factor);

        const factors = this.schema.get_value(factorsKey).deep_unpack();
        for (const appId of Object.keys(factors)) {
            factors[appId] = factor;
        }
        const variant = new GLib.Variant('a{sd}', factors);
        this.schema.set_value(factorsKey, variant);

        this.renderAppList(axis);

        if (axis === 'v') {
            this.vFactorLabel.set_label(factor.toFixed(2));
            this.vFactorAdjustment.set_value(factor);
        } else {
            this.hFactorLabel.set_label(factor.toFixed(2));
            this.hFactorAdjustment.set_value(factor);
        }

        this._suppressSave = false;
    }

    /**
     * Updates a single per-app factor in GSettings.
     *
     * @param {string} appId - The application ID.
     * @param {number} factor - The new factor value.
     * @param {string} axis - 'v' for vertical, 'h' for horizontal.
     */
    updateAppFactor(appId, factor, axis) {
        const factorsKey = axis === 'v' ? 'app-factors' : 'h-app-factors';

        const factors = this.schema.get_value(factorsKey).deep_unpack();
        factors[appId] = factor;

        const variant = new GLib.Variant('a{sd}', factors);
        this.schema.set_value(factorsKey, variant);

        // A rule can change the effective value of many app rows
        if (isPattern(appId)) {
            this._renderAppRows(axis);
        }
    }

    /**
     * Builds the wildcard rules section for one axis: a short explanation,
     * the list of rules, and an entry for adding a new rule.
     *
     * @param {string} axis - 'v' for vertical, 'h' for horizontal.
     * @returns {Gtk.Box} The rules section.
     */
    _createRulesBox(axis) {
        const box = new Gtk.Box({
            orientation: Gtk.Orientation.VERTICAL,
            spacing: 8,
            margin_top: 4,
            margin_bottom: 4,
            margin_start: 10,
            margin_end: 10
        });

        box.append(new Gtk.Label({
            label: _('Rules'),
            xalign: 0,
            css_classes: ['heading']
        }));
        box.append(new Gtk.Label({
            label: _('Give every app whose ID matches a rule the same speed, including apps installed later. ' +
                '* matches anything, ? one character. Example: brave-* for all Brave web apps. ' +
                'A speed set for a single app below takes priority.'),
            xalign: 0,
            wrap: true,
            css_classes: ['dim-label']
        }));

        const ruleListBox = new Gtk.ListBox({
            selection_mode: Gtk.SelectionMode.NONE,
            css_classes: ['boxed-list'],
            visible: false
        });
        box.append(ruleListBox);

        const addBox = new Gtk.Box({
            orientation: Gtk.Orientation.HORIZONTAL,
            spacing: 8
        });
        const entry = new Gtk.Entry({
            placeholder_text: 'brave-*',
            hexpand: true
        });
        const addBtn = new Gtk.Button({
            label: _('Add Rule'),
            css_classes: ['suggested-action']
        });
        const add = () => {
            if (this.addRule(axis, entry.get_text())) entry.set_text('');
        };
        addBtn.connect('clicked', add);
        entry.connect('activate', add);
        addBox.append(entry);
        addBox.append(addBtn);
        box.append(addBox);

        if (axis === 'v') {
            this.vRuleListBox = ruleListBox;
        } else {
            this.hRuleListBox = ruleListBox;
        }
        return box;
    }

    /**
     * Renders the wildcard rules for the given axis.
     *
     * @param {string} axis - 'v' for vertical, 'h' for horizontal.
     * @param {Object} [factors] - Factors to show; read from GSettings if omitted.
     */
    renderRuleList(axis, factors = null) {
        const listBox = axis === 'v' ? this.vRuleListBox : this.hRuleListBox;
        if (!listBox) return;

        while (listBox.get_first_child()) {
            listBox.remove(listBox.get_first_child());
        }

        const factorsKey = axis === 'v' ? 'app-factors' : 'h-app-factors';
        if (!factors) factors = this.schema.get_value(factorsKey).deep_unpack();

        const rules = Object.keys(factors).filter(isPattern).sort();
        for (const rule of rules) {
            const pseudoApp = { id: rule, name: rule, icon: 'edit-find-symbolic', exec: '' };
            listBox.append(this.createAppRow(pseudoApp, factors, axis, () => this.removeRule(axis, rule)));
        }
        listBox.set_visible(rules.length > 0);
    }

    /**
     * Adds a wildcard rule for the given axis, starting at the current global factor.
     *
     * @param {string} axis - 'v' for vertical, 'h' for horizontal.
     * @param {string} rule - The rule text, e.g. 'brave-*'.
     * @returns {boolean} True if the rule was added.
     */
    addRule(axis, rule) {
        const error = validatePattern(rule);
        if (error) {
            this._showToast(_(error));
            return false;
        }

        const factorsKey = axis === 'v' ? 'app-factors' : 'h-app-factors';
        const globalFactorKey = axis === 'v' ? 'global-factor' : 'h-global-factor';
        const factors = this.schema.get_value(factorsKey).deep_unpack();
        if (Object.prototype.hasOwnProperty.call(factors, rule)) {
            this._showToast(_('That rule already exists'));
            return false;
        }

        this.updateAppFactor(rule, this.schema.get_double(globalFactorKey), axis);
        this.renderRuleList(axis);
        this._showToast(_('Rule added'));
        return true;
    }

    /**
     * Removes a wildcard rule for the given axis.
     *
     * @param {string} axis - 'v' for vertical, 'h' for horizontal.
     * @param {string} rule - The rule to remove.
     */
    removeRule(axis, rule) {
        const factorsKey = axis === 'v' ? 'app-factors' : 'h-app-factors';
        const factors = this.schema.get_value(factorsKey).deep_unpack();
        delete factors[rule];
        this.schema.set_value(factorsKey, new GLib.Variant('a{sd}', factors));
        this.renderAppList(axis);
        this._showToast(_('Rule removed'));
    }

    /**
     * Resets all vertical factors to defaults (global = 1.0, all apps = 1.0).
     */
    resetVToDefaults() {
        this._suppressSave = true;

        this.schema.set_double('global-factor', 1.0);

        const factors = this.schema.get_value('app-factors').deep_unpack();
        for (const appId of Object.keys(factors)) {
            factors[appId] = 1.0;
        }
        const variant = new GLib.Variant('a{sd}', factors);
        this.schema.set_value('app-factors', variant);

        this.renderAppList('v');

        if (this.vFactorLabel) {
            this.vFactorLabel.set_label('1.00');
        }
        if (this.vFactorAdjustment) {
            this.vFactorAdjustment.set_value(1.0);
        }

        this._suppressSave = false;

        const toast = new Adw.Toast({
            title: _('Vertical reset to defaults'),
            timeout: 2
        });
        this._window.add_toast(toast);
    }

    /**
     * Resets all horizontal factors to defaults (global = 1.0, all apps = 1.0).
     */
    resetHToDefaults() {
        this._suppressSave = true;

        this.schema.set_double('h-global-factor', 1.0);

        const factors = this.schema.get_value('h-app-factors').deep_unpack();
        for (const appId of Object.keys(factors)) {
            factors[appId] = 1.0;
        }
        const variant = new GLib.Variant('a{sd}', factors);
        this.schema.set_value('h-app-factors', variant);

        this.renderAppList('h');

        if (this.hFactorLabel) {
            this.hFactorLabel.set_label('1.00');
        }
        if (this.hFactorAdjustment) {
            this.hFactorAdjustment.set_value(1.0);
        }

        this._suppressSave = false;

        const toast = new Adw.Toast({
            title: _('Horizontal reset to defaults'),
            timeout: 2
        });
        this._window.add_toast(toast);
    }

    /**
     * Syncs all vertical factors to horizontal.
     *
     * Copies app-factors and global-factor from vertical to horizontal.
     * Uses renderAppListWithFactors() with direct data to avoid GSettings cache staleness.
     * Uses _suppressSave to prevent the horizontal slider's value-changed handler
     * from overwriting the synced per-app values.
     */
    syncVToH() {
        this._suppressSave = true;

        const vFactors = this.schema.get_value('app-factors').deep_unpack();
        const vGlobal = this.schema.get_double('global-factor');

        const variant = new GLib.Variant('a{sd}', vFactors);
        this.schema.set_value('h-app-factors', variant);
        this.schema.set_double('h-global-factor', vGlobal);

        this.hFilteredApps = this.apps.slice();
        this.renderAppListWithFactors('h', vFactors, vGlobal);

        if (this.hFactorLabel) {
            this.hFactorLabel.set_label(vGlobal.toFixed(2));
        }
        if (this.hFactorAdjustment) {
            this.hFactorAdjustment.set_value(vGlobal);
        }

        this._suppressSave = false;

        const toast = new Adw.Toast({
            title: _('Synced vertical to horizontal'),
            timeout: 2
        });
        this._window.add_toast(toast);
    }

    /**
     * Syncs all horizontal factors to vertical.
     *
     * Copies h-app-factors and h-global-factor from horizontal to vertical.
     * Uses the same direct-data rendering approach as syncVToH().
     */
    syncHToV() {
        this._suppressSave = true;

        const hFactors = this.schema.get_value('h-app-factors').deep_unpack();
        const hGlobal = this.schema.get_double('h-global-factor');

        const variant = new GLib.Variant('a{sd}', hFactors);
        this.schema.set_value('app-factors', variant);
        this.schema.set_double('global-factor', hGlobal);

        this.vFilteredApps = this.apps.slice();
        this.renderAppListWithFactors('v', hFactors, hGlobal);

        if (this.vFactorLabel) {
            this.vFactorLabel.set_label(hGlobal.toFixed(2));
        }
        if (this.vFactorAdjustment) {
            this.vFactorAdjustment.set_value(hGlobal);
        }

        this._suppressSave = false;

        const toast = new Adw.Toast({
            title: _('Synced horizontal to vertical'),
            timeout: 2
        });
        this._window.add_toast(toast);
    }

    /**
     * Renders the app list using pre-resolved factor data.
     *
     * This method is used during sync operations to avoid re-reading from GSettings,
     * which may return stale data due to caching. The factors dictionary and global
     * factor are passed directly from the source axis.
     *
     * @param {string} axis - 'v' for vertical, 'h' for horizontal.
     * @param {Object} factors - The source per-app factors dictionary.
     * @param {number} globalFactor - The source global factor value.
     */
    renderAppListWithFactors(axis, factors, globalFactor) {
        const listBox = axis === 'v' ? this.vListBox : this.hListBox;

        while (listBox.get_first_child()) {
            listBox.remove(listBox.get_first_child());
        }

        const apps = axis === 'v' ? this.vFilteredApps : this.hFilteredApps;

        for (const app of apps) {
            const row = this.createAppRow(app, factors, axis, null, globalFactor);
            listBox.append(row);
        }
        this.renderRuleList(axis, factors);
    }

    /**
     * Opens a save dialog and exports all settings to a JSON file.
     * Uses Gtk.FileDialog (GTK 4.10+, available on GNOME 45+).
     */
    _exportSettings() {
        const dialog = new Gtk.FileDialog();
        dialog.set_title(_('Export Settings'));
        dialog.set_initial_name('touchpad-speed-control-settings.json');

        const filter = new Gtk.FileFilter();
        filter.set_name(_('JSON Files'));
        filter.add_pattern('*.json');
        dialog.set_default_filter(filter);

        const data = {
            version: 1,
            vertical: {
                global_factor: this.schema.get_double('global-factor'),
                app_factors: this.schema.get_value('app-factors').deep_unpack()
            },
            horizontal: {
                global_factor: this.schema.get_double('h-global-factor'),
                app_factors: this.schema.get_value('h-app-factors').deep_unpack()
            }
        };

        const json = JSON.stringify(data, null, 2);
        const encoder = new TextEncoder();
        const uint8array = encoder.encode(json);
        const bytes = new GLib.Bytes(uint8array);

        dialog.save(this._window, null, (self, result) => {
            try {
                const file = self.save_finish(result);
                file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.NONE, null, (file, result) => {
                    try {
                        file.replace_contents_finish(result);
                        this._showToast(_('Settings exported'));
                    } catch (e) {
                        this._showToast(_('Failed to export settings'));
                    }
                });
            } catch (e) {
                // User cancelled — ignore
            }
        });
    }

    /**
     * Opens a file dialog and imports settings from a JSON file.
     * Overwrites all current settings. Validates file format before applying.
     */
    _importSettings() {
        const dialog = new Gtk.FileDialog();
        dialog.set_title(_('Import Settings'));

        const filter = new Gtk.FileFilter();
        filter.set_name(_('JSON Files'));
        filter.add_pattern('*.json');
        dialog.set_default_filter(filter);

        dialog.open(this._window, null, (self, result) => {
            try {
                const file = self.open_finish(result);
                file.load_contents_async(null, (file, result) => {
                    try {
                        const [success, contents] = file.load_contents_finish(result);
                        if (!success || !contents) {
                            this._showToast(_('Could not read file'));
                            return;
                        }

                        const decoder = new TextDecoder();
                        const text = decoder.decode(contents);
                        let data;
                        try {
                            data = JSON.parse(text);
                        } catch (e) {
                            this._showToast(_('Invalid JSON file'));
                            return;
                        }

                        if (!data || data.version !== 1 || !data.vertical || !data.horizontal) {
                            this._showToast(_('Invalid file format'));
                            return;
                        }

                        this._suppressSave = true;

                        if (typeof data.vertical.global_factor === 'number') {
                            this.schema.set_double('global-factor', data.vertical.global_factor);
                        }
                        if (data.vertical.app_factors && typeof data.vertical.app_factors === 'object') {
                            const installedAppIds = new Set(this.apps.map(a => a.id));
                            const filtered = {};
                            for (const [appId, factor] of Object.entries(data.vertical.app_factors)) {
                                if (installedAppIds.has(appId) || isPattern(appId)) {
                                    filtered[appId] = factor;
                                }
                            }
                            const vVariant = new GLib.Variant('a{sd}', filtered);
                            this.schema.set_value('app-factors', vVariant);
                        }

                        if (typeof data.horizontal.global_factor === 'number') {
                            this.schema.set_double('h-global-factor', data.horizontal.global_factor);
                        }
                        if (data.horizontal.app_factors && typeof data.horizontal.app_factors === 'object') {
                            const installedAppIds = new Set(this.apps.map(a => a.id));
                            const filtered = {};
                            for (const [appId, factor] of Object.entries(data.horizontal.app_factors)) {
                                if (installedAppIds.has(appId) || isPattern(appId)) {
                                    filtered[appId] = factor;
                                }
                            }
                            const hVariant = new GLib.Variant('a{sd}', filtered);
                            this.schema.set_value('h-app-factors', hVariant);
                        }

                        this.refreshAppList();

                        if (this.vFactorLabel) {
                            this.vFactorLabel.set_label(data.vertical.global_factor.toFixed(2));
                        }
                        if (this.vFactorAdjustment) {
                            this.vFactorAdjustment.set_value(data.vertical.global_factor);
                        }
                        if (this.hFactorLabel) {
                            this.hFactorLabel.set_label(data.horizontal.global_factor.toFixed(2));
                        }
                        if (this.hFactorAdjustment) {
                            this.hFactorAdjustment.set_value(data.horizontal.global_factor);
                        }

                        this._suppressSave = false;

                        this._showToast(_('Settings imported'));
                    } catch (e) {
                        this._showToast(_('Failed to read file'));
                    }
                });
            } catch (e) {
                // User cancelled — ignore
            }
        });
    }

    /**
     * Shows a brief notification toast in the preferences window.
     *
     * @param {string} message - The message to display.
     */
    _showToast(message) {
        const toast = new Adw.Toast({
            title: message,
            timeout: 3
        });
        this._window.add_toast(toast);
    }

    /**
     * Re-filters and re-renders both axis app lists.
     * Useful after external changes to GSettings.
     */
    refreshAppList() {
        this.filterApps('v');
        this.filterApps('h');
    }
}
