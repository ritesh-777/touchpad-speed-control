// Touchpad Speed Control - Per-application scroll factor control for GNOME on Wayland
// Author: Ritesh Seth
// License: GPL v3
// GitHub: https://github.com/ritesh-777/touchpad-speed-control
//
// This extension provides per-application touchpad scroll speed control on GNOME Wayland.
// It depends on Wayland Scroll Factor (WSF): https://github.com/daniel-g-carrasco/wayland-scroll-factor
//
// Architecture:
//   - Event-driven detection: pointer movement (cursor tracker), focus, restacking, workspace and overview changes
//   - Factor caching: only calls `wsf` when the resolved factors actually differ from the cached values
//   - Serialized WSF updates: one `wsf set` for both axes, never two in flight, latest values win
//   - Battery optimization: no timers run while the pointer is idle
//   - Factor resolution (factorResolver.js): exact ID → wildcard rules (e.g. brave-*) → partial match → global fallback
//   - Calibration (calibration.js, panel menu): measures how far an app scrolls per unit and
//     keeps its factors matched to a chosen reference app, so a swipe moves the same distance

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import { measureWindowGain } from './calibration.js';
import { applyMatchedFactors, horizontalMatchingGains, resolveFactor } from './factorResolver.js';
import { findWSFPath, isWSFActive } from './wsf.js';

// Verbose logging, controlled by the debug-logging setting (General tab)
let debugLogging = false;

/**
 * Logs a message to the journal only when debug logging is enabled.
 * View with: journalctl -f -o cat | grep TouchpadSpeed
 *
 * @param {string} msg - The log message.
 */
function log(msg) {
    if (debugLogging) console.log('[TouchpadSpeed] ' + msg);
}

/**
 * Logs an error to the journal. Errors are always logged so failures are
 * never silent.
 *
 * @param {string} msg - The error message.
 */
function logError(msg) {
    console.error('[TouchpadSpeed] ' + msg);
}

/**
 * TouchpadSpeedControlExtension
 *
 * Main extension class that manages scroll factor detection and application.
 *
 * Lifecycle:
 *   enable()  → Validates WSF, initializes cursor tracking, connects focus handler
 *   disable() → Cleans up all resources, stops cursor tracking, disconnects handlers
 */
export default class TouchpadSpeedControlExtension extends Extension {
    /**
     * Called when the extension is enabled.
     *
     * Flow:
     *   1. Load GSettings (so the debug-logging setting applies immediately)
     *   2. Check if WSF binary exists (searches $PATH and common locations)
     *   3. Check in the background if WSF preload is active (enabled + library mapped)
     *   4. If either check fails, show a notification and stop
     *   5. Otherwise _startTracking(): initialize state, cursor tracking,
     *      focus and window change handlers, then apply the initial factor
     */
    enable() {
        // Load settings first so debug logging applies from the start
        this._settings = this.getSettings();
        debugLogging = this._settings.get_boolean('debug-logging');
        this._debugLoggingHandler = this._settings.connect('changed::debug-logging', () => {
            debugLogging = this._settings.get_boolean('debug-logging');
        });

        log('===== ENABLE CALLED =====');

        // Step 1: Verify WSF binary exists
        this._wsfPath = findWSFPath();
        if (!this._wsfPath) {
            logError('WSF binary not found in PATH or common locations');
            this._showNotification(
                'WSF Not Installed',
                'Touchpad Speed Control requires Wayland Scroll Factor (WSF). Please install it first: https://github.com/daniel-g-carrasco/wayland-scroll-factor'
            );
            return;
        }
        log('WSF found at: ' + this._wsfPath);

        // Step 2: Verify WSF preload is active, without blocking GNOME Shell
        this._wsfCheckCancellable = new Gio.Cancellable();
        this._checkWSFStatus(this._wsfCheckCancellable, active => {
            this._wsfCheckCancellable = null;
            if (!active) {
                logError('WSF preload is not active');
                this._showNotification(
                    'WSF Preload Not Active',
                    'Touchpad Speed Control requires WSF preload to be enabled. Run "wsf enable" and log out/in.'
                );
                return;
            }
            log('WSF preload is active');
            this._startTracking();
        });
    }

