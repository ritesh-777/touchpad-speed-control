// SPDX-License-Identifier: GPL-3.0-or-later

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export function findWSFPath() {
    return GLib.find_program_in_path('wsf') ??
        [`${GLib.get_home_dir()}/.local/bin/wsf`, '/usr/local/bin/wsf', '/usr/bin/wsf']
            .find(path => Gio.File.new_for_path(path).query_exists(null)) ??
        null;
}

// `wsf status` output: the preload is configured and loaded into gnome-shell
export function isWSFActive(output) {
    const lines = output?.split('\n') ?? [];
    return lines.some(line => line.startsWith('enabled: yes')) &&
        lines.some(line => line.startsWith('gnome-shell library mapped: yes'));
}
