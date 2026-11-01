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
//   - Factor resolution: per-app exact match → .desktop suffix match → partial substring match → global fallback

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

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

// Set to true for verbose logging (useful for debugging, disable for production)
const DEBUG = false;

/**
 * Logs a message to the journal only when DEBUG is enabled.
 *
 * @param {string} message - The log message.
 */
function log(msg) {
    if (DEBUG) console.log('[TouchpadSpeed] ' + msg);
}

/**
 * Logs an error to the journal only when DEBUG is enabled.
 *
 * @param {string} message - The error message.
 */
function logError(msg) {
    if (DEBUG) console.error('[TouchpadSpeed] ' + msg);
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
     *   1. Check if WSF binary exists (searches $PATH and common locations)
     *   2. Check if WSF preload is active (enabled + library mapped into gnome-shell)
     *   3. If either check fails, show a notification and abort
     *   4. Load GSettings, initialize state, start cursor tracking
     *   5. Connect to window focus change signal
     *   6. Trigger initial factor application
     */
     enable() {
        log('===== ENABLE CALLED =====');

        try {
            // Step 1: Verify WSF binary exists
            this._wsfPath = _findWSFPath();
            if (!this._wsfPath) {
                logError('WSF binary not found in PATH or common locations');
                this._showNotification(
                    'WSF Not Installed',
                    'Touchpad Speed Control requires Wayland Scroll Factor (WSF). Please install it first: https://github.com/daniel-g-carrasco/wayland-scroll-factor'
                );
                return;
            }
            log('WSF found at: ' + this._wsfPath);

            // Step 2: Verify WSF preload is active
            const wsfActive = this._checkWSFStatus();
            if (!wsfActive) {
                logError('WSF preload is not active');
                this._showNotification(
                    'WSF Preload Not Active',
                    'Touchpad Speed Control requires WSF preload to be enabled. Run "wsf enable" and log out/in.'
                );
                return;
            }
            log('WSF preload is active');

            // Step 3: Load GSettings schema
            this._settings = this.getSettings();
            log('Settings loaded');

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

            // Re-apply immediately when factors are edited in preferences
            for (const key of ['app-factors', 'h-app-factors', 'global-factor', 'h-global-factor']) {
                this._settingsChangedHandlers.push(
                    this._settings.connect('changed::' + key, () => this._handleChange())
                );
            }

            // Step 11: Re-check the window under the pointer when it can change
            // without the pointer moving (window opened/closed/raised, workspace
            // switch, overview closed)
            this._connectWindowChangeHandlers();

            // Step 12: Apply initial factor for the current window
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
     * Checks if WSF is properly installed and active.
     *
     * Runs `wsf status` and parses the output for two critical conditions:
     *   - "enabled: yes" — WSF environment.d config is in place
     *   - "gnome-shell library mapped: yes" — libwsf_preload.so is loaded into gnome-shell
     *
     * Both conditions must be true for scroll factor changes to take effect.
     *
     * @returns {boolean} True if WSF is fully active, false otherwise.
     */
     _checkWSFStatus() {
        try {
            const subprocess = Gio.Subprocess.new(
                [this._wsfPath, 'status'],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE
            );
            const [, stdout] = subprocess.communicate_utf8(null, null);
            subprocess.wait(null);

            if (!stdout) return false;

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

            return enabled && libraryMapped;
        } catch (e) {
            logError('Failed to check WSF status: ' + e.message);
            return false;
        }
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
     * workspace switches, and the overview closing.
     */
    _connectWindowChangeHandlers() {
        if (this._windowChangeHandlers.length) return;
        const recheck = () => this._recheckTarget();
        this._windowChangeHandlers.push(
            [global.display, global.display.connect('restacked', recheck)],
            [global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', recheck)],
            [Main.overview, Main.overview.connect('hidden', recheck)]
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
     * Shows a panel indicator displaying the current vertical and horizontal factors.
     */
    _showPanelIndicator() {
        if (this._panelButton) return;
        this._panelButton = new PanelMenu.Button(0.0, 'TouchpadSpeedIndicator', false);
        this._panelLabel = new St.Label({
            text: 'V: 1.00  H: 1.00',
            y_align: Clutter.ActorAlign.CENTER
        });
        this._panelButton.add_child(this._panelLabel);
        Main.panel.addToStatusArea('touchpad-speed-indicator', this._panelButton, 1, 'right');
    }

    _hidePanelIndicator() {
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
     * Resolves the scroll factor for a given app and axis.
     *
     * Resolution order (first match wins):
     *   1. Exact match on normalized app ID (without .desktop suffix)
     *   2. Exact match on full app ID (with .desktop suffix)
     *   3. Partial/prefix match (bidirectional substring matching)
     *   4. Global factor fallback
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

        // Normalize app ID by stripping .desktop suffix (8 characters)
        const normalizedAppId = appId.endsWith('.desktop') ? appId.slice(0, -8) : appId;

        let factor;

        // Step 1: Try exact match on normalized app ID
        factor = factors[normalizedAppId];

        if (factor === undefined) {
            // Step 2: Try exact match with .desktop suffix
            factor = factors[appId];
        }

        if (factor === undefined) {
            // Step 3: Try partial/prefix match (bidirectional)
            // Matches if either the stored key is a substring of the app ID,
            // or the app ID is a substring of the stored key.
            for (const [key, value] of Object.entries(factors)) {
                const normalizedKey = key.endsWith('.desktop') ? key.slice(0, -8) : key;
                if (normalizedAppId.includes(normalizedKey) || normalizedKey.includes(normalizedAppId)) {
                    factor = value;
                    log(axisLabel + ' partial match: ' + key);
                    break;
                }
            }
        }

        // Step 4: Use global factor if no per-app match found
        if (factor === undefined) {
            factor = globalFactor;
            log(axisLabel + ' using global factor');
        }

        return factor;
    }

    /**
     * Main handler that detects the current app and applies scroll factors.
     *
     * Triggered by:
     *   - Window focus changes (notify::focus-window signal)
     *   - Cursor moving to a different window (cursor tracker)
     *   - Restacking, workspace switches, overview closing
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

            // Update panel indicator with the current factors
            this._updatePanelLabel(vFactor, hFactor);

            // Skip the wsf call if both factors are already applied
            // This avoids spawning a wsf subprocess when nothing would change
            if (vFactor === this._lastAppliedVFactor && hFactor === this._lastAppliedHFactor) {
                log('Factors unchanged, skipping');
                return;
            }
            this._lastAppliedVFactor = vFactor;
            this._lastAppliedHFactor = hFactor;
            this._applyFactors(vFactor, hFactor);
        } catch (e) {
            logError('Error: ' + e.message);
        }
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