    /**
     * Starts app detection once WSF is known to be active (steps 4–12 of enable).
     */
    _startTracking() {
        try {
            // Step 4: Get window tracker for app identification
            this._windowTracker = Shell.WindowTracker.get_default();

            // Step 5: Initialize cursor tracking state
            this._windowUnderCursor = null;
            this._lastPointerX = null;
            this._lastPointerY = null;
            this._cursorTracker = null;
            this._cursorTrackerHandler = null;
            this._cursorCheckSource = null;
            this._forceCursorCheck = false;
            this._lastAppliedVFactor = null;
            this._lastAppliedHFactor = null;
            this._wsfProcess = null;
            this._pendingFactors = null;
            this._windowChangeHandlers = [];
            this._settingsChangedHandlers = [];

            // Step 6: Read configurable settings
            this._cursorTrackingEnabled = this._settings.get_boolean('cursor-tracking-enabled');
            this._cursorPollInterval = this._settings.get_int('cursor-poll-interval');
            this._focusDetectionEnabled = this._settings.get_boolean('focus-detection-enabled');
            this._overviewUsesGlobal = this._settings.get_boolean('overview-global-factor');
            this._showPanelIndicatorEnabled = this._settings.get_boolean('show-panel-indicator');

            // Step 7: Start cursor tracking if enabled
            if (this._cursorTrackingEnabled) {
                this._startCursorTracking();
            }

            // Step 8: Connect focus handler if enabled
            if (this._focusDetectionEnabled) {
                this._connectFocusHandler();
            }

            // Step 9: Show panel indicator if enabled
            if (this._showPanelIndicatorEnabled) {
                this._showPanelIndicator();
            }

            // Step 10: Connect GSettings change handlers for runtime updates
            this._settingsChangedHandlers.push(
                this._settings.connect('changed::cursor-tracking-enabled', () => {
                    this._cursorTrackingEnabled = this._settings.get_boolean('cursor-tracking-enabled');
                    if (this._cursorTrackingEnabled) {
                        this._startCursorTracking();
                    } else {
                        this._stopCursorTracking();
                    }
                })
            );
            this._settingsChangedHandlers.push(
                this._settings.connect('changed::cursor-poll-interval', () => {
                    this._cursorPollInterval = this._settings.get_int('cursor-poll-interval');
                    if (this._cursorTrackingEnabled) {
                        this._stopCursorTracking();
                        this._startCursorTracking();
                    }
                })
            );
            this._settingsChangedHandlers.push(
                this._settings.connect('changed::focus-detection-enabled', () => {
                    this._focusDetectionEnabled = this._settings.get_boolean('focus-detection-enabled');
                    if (this._focusDetectionEnabled) {
                        this._connectFocusHandler();
                    } else {
                        this._disconnectFocusHandler();
                    }
                })
            );
            this._settingsChangedHandlers.push(
                this._settings.connect('changed::show-panel-indicator', () => {
                    this._showPanelIndicatorEnabled = this._settings.get_boolean('show-panel-indicator');
                    if (this._showPanelIndicatorEnabled) {
                        this._showPanelIndicator();
                    } else {
                        this._hidePanelIndicator();
                    }
                })
            );

            this._settingsChangedHandlers.push(
                this._settings.connect('changed::overview-global-factor', () => {
                    this._overviewUsesGlobal = this._settings.get_boolean('overview-global-factor');
                    this._handleChange();
                })
            );

            // Re-apply immediately when factors are edited in preferences, keeping
            // calibrated apps matched to the reference first
            for (const key of ['app-factors', 'h-app-factors', 'global-factor', 'h-global-factor',
                'scroll-gains', 'h-scroll-gains', 'scroll-reference', 'matched-apps']) {
                this._settingsChangedHandlers.push(
                    this._settings.connect('changed::' + key, () => {
                        this._syncMatchedApps();
                        this._handleChange();
                    })
                );
            }

            // Step 11: Re-check the window under the pointer when it can change
            // without the pointer moving (window opened/closed/raised, workspace
            // switch, overview closed)
            this._connectWindowChangeHandlers();

            // Step 12: Apply initial factor for the current window
            this._syncMatchedApps();
            this._handleChange();
            log('===== ENABLE COMPLETE =====');
        } catch (e) {
            logError('ERROR: ' + e.message);
        }
    }

