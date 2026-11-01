// Touchpad Speed Control - Wayland Scroll Factor (WSF) helpers shared by extension.js and prefs.js
// Author: Ritesh Seth
// License: GPL v3
// GitHub: https://github.com/ritesh-777/touchpad-speed-control

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

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
export function findWSFPath() {
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
 * Parses `wsf status` output.
 *
 * WSF is usable only when both are true:
 *   - "enabled: yes" — WSF environment.d config is in place
 *   - "gnome-shell library mapped: yes" — libwsf_preload.so is loaded into gnome-shell
 *
 * @param {string|null} output - stdout of `wsf status`.
 * @returns {boolean} True if WSF is fully active.
 */
export function isWSFActive(output) {
    if (!output) return false;

    let enabled = false;
    let libraryMapped = false;
    for (const line of output.split('\n')) {
        if (line.startsWith('enabled: yes')) enabled = true;
        if (line.startsWith('gnome-shell library mapped: yes')) libraryMapped = true;
    }
    return enabled && libraryMapped;
}
