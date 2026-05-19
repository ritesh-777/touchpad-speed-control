// Touchpad Speed Control - Per-application scroll factor control for GNOME on Wayland
// Author: Ritesh Seth
// License: MIT
// GitHub: https://github.com/ritesh-777/touchpad-speed-control
//
// This extension provides per-application touchpad scroll speed control on GNOME Wayland.
// It depends on Wayland Scroll Factor (WSF): https://github.com/daniel-g-carrasco/wayland-scroll-factor
//
// Architecture:
//   - Dual-trigger system: window focus changes (event-driven) + cursor polling (300ms interval)
//   - Factor caching: only calls `wsf` when the resolved factor actually differs from the cached value
//   - Battery optimization: cursor polling skips actor hit-testing when pointer position is unchanged
//   - Factor resolution: per-app exact match → .desktop suffix match → partial substring match → global fallback

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import Clutter from 'gi://Clutter';
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

    const home = GLib.getenv('HOME');
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
 *   disable() → Cleans up all resources, stops polling, disconnects handlers
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
            // This checks both "enabled: yes" and "gnome-shell library mapped: yes"
            // from `wsf status` output. Without preload, `wsf set` commands do nothing.
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
            // _windowUnderCursor: the Meta.Window currently under the mouse pointer
            // _lastPointerX/Y: cached pointer position for deduplication (battery optimization)
            // _cursorPoller: GLib timeout source ID for the 300ms polling interval
            // _lastAppliedAppId: tracks which app's factor was last applied (prevents redundant calls)
            // _lastAppliedVFactor: cached vertical scroll factor (prevents redundant wsf calls)
            // _lastAppliedHFactor: cached horizontal scroll factor (prevents redundant wsf calls)
            this._windowUnderCursor = null;
            this._lastPointerX = 0;
            this._lastPointerY = 0;
            this._cursorPoller = null;
            this._lastAppliedAppId = null;
            this._lastAppliedVFactor = null;
            this._lastAppliedHFactor = null;

            // Step 6: Start cursor tracking (300ms polling interval)
            this._startCursorTracking();

            // Step 7: Connect to window focus change signal
            // Fires when the user switches windows via Alt+Tab, clicking, etc.
            // Resets _lastAppliedAppId to ensure factor is re-evaluated on focus change.
            this._focusHandler = global.display.connect(
                'notify::focus-window',
                () => {
                    log('Focus changed!');
                    this._lastAppliedAppId = null;
                    this._handleChange();
                }
            );

            // Step 8: Apply initial factor for the current window
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

        if (this._focusHandler) {
            global.display.disconnect(this._focusHandler);
            this._focusHandler = null;
        }

        this._windowUnderCursor = null;
        this._lastAppliedAppId = null;
        this._lastAppliedVFactor = null;
        this._lastAppliedHFactor = null;
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
        try {
            Main.notify(title, message);
        } catch (e) {
            logError('Failed to show notification: ' + e.message);
        }
    }

    /**
     * Starts the cursor tracking poller.
     *
     * Polls every 300ms to detect which window is under the mouse cursor.
     * This enables "scroll focus follows mouse" behavior — when the user hovers
     * over an unfocused window and scrolls, the correct per-app factor is applied.
     *
     * Battery optimization: the poller skips expensive actor hit-testing when
     * the pointer position hasn't changed since the last check.
     */
    _startCursorTracking() {
        this._cursorPoller = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            300,
            () => {
                this._updateCursorWindow();
                return GLib.SOURCE_CONTINUE;
            }
        );
        log('Cursor tracking started (300ms interval)');
    }

    /**
     * Stops the cursor tracking poller.
     * Removes the GLib timeout source to prevent further polling.
     */
    _stopCursorTracking() {
        if (this._cursorPoller) {
            GLib.source_remove(this._cursorPoller);
            this._cursorPoller = null;
            log('Cursor tracking stopped');
        }
    }

    /**
     * Updates _windowUnderCursor to reflect the window currently under the mouse pointer.
     *
     * Flow:
     *   1. Get pointer coordinates via global.get_pointer()
     *   2. Early-return if position unchanged (battery optimization — avoids actor hit-testing)
     *   3. Use Clutter hit-testing (get_actor_at_pos) to find the actor at the cursor
     *   4. Walk up the actor tree via get_parent() to find a Meta.WindowActor
     *   5. Extract the Meta.Window and store it in _windowUnderCursor
     *   6. Call _handleChange() to apply the factor for the new window
     *
     * Edge cases handled:
     *   - Cursor over GNOME Shell UI (top bar, dash) → _windowUnderCursor = null → falls back to focused window
     *   - No actor at cursor position → _windowUnderCursor = null
     *   - Actor tree walk fails → _windowUnderCursor = null (silent failure)
     */
    _updateCursorWindow() {
        try {
            const [x, y, mask] = global.get_pointer();

            // Battery optimization: skip if pointer hasn't moved since last check
            if (x === this._lastPointerX && y === this._lastPointerY) {
                return;
            }
            this._lastPointerX = x;
            this._lastPointerY = y;

            // Clutter hit-testing to find the actor at the cursor position
            const actor = global.get_stage().get_actor_at_pos(Clutter.PickMode.NONE, x, y);

            if (!actor) {
                this._windowUnderCursor = null;
                this._handleChange();
                return;
            }

            // Walk up the actor tree to find the Meta.WindowActor
            // GNOME Shell's actor hierarchy can be several levels deep,
            // so we traverse parents until we find one with get_meta_window()
            let windowActor = actor;
            while (windowActor) {
                if (windowActor.get_meta_window) {
                    const metaWindow = windowActor.get_meta_window();
                    if (metaWindow) {
                        this._windowUnderCursor = metaWindow;
                        this._handleChange();
                        return;
                    }
                }
                windowActor = windowActor.get_parent();
            }

            // No window found at cursor position (e.g., over shell UI)
            this._windowUnderCursor = null;
            this._handleChange();
        } catch (e) {
            this._windowUnderCursor = null;
        }
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
     *   - Cursor moving to a different window (300ms poller)
     *
     * Flow:
     *   1. Determine target window (cursor window preferred, fallback to focused window)
     *   2. Identify the application via Shell.WindowTracker
     *   3. Skip if the same app was already processed (prevents redundant calls)
     *   4. Resolve vertical and horizontal factors independently
     *   5. Call `wsf set` only if the resolved factor differs from the cached value
     *   6. Update caches (_lastAppliedAppId, _lastAppliedVFactor, _lastAppliedHFactor)
     *
     * Factor caching:
     *   - _lastAppliedAppId prevents re-processing the same app on consecutive calls
     *   - _lastAppliedVFactor/_lastAppliedHFactor prevent redundant `wsf` subprocess spawns
     *     when the resolved factor hasn't changed (e.g., switching between two apps with the same factor)
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

            // Skip if the same app was already processed
            // This prevents redundant factor resolution and wsf calls
            if (appId === this._lastAppliedAppId) {
                log('Same app, skipping');
                return;
            }

            // Resolve factors for both axes independently
            const vFactor = this._resolveFactor('v', appId);
            log('Vertical factor: ' + vFactor);

            const hFactor = this._resolveFactor('h', appId);
            log('Horizontal factor: ' + hFactor);

            // Mark this app as processed
            this._lastAppliedAppId = appId;

            // Apply vertical factor only if it differs from the cached value
            // This avoids spawning a wsf subprocess when the factor hasn't changed
            if (vFactor !== this._lastAppliedVFactor) {
                try {
                    Gio.Subprocess.new(
                        [this._wsfPath, 'set', '--scroll-vertical', vFactor.toString()],
                        Gio.SubprocessFlags.NONE
                    );
                    log('Vertical WSF command executed');
                } catch (e) {
                    logError('Failed to execute vertical WSF: ' + e.message);
                }
                this._lastAppliedVFactor = vFactor;
            } else {
                log('Vertical factor unchanged, skipping');
            }

            // Apply horizontal factor only if it differs from the cached value
            if (hFactor !== this._lastAppliedHFactor) {
                try {
                    Gio.Subprocess.new(
                        [this._wsfPath, 'set', '--scroll-horizontal', hFactor.toString()],
                        Gio.SubprocessFlags.NONE
                    );
                    log('Horizontal WSF command executed');
                } catch (e) {
                    logError('Failed to execute horizontal WSF: ' + e.message);
                }
                this._lastAppliedHFactor = hFactor;
            } else {
                log('Horizontal factor unchanged, skipping');
            }
        } catch (e) {
            logError('Error: ' + e.message);
        }
    }
}