    /**
     * Called when the extension is disabled.
     * Cleans up all resources: stops polling, disconnects signal, nullifies references.
     */
    disable() {
        log('===== DISABLE CALLED =====');

        if (this._wsfCheckCancellable) {
            this._wsfCheckCancellable.cancel();
            this._wsfCheckCancellable = null;
        }
        if (this._settings && this._debugLoggingHandler) {
            this._settings.disconnect(this._debugLoggingHandler);
        }
        this._debugLoggingHandler = null;

        this._stopCursorTracking();
        this._disconnectFocusHandler();
        this._disconnectWindowChangeHandlers();
        this._hidePanelIndicator();

        if (this._settings && this._settingsChangedHandlers) {
            for (const id of this._settingsChangedHandlers) {
                this._settings.disconnect(id);
            }
        }
        this._settingsChangedHandlers = null;

        this._windowUnderCursor = null;
        this._lastAppliedVFactor = null;
        this._lastAppliedHFactor = null;
        // A running `wsf set` is left to finish; its callback sees that it is
        // no longer current and does nothing.
        this._wsfProcess = null;
        this._pendingFactors = null;
        this._windowTracker = null;
        if (this._settings) {
            this._settings = null;
        }
        log('===== DISABLE COMPLETE =====');
    }

    /**
     * Checks whether WSF is active by running `wsf status` asynchronously,
     * so GNOME Shell is not blocked while it runs.
     *
     * @param {Gio.Cancellable} cancellable - Cancelled by disable().
     * @param {function(boolean)} callback - Receives true if WSF is fully
     *   active; not called if the check was cancelled.
     */
    _checkWSFStatus(cancellable, callback) {
        let proc;
        try {
            proc = Gio.Subprocess.new(
                [this._wsfPath, 'status'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE
            );
        } catch (e) {
            logError('Failed to check WSF status: ' + e.message);
            callback(false);
            return;
        }

        proc.communicate_utf8_async(null, cancellable, (p, result) => {
            let stdout = null;
            try {
                [, stdout] = p.communicate_utf8_finish(result);
            } catch (e) {
                if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
                logError('Failed to check WSF status: ' + e.message);
            }
            callback(isWSFActive(stdout));
        });
    }

    /**
     * Shows a GNOME Shell desktop notification.
     *
     * @param {string} title - The notification title.
     * @param {string} message - The notification body text.
     */
    _showNotification(title, message) {
        Main.notify(title, message);
    }

    /**
     * Starts cursor tracking.
     *
     * Detects which window is under the mouse cursor. This enables "scroll
     * focus follows mouse" behavior — when the user hovers over an unfocused
     * window and scrolls, the correct per-app factor is applied.
     *
     * Event-driven: the cursor tracker's position-invalidated signal schedules
     * a check at most once per cursor-poll-interval while the pointer moves.
     * Nothing runs while the pointer is idle. Reacting quickly matters because
     * the WSF preload only re-reads its config every 250ms during a gesture, so
     * the new factor must be written before the user starts scrolling.
     */
    _startCursorTracking() {
        if (this._cursorTrackerHandler) return;
        this._cursorTracker = global.backend.get_cursor_tracker();
        this._cursorTrackerHandler = this._cursorTracker.connect(
            'position-invalidated',
            () => this._scheduleCursorCheck()
        );
        this._scheduleCursorCheck(true);
        log('Cursor tracking started (' + this._cursorPollInterval + 'ms interval)');
    }

    /**
     * Stops cursor tracking.
     * Disconnects the cursor tracker and removes any pending check.
     */
    _stopCursorTracking() {
        if (this._cursorTrackerHandler) {
            this._cursorTracker.disconnect(this._cursorTrackerHandler);
            this._cursorTrackerHandler = null;
            this._cursorTracker = null;
            log('Cursor tracking stopped');
        }
        if (this._cursorCheckSource) {
            GLib.source_remove(this._cursorCheckSource);
            this._cursorCheckSource = null;
            this._forceCursorCheck = false;
        }
        this._windowUnderCursor = null;
        this._lastPointerX = null;
        this._lastPointerY = null;
    }

    /**
     * Schedules a check of the window under the cursor.
     *
     * Multiple requests within one interval collapse into a single check, so
     * continuous pointer motion costs at most one hit-test per interval.
     *
     * @param {boolean} force - Re-check even if the pointer has not moved
     *   (the window under it may have changed).
     */
    _scheduleCursorCheck(force = false) {
        if (force) this._forceCursorCheck = true;
        if (this._cursorCheckSource) return;
        this._cursorCheckSource = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            this._cursorPollInterval,
            () => {
                this._cursorCheckSource = null;
                const forced = this._forceCursorCheck;
                this._forceCursorCheck = false;
                this._updateCursorWindow(forced);
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    /**
     * Re-evaluates the target window after something other than pointer
     * motion may have changed it.
     */
    _recheckTarget() {
        if (this._cursorTrackingEnabled) {
            this._scheduleCursorCheck(true);
        } else {
            this._handleChange();
        }
    }

    /**
     * Connects the window focus change signal handler.
     *
     * Fires when the user switches windows via Alt+Tab, clicking, etc.
     * The window under the pointer keeps priority over the focused window,
     * so with cursor tracking enabled this only triggers a re-check.
     */
    _connectFocusHandler() {
        if (this._focusHandler) return;
        this._focusHandler = global.display.connect(
            'notify::focus-window',
            () => {
                log('Focus changed!');
                this._recheckTarget();
            }
        );
        log('Focus detection enabled');
    }

    /**
     * Disconnects the window focus change signal handler.
     */
    _disconnectFocusHandler() {
        if (this._focusHandler) {
            global.display.disconnect(this._focusHandler);
            this._focusHandler = null;
            log('Focus detection disabled');
        }
    }

    /**
     * Connects signals for changes that can put a different window under a
     * stationary pointer: restacking (windows opened, closed or raised),
     * workspace switches, and the overview opening or closing.
     */
    _connectWindowChangeHandlers() {
        if (this._windowChangeHandlers.length) return;
        const recheck = () => this._recheckTarget();
        this._windowChangeHandlers.push(
            [global.display, global.display.connect('restacked', recheck)],
            [global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', recheck)],
            [Main.overview, Main.overview.connect('hidden', recheck)],
            // Apply the overview behavior at once, before the user can swipe
            [Main.overview, Main.overview.connect('showing', () => this._handleChange())]
        );
    }

    /**
     * Disconnects the window change signals.
     */
    _disconnectWindowChangeHandlers() {
        if (!this._windowChangeHandlers) return;
        for (const [object, id] of this._windowChangeHandlers) {
            object.disconnect(id);
        }
        this._windowChangeHandlers = [];
    }

    /**
     * Shows a panel indicator displaying the current vertical and horizontal
     * factors. Its menu holds the calibration actions for the focused app.
     */
    _showPanelIndicator() {
        if (this._panelButton) return;
        this._panelButton = new PanelMenu.Button(0.0, 'TouchpadSpeedIndicator', false);
        this._panelLabel = new St.Label({
            text: 'V: 1.00  H: 1.00',
            y_align: Clutter.ActorAlign.CENTER
        });
        this._panelButton.add_child(this._panelLabel);

        this._referenceItem = new PopupMenu.PopupMenuItem('');
        this._referenceItem.connect('activate', () => this._calibrate(true));
        this._matchItem = new PopupMenu.PopupMenuItem('');
        this._matchItem.connect('activate', () => this._calibrate(false));
        this._horizontalItem = new PopupMenu.PopupMenuItem('');
        this._horizontalItem.connect('activate', () => this._calibrateHorizontal());
        this._panelButton.menu.addMenuItem(this._referenceItem);
        this._panelButton.menu.addMenuItem(this._matchItem);
        this._panelButton.menu.addMenuItem(this._horizontalItem);
        this._menuOpenHandler = this._panelButton.menu.connect('open-state-changed', (menu, open) => {
            if (open) this._updateCalibrationItems();
        });

        Main.panel.addToStatusArea('touchpad-speed-indicator', this._panelButton, 1, 'right');
    }

    /**
     * Labels the calibration menu items for the focused app and the stored
     * reference app.
     */
    _updateCalibrationItems() {
        const app = this._calibrationApp();
        const name = app ? app.get_name() : null;
        const reference = this._settings.get_string('scroll-reference');
        const referenceName = this._appName(reference);

        this._referenceItem.label.text = name
            ? `Use ${name} as scroll reference`
            : 'Focus an app window to calibrate';
        this._referenceItem.setSensitive(!!name && !this._calibrating);

        const canMatch = !!name && !!reference && app.get_id() !== reference;
        this._matchItem.label.text = reference
            ? `Match ${name ?? 'focused app'} to ${referenceName}`
            : 'Set a scroll reference first';
        this._matchItem.setSensitive(canMatch && !this._calibrating);

        this._horizontalItem.label.text = name
            ? `Measure horizontal scrolling of ${name}`
            : 'Measure horizontal scrolling';
        this._horizontalItem.setSensitive(!!name && !this._calibrating);
    }

    // The focused window's app, if it has a real application ID
    _calibrationApp() {
        const window = global.display.focus_window;
        if (!window || !this._windowTracker) return null;
        const app = this._windowTracker.get_window_app(window);
        // Window-backed apps ("window:123") have no stable ID to store a factor under
        return app && !app.get_id().startsWith('window:') ? app : null;
    }

    _appName(appId) {
        const app = appId ? Shell.AppSystem.get_default().lookup_app(appId) : null;
        return app ? app.get_name() : appId;
    }

    /**
     * Measures the focused app's scroll gain. As the reference, the gain is
     * stored for later matches; otherwise the app's vertical factor is set so
     * it scrolls as far per swipe as the reference app at its current factor.
     *
     * @param {boolean} asReference - Store as the reference instead of matching.
     */
    async _calibrate(asReference) {
        const app = this._calibrationApp();
        const window = global.display.focus_window;
        if (!app || this._calibrating) return;
        const appId = app.get_id();
        const name = app.get_name();

        this._calibrating = true;
        this._panelButton?.menu.close();
        try {
            // Let the menu close and give up its grab before scrolling
            await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            }));
            // With debug logging on, keep the captures of failed steps for diagnosis
            const saveDir = debugLogging
                ? GLib.build_filenamev([GLib.get_user_cache_dir(), 'touchpad-speed-control', 'calibration', appId])
                : null;
            const result = await measureWindowGain(window, line => log('Calibrate ' + appId + ': ' + line), saveDir);
            if (!this._settings) return;

            const gains = this._settings.get_value('scroll-gains').deep_unpack();
            gains[appId] = result.gain;
            this._settings.set_value('scroll-gains', new GLib.Variant('a{sd}', gains));
            log('Calibrate ' + appId + ': gain ' + result.gain.toFixed(3));

            const matched = this._settings.get_strv('matched-apps');
            if (asReference) {
                // The reference sets the pace; it cannot also follow it
                this._settings.set_strv('matched-apps', matched.filter(id => id !== appId));
                this._settings.set_string('scroll-reference', appId);
                this._showNotification('Scroll reference set',
                    `${name} scrolls ${result.gain.toFixed(2)} px per unit. Matched apps now follow it.`);
                return;
            }

            const reference = this._settings.get_string('scroll-reference');
            if (!gains[reference]) {
                this._showNotification('Calibration', 'Measure the reference app again first.');
                return;
            }
            if (!matched.includes(appId))
                this._settings.set_strv('matched-apps', [...matched, appId]);
            // Setting matched-apps already synced the factors; this covers a re-measured app
            this._syncMatchedApps();
            this._showNotification('Scroll speed matched',
                `${name} scrolls ${(result.gain / gains[reference]).toFixed(2)}× as far as ${this._appName(reference)} per unit. ` +
                `Factors set to ${this._resolveFactor('v', appId).toFixed(2)} (vertical) and ` +
                `${this._resolveFactor('h', appId).toFixed(2)} (horizontal); they follow the reference from now on.`);
        } catch (e) {
            logError('Calibration failed for ' + appId + ': ' + e.message);
            this._showNotification('Calibration failed', `${name}: ${e.message}`);
        } finally {
            this._calibrating = false;
        }
    }

    _hidePanelIndicator() {
        if (this._menuOpenHandler) {
            this._panelButton.menu.disconnect(this._menuOpenHandler);
            this._menuOpenHandler = null;
        }
        if (this._referenceItem) {
            this._referenceItem.destroy();
            this._referenceItem = null;
        }
        if (this._matchItem) {
            this._matchItem.destroy();
            this._matchItem = null;
        }
        if (this._horizontalItem) {
            this._horizontalItem.destroy();
            this._horizontalItem = null;
        }
        if (this._panelLabel) {
            this._panelLabel.destroy();
            this._panelLabel = null;
        }
        if (this._panelButton) {
            this._panelButton.destroy();
            this._panelButton = null;
        }
    }

    _updatePanelLabel(vFactor, hFactor) {
        if (this._panelLabel) {
            this._panelLabel.set_text('V: ' + vFactor.toFixed(2) + '  H: ' + hFactor.toFixed(2));
        }
    }

    /**
     * Updates _windowUnderCursor to reflect the window currently under the mouse pointer.
     *
     * Flow:
     *   1. Get pointer coordinates via global.get_pointer()
     *   2. Early-return if position unchanged, unless forced (avoids actor hit-testing)
     *   3. Use Clutter hit-testing (get_actor_at_pos) to find the actor at the cursor
     *   4. Walk up the actor tree via get_parent() to find a Meta.WindowActor
     *   5. Extract the Meta.Window and store it in _windowUnderCursor
     *   6. Call _handleChange() if the window changed (or the check was forced)
     *
     * Edge cases handled:
     *   - Cursor over GNOME Shell UI (top bar, dash) → _windowUnderCursor = null → falls back to focused window
     *   - No actor at cursor position → _windowUnderCursor = null
     *   - Actor tree walk fails → _windowUnderCursor = null (silent failure)
     *
     * @param {boolean} force - Hit-test and re-apply even if nothing seems to have changed.
     */
    _updateCursorWindow(force = false) {
        let metaWindow = null;
        try {
            const [x, y] = global.get_pointer();

            // Battery optimization: skip if pointer hasn't moved since last check
            if (!force && x === this._lastPointerX && y === this._lastPointerY) {
                return;
            }
            this._lastPointerX = x;
            this._lastPointerY = y;

            // Clutter hit-testing to find the actor at the cursor position
            let actor = global.get_stage().get_actor_at_pos(Clutter.PickMode.NONE, x, y);

            // Walk up the actor tree to find the Meta.WindowActor
            // GNOME Shell's actor hierarchy can be several levels deep,
            // so we traverse parents until we find one with get_meta_window()
            while (actor && !metaWindow) {
                if (actor.get_meta_window) {
                    metaWindow = actor.get_meta_window();
                }
                actor = actor.get_parent();
            }
        } catch (e) {
            metaWindow = null;
        }

        // Moving within the same window needs no further work
        if (!force && metaWindow === this._windowUnderCursor) {
            return;
        }

        // null means no window under the cursor (e.g., over shell UI)
        this._windowUnderCursor = metaWindow;
        this._handleChange();
    }

    /**
     * Measures the focused app's horizontal scroll gain. Optional: a matched
     * app measured horizontally (with a reference measured horizontally too)
     * gets its horizontal factor from the horizontal ratio instead of the
     * vertical one.
     */
    async _calibrateHorizontal() {
        const app = this._calibrationApp();
        const window = global.display.focus_window;
        if (!app || this._calibrating) return;
        const appId = app.get_id();
        const name = app.get_name();

        this._calibrating = true;
        this._panelButton?.menu.close();
        try {
            // Let the menu close and give up its grab before scrolling
            await new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            }));
            const saveDir = debugLogging
                ? GLib.build_filenamev([GLib.get_user_cache_dir(), 'touchpad-speed-control', 'calibration', appId])
                : null;
            const result = await measureWindowGain(window, line => log('Calibrate ' + appId + ': ' + line), saveDir, false);
            if (!this._settings) return;

