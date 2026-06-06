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
//   - Two tabs: Vertical Scroll and Horizontal Scroll (Gtk.Stack + Gtk.StackSwitcher)
//   - Each tab has: global factor slider, per-app sliders, search, reset, and sync buttons
//   - _suppressSave flag prevents cascading GSettings writes during programmatic updates
//   - Direct-data rendering for sync operations bypasses GSettings cache staleness

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import { ExtensionPreferences, gettext as _ } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

/**
 * Locates the WSF CLI binary by searching PATH and common install locations.
 *
 * Search order:
 *   1. $PATH (covers AUR at /usr/bin, system packages, custom paths)
 *   2. ~/.local/bin/wsf (manual builds with --prefix=$HOME/.local)
 *   3. /usr/local/bin/wsf (system-wide manual builds with default prefix)
 *   4. /usr/bin/wsf (AUR/distro packages explicitly)
 *
 * @returns {string|null} The full path to the wsf binary, or null if not found.
 */
function _findWSFPath() {
    const pathFound = GLib.find_program_in_path('wsf');
    if (pathFound) return pathFound;

    const home = GLib.get_home_dir();
    const candidates = [
        home + '/.local/bin/wsf',
        '/usr/local/bin/wsf',
        '/usr/bin/wsf',
    ];
    for (const p of candidates) {
        if (Gio.File.new_for_path(p).query_exists(null)) return p;
    }
    return null;
}

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
        const wsfPath = _findWSFPath();
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

            if (!stdout) return { installed: true, active: false };

            const lines = stdout.split('\n');
            let enabled = false;
            let libraryMapped = false;

            for (const line of lines) {
                if (line.startsWith('enabled: yes')) {
                    enabled = true;
                }
                if (line.startsWith('gnome-shell library mapped: yes')) {
                    libraryMapped = true;
                }
            }

            return { installed: true, active: enabled && libraryMapped };
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
            label: _('Poll interval (ms)'),
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

        // Debugging information group
        const debugGroup = new Adw.PreferencesGroup({
            title: _('Debugging Information'),
            description: _('Show diagnostic information in the top panel.')
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
        vGroup.add(settingsUI.vSearchEntry);
        vGroup.add(settingsUI.vAppList);

        // Horizontal tab content
        const hGroup = new Adw.PreferencesGroup({
            title: _('Horizontal Scroll'),
            description: _('Per-application horizontal scroll factor control.')
        });
        hGroup.add(settingsUI.createFactorRow('h'));
        hGroup.add(settingsUI.hActionBox);
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
 *   - renderAppListWithFactors() and createAppRowWithFactor() accept factor data
 *     directly instead of re-reading from GSettings, avoiding cache staleness issues
 *   - loadApps() scans .desktop files once and shares the result between both tabs
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
            hexpand: true,
            xalign: 0,
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
            upper: 5.00,
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
            const newValue = Math.min(5.00, currentValue + 0.01);
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
     * Scans .desktop files from system and user data directories to discover
     * installed applications. Populates this.apps with app metadata.
     *
     * Filtering rules:
     *   - Skips NoDisplay=true entries (hidden from app menus)
     *   - Skips entries with OnlyShowIn that excludes GNOME
     *   - Skips URL handler variants if a base app already exists
     *
     * Sorting: known apps (Chrome, Firefox, VS Code, etc.) are prioritized to the top,
     * then alphabetically within each group.
     */
    loadApps() {
        const dataDirs = GLib.get_system_data_dirs();
        const userDataDir = GLib.get_user_data_dir();

        const appDirs = [
            userDataDir + '/applications/',
            ...dataDirs.map(dir => dir + '/applications/')
        ];

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

        for (const dirPath of appDirs) {
            const dir = Gio.File.new_for_path(dirPath);
            if (!dir.query_exists(null)) continue;

            try {
                const enumerator = dir.enumerate_children(
                    'standard::*',
                    Gio.FileQueryInfoFlags.NONE,
                    null
                );

                let info;
                while ((info = enumerator.next_file(null)) !== null) {
                    const fileName = info.get_name();
                    if (!fileName.endsWith('.desktop')) continue;

                    const appId = fileName.replace('.desktop', '');
                    if (appMap.has(appId)) continue;

                    const desktopFile = GLib.build_filenamev([dirPath, fileName]);
                    const keyFile = new GLib.KeyFile();

                    try {
                        keyFile.load_from_file(desktopFile, GLib.KeyFileFlags.NONE);

                        // Skip hidden apps
                        try {
                            if (keyFile.get_boolean('Desktop Entry', 'NoDisplay')) continue;
                        } catch (e) {}

                        // Skip non-GNOME apps
                        try {
                            const onlyShowIn = keyFile.get_string('Desktop Entry', 'OnlyShowIn');
                            if (onlyShowIn && !onlyShowIn.includes('GNOME')) continue;
                        } catch (e) {}

                        const name = keyFile.get_string('Desktop Entry', 'Name');
                        let icon = 'application-x-executable';
                        try {
                            icon = keyFile.get_string('Desktop Entry', 'Icon');
                        } catch (e) {}

                        let exec = '';
                        try {
                            exec = keyFile.get_string('Desktop Entry', 'Exec');
                        } catch (e) {}

                        // Skip URL handler variants if base app exists
                        if (exec && (exec.includes(' %u') || exec.includes(' %U'))) {
                            const baseAppId = appId.replace('-url-handler', '').replace('-default', '');
                            if (appMap.has(baseAppId)) continue;
                        }

                        appMap.set(appId, {
                            id: appId,
                            name: name,
                            icon: icon,
                            exec: exec
                        });
                    } catch (e) {
                        continue;
                    }
                }
            } catch (e) {
                continue;
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
     * @param {Object} app - App metadata { id, name, icon, exec }.
     * @param {Object} factors - The per-app factors dictionary from GSettings.
     * @param {string} axis - 'v' for vertical, 'h' for horizontal.
     * @returns {Adw.PreferencesRow} The constructed preferences row.
     */
    createAppRow(app, factors, axis) {
        const globalFactorKey = axis === 'v' ? 'global-factor' : 'h-global-factor';
        const factor = factors[app.id] || this.schema.get_double(globalFactorKey);

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
            icon_name: app.icon,
            pixel_size: 32
        });

        // Fallback for missing icons
        icon.connect('notify::gicon', () => {
            if (!icon.get_icon_name() && !icon.get_gicon()) {
                icon.set_from_icon_name('application-x-executable');
            }
        });

        const nameLabel = new Gtk.Label({
            label: app.name,
            hexpand: true,
            xalign: 0,
            css_classes: ['heading']
        });

        const valueLabel = new Gtk.Label({
            label: factor.toFixed(2),
            width_chars: 5,
            xalign: 1,
            css_classes: ['dim-label']
        });

        const adjustment = new Gtk.Adjustment({
            lower: 0.05,
            upper: 5.00,
            step_increment: 0.01,
            page_increment: 0.1,
            value: factor
        });

        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: adjustment,
            hexpand: true,
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
            const newValue = Math.min(5.00, currentValue + 0.01);
            adjustment.set_value(newValue);
        });

        box.append(icon);
        box.append(nameLabel);
        box.append(scale);
        box.append(minusBtn);
        box.append(valueLabel);
        box.append(plusBtn);

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
            const row = this.createAppRowWithFactor(app, factors, globalFactor, axis);
            listBox.append(row);
        }
    }

    /**
     * Creates a per-app factor slider row using pre-resolved factor data.
     *
     * Identical to createAppRow() but accepts factors and globalFactor directly
     * instead of reading from GSettings. This ensures the rendered values match
     * the source axis exactly during sync operations.
     *
     * @param {Object} app - App metadata { id, name, icon, exec }.
     * @param {Object} factors - The source per-app factors dictionary.
     * @param {number} globalFactor - The source global factor value.
     * @param {string} axis - 'v' for vertical, 'h' for horizontal.
     * @returns {Adw.PreferencesRow} The constructed preferences row.
     */
    createAppRowWithFactor(app, factors, globalFactor, axis) {
        const factor = factors[app.id] || globalFactor;

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
            icon_name: app.icon,
            pixel_size: 32
        });

        icon.connect('notify::gicon', () => {
            if (!icon.get_icon_name() && !icon.get_gicon()) {
                icon.set_from_icon_name('application-x-executable');
            }
        });

        const nameLabel = new Gtk.Label({
            label: app.name,
            hexpand: true,
            xalign: 0,
            css_classes: ['heading']
        });

        const valueLabel = new Gtk.Label({
            label: factor.toFixed(2),
            width_chars: 5,
            xalign: 1,
            css_classes: ['dim-label']
        });

        const adjustment = new Gtk.Adjustment({
            lower: 0.05,
            upper: 5.00,
            step_increment: 0.01,
            page_increment: 0.1,
            value: factor
        });

        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: adjustment,
            hexpand: true,
            draw_value: false,
            digits: 2
        });

        scale.add_mark(0.15, Gtk.PositionType.BOTTOM, null);
        scale.add_mark(0.35, Gtk.PositionType.BOTTOM, null);
        scale.add_mark(0.50, Gtk.PositionType.BOTTOM, null);
        scale.add_mark(1.00, Gtk.PositionType.BOTTOM, null);

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
            const newValue = Math.min(5.00, currentValue + 0.01);
            adjustment.set_value(newValue);
        });

        box.append(icon);
        box.append(nameLabel);
        box.append(scale);
        box.append(minusBtn);
        box.append(valueLabel);
        box.append(plusBtn);

        row.set_child(box);

        return row;
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
                                if (installedAppIds.has(appId)) {
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
                                if (installedAppIds.has(appId)) {
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
