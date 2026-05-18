#!/usr/bin/env bash
set -e

EXT_DIR="$HOME/.local/share/gnome-shell/extensions/touchpad-speed-control@ritesh"

echo "Installing Touchpad Speed Control..."

if [ -d "$EXT_DIR" ]; then
    echo "Updating existing installation..."
    (cd "$EXT_DIR" && git pull)
else
    git clone https://github.com/ritesh-777/touchpad-speed-control.git "$EXT_DIR"
fi

glib-compile-schemas "$EXT_DIR/schemas/"
gnome-extensions enable touchpad-speed-control@ritesh

echo ""
echo "Installed successfully."
echo "Log out and back in for changes to take effect."