            const hGains = this._settings.get_value('h-scroll-gains').deep_unpack();
            hGains[appId] = result.gain;
            this._settings.set_value('h-scroll-gains', new GLib.Variant('a{sd}', hGains));
            log('Calibrate ' + appId + ': horizontal gain ' + result.gain.toFixed(3));

            const gains = this._settings.get_value('scroll-gains').deep_unpack();
            const reference = this._settings.get_string('scroll-reference');
            let detail;
            if (appId === reference) {
                detail = 'Matched apps measured horizontally now use their horizontal ratio.';
            } else if (!hGains[reference]) {
                detail = `Measure ${this._appName(reference) || 'the reference app'} horizontally too to use it.`;
            } else {
                detail = `${(result.gain / hGains[reference]).toFixed(2)}× as far as ${this._appName(reference)}.`;
                if (this._settings.get_strv('matched-apps').includes(appId))
                    detail += ` Horizontal factor set to ${this._resolveFactor('h', appId).toFixed(2)}.`;
                else if (!gains[appId])
                    detail += ' Match it (vertically) to make it follow the reference.';
            }
            this._showNotification('Horizontal scrolling measured',
                `${name} scrolls ${result.gain.toFixed(2)} px per unit sideways. ${detail}`);
        } catch (e) {
            logError('Horizontal calibration failed for ' + appId + ': ' + e.message);
            this._showNotification('Calibration failed', `${name}: ${e.message}`);
        } finally {
            this._calibrating = false;
        }
    }

    /**
     * Recalculates the factors of matched apps from their measured gains, so
     * they keep scrolling like the reference app when its factor (or the
     * global factor it falls back to) changes. Writes only when something
     * differs, so the change signal it causes settles on the next call.
     */
    _syncMatchedApps() {
        if (!this._settings) return;
        const gains = this._settings.get_value('scroll-gains').deep_unpack();
        const matched = this._settings.get_strv('matched-apps');
        const reference = this._settings.get_string('scroll-reference');
        if (!matched.length) return;

        // Horizontal uses horizontal measurements where both the app and the
        // reference have one, and the vertical ratio otherwise
        const hGains = horizontalMatchingGains(
            gains, this._settings.get_value('h-scroll-gains').deep_unpack(), reference);
        for (const [factorsKey, globalKey, axisGains] of [
            ['app-factors', 'global-factor', gains],
            ['h-app-factors', 'h-global-factor', hGains],
        ]) {
            const updated = applyMatchedFactors(
                this._settings.get_value(factorsKey).deep_unpack(),
                this._settings.get_double(globalKey),
                axisGains, matched, reference);
            if (updated) {
                log('Matched apps updated (' + factorsKey + ')');
                this._settings.set_value(factorsKey, new GLib.Variant('a{sd}', updated));
            }
        }
    }

    /**
     * Resolves the scroll factor for a given app and axis.
     *
     * See resolveFactor() in factorResolver.js for the resolution order
     * (exact ID, wildcard rules, partial match, global fallback).
     *
     * @param {string} axis - 'v' for vertical, 'h' for horizontal.
     * @param {string} appId - The application ID (e.g., 'org.mozilla.firefox.desktop').
     * @returns {number} The resolved scroll factor.
     */
    _resolveFactor(axis, appId) {
        const appFactorsKey = axis === 'v' ? 'app-factors' : 'h-app-factors';
        const globalFactorKey = axis === 'v' ? 'global-factor' : 'h-global-factor';
        const axisLabel = axis === 'v' ? 'Vertical' : 'Horizontal';

        const factors = this._settings.get_value(appFactorsKey).deep_unpack();
        const globalFactor = this._settings.get_double(globalFactorKey);

        const result = resolveFactor(factors, appId, globalFactor);
        log(axisLabel + ' ' + result.source + ' match' + (result.key ? ': ' + result.key : ''));
        return result.factor;
    }

    /**
     * Main handler that detects the current app and applies scroll factors.
     *
     * Triggered by:
     *   - Window focus changes (notify::focus-window signal)
     *   - Cursor moving to a different window (cursor tracker)
     *   - Restacking, workspace switches, overview opening and closing
     *   - Factor edits in preferences
     *
     * Flow:
     *   1. Determine target window (cursor window preferred, fallback to focused window)
     *   2. Identify the application via Shell.WindowTracker
     *   3. Resolve vertical and horizontal factors independently
     *   4. Skip if both factors match the cached values
     *   5. Otherwise update the caches and queue one `wsf set` for both axes
     *
     * Factor caching:
     *   - _lastAppliedVFactor/_lastAppliedHFactor prevent redundant `wsf` subprocess spawns
     *     when the resolved factors haven't changed (e.g., switching between two apps with the same factors)
     */
    _handleChange() {
        try {
            // In the overview the pointer is over shell UI or window previews,
            // not app windows, so use the global factors there (#8) — e.g.
            // swiping between workspaces at the slow speed of the focused app
            if (this._overviewUsesGlobal && Main.overview.visible) {
                log('Overview open: using global factors');
                this._applyIfChanged(
                    this._settings.get_double('global-factor'),
                    this._settings.get_double('h-global-factor')
                );
                return;
            }

            // Prefer window under cursor; fall back to focused window
            const targetWindow = this._windowUnderCursor || global.display.focus_window;
            const source = this._windowUnderCursor ? 'cursor' : 'focus';

            if (!targetWindow) {
                log('No target window');
                return;
            }

            const app = this._windowTracker.get_window_app(targetWindow);
            if (!app) {
                log('No app for window');
                return;
            }

            const appId = app.get_id();
            const windowTitle = targetWindow.get_title ? targetWindow.get_title() : 'unknown';
            log('Source: ' + source + ' | App: ' + appId + ' | Title: ' + windowTitle);

            // Resolve factors for both axes independently
            const vFactor = this._resolveFactor('v', appId);
            log('Vertical factor: ' + vFactor);

            const hFactor = this._resolveFactor('h', appId);
            log('Horizontal factor: ' + hFactor);

            this._applyIfChanged(vFactor, hFactor);
        } catch (e) {
            logError('Error: ' + e.message);
        }
    }

    /**
     * Shows the factors in the panel indicator and queues a `wsf set` unless
     * both are already applied (avoids spawning wsf when nothing would change).
     *
     * @param {number} vFactor - Vertical scroll factor.
     * @param {number} hFactor - Horizontal scroll factor.
     */
    _applyIfChanged(vFactor, hFactor) {
        this._updatePanelLabel(vFactor, hFactor);

        if (vFactor === this._lastAppliedVFactor && hFactor === this._lastAppliedHFactor) {
            log('Factors unchanged, skipping');
            return;
        }
        this._lastAppliedVFactor = vFactor;
        this._lastAppliedHFactor = hFactor;
        this._applyFactors(vFactor, hFactor);
    }

    /**
     * Writes both factors to WSF.
     *
     * Each `wsf set` rewrites the whole WSF config, so overlapping runs can
     * undo each other (e.g. vertical from one app, horizontal from another).
     * Updates are therefore serialized: only one `wsf set` runs at a time, and
     * while it runs only the most recent request is kept and sent next.
     *
     * @param {number} vFactor - Vertical scroll factor.
     * @param {number} hFactor - Horizontal scroll factor.
     */
    _applyFactors(vFactor, hFactor) {
        this._pendingFactors = [vFactor, hFactor];
        if (!this._wsfProcess) {
            this._runPendingWsfUpdate();
        }
    }

    /**
     * Starts `wsf set` for the pending factors and, once it exits, sends any
     * request that arrived in the meantime.
     */
    _runPendingWsfUpdate() {
        const [vFactor, hFactor] = this._pendingFactors;
        this._pendingFactors = null;

        let proc;
        try {
            proc = Gio.Subprocess.new(
                [
                    this._wsfPath, 'set',
                    '--scroll-vertical', vFactor.toString(),
                    '--scroll-horizontal', hFactor.toString(),
                ],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
            );
        } catch (e) {
            logError('Failed to execute WSF: ' + e.message);
            return;
        }
        log('WSF factors applied: V=' + vFactor + ' H=' + hFactor);

        this._wsfProcess = proc;
        proc.wait_async(null, (p, result) => {
            try {
                p.wait_finish(result);
            } catch (e) {
                logError('WSF did not finish: ' + e.message);
            }
            // Ignore processes started before the extension was disabled
            if (this._wsfProcess !== p) return;
            this._wsfProcess = null;
            if (this._pendingFactors) {
                this._runPendingWsfUpdate();
            }
        });
    }
}
