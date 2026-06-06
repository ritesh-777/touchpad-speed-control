# Touchpad Speed Control

[![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-47%E2%80%9350-blue.svg)](https://gnome.org)
[![License](https://img.shields.io/badge/License-GPL%20v3-blue.svg)](LICENSE)

Per-application touchpad scroll speed control for GNOME on Wayland.

Set different vertical and horizontal scroll speeds for each application. Scroll faster in code editors, slower in browsers — all automatically applied when you switch windows or hover over them.

## Prerequisites

This extension **requires** [Wayland Scroll Factor (WSF)](https://github.com/daniel-g-carrasco/wayland-scroll-factor) to be installed and active. WSF provides the underlying mechanism to adjust scroll sensitivity on Wayland.

### Install WSF

Follow the [WSF installation guide](https://github.com/daniel-g-carrasco/wayland-scroll-factor#installation) for your distribution:

- **Arch Linux**: Available via AUR
- **Ubuntu/Debian**: Build from source (requires `meson`, `libinput-dev`)
- **Fedora**: Build from source

After installation, enable the preload library:

```bash
wsf enable
```

Then **log out and log back in** for the changes to take effect.

## Installation

### Method 1: GNOME Extensions Website (Recommended)

Install from [extensions.gnome.org](https://extensions.gnome.org/) (coming soon).

### Method 2: One-Line Install (Recommended for Manual Installation)

```bash
curl -fsSL https://raw.githubusercontent.com/ritesh-777/touchpad-speed-control/main/install.sh | bash
```

Then log out and back in for changes to take effect.

To update to the latest version, run the same command again — it will automatically pull the latest changes.

## Usage

### Opening Settings

Open GNOME Extensions, find "Touchpad Speed Control", and click the settings gear icon.

### Configuring Settings

The settings interface is organized into three tabs:

#### 1. General

- **Enable cursor tracking** — Detects which window is under the pointer even if it is not focused (enables "scroll focus follows mouse").
- **Poll interval (ms)** — Fine-tune how frequently the cursor position is polled (50ms – 2000ms). Lower values are more responsive; higher values save battery.
- **Enable focus detection** — Detects application changes when you switch active windows (e.g. via Alt+Tab or clicking).
- **Panel indicator** — Displays the currently applied vertical and horizontal factors in the GNOME Shell top panel status area for real-time diagnostics.
- **Export/Import Settings** — Save or restore your custom scroll factors to/from a JSON backup file.

#### 2. Vertical Scroll

Controls vertical (up/down) scroll speed:
- **Global Factor** — The default scroll speed applied to all applications. Adjust the slider to change the baseline speed for every app.
- **Per-App Sliders** — Individual scroll speed controls for each installed application. Apps with custom values override the global factor.

#### 3. Horizontal Scroll

Controls horizontal (left/right) scroll speed with the same layout and options as the Vertical axis, operating independently.

### Controls

| Control | Description |
|---------|-------------|
| **Slider** | Drag to adjust the scroll factor (0.05 – 5.00) |
| **− / +** | Fine-tune by 0.01 increments |
| **Search** | Filter applications by name or ID |
| **Reset to Defaults** | Reset all factors to 1.0 for the current axis |
| **Sync to Horizontal / Vertical** | Copy all settings from one axis to the other |
| **Export Settings** | Save all factors to a JSON file |
| **Import Settings** | Load all factors from a JSON file |

### How It Works

The extension detects which application you're interacting with using two methods:

1. **Window Focus** — When you switch windows via Alt+Tab or clicking, the extension detects the newly focused window and applies its scroll factor.

2. **Cursor Tracking** — When you hover over an unfocused window and scroll (GNOME's "scroll focus follows mouse" behavior), the extension detects the window under your cursor and applies the correct factor.

Scroll factors are cached and only updated when the application changes, minimizing system overhead.

### Scroll Factor Values

| Value | Effect |
|-------|--------|
| `0.05` | Very slow scrolling |
| `0.15` | Slow scrolling |
| `0.35` | Moderate scrolling |
| `0.50` | Slightly slow |
| `1.00` | Default (no change) |
| `5.00` | Very fast scrolling |

## Troubleshooting

### "WSF Not Installed"

The extension cannot find the `wsf` binary. It searches `$PATH`, `~/.local/bin/wsf`, `/usr/local/bin/wsf`, and `/usr/bin/wsf`. Install WSF first:

```bash
# Check if WSF is installed
which wsf

# If not found, follow the installation guide:
# https://github.com/daniel-g-carrasco/wayland-scroll-factor
```

### "WSF Preload Not Active"

WSF is installed but the preload library is not loaded into GNOME Shell. Enable it:

```bash
wsf enable
```

Then **log out and log back in**. The preload requires a fresh session to take effect.

### Scroll speed not changing

1. Verify WSF is active: `wsf status`
2. Check that `gnome-shell library mapped: yes` appears in the output
3. Ensure the extension is enabled: `gnome-extensions list | grep touchpad-speed`
4. Check journal logs: `journalctl -f | grep TouchpadSpeed`

### Extension not showing in GNOME Extensions

1. Ensure the folder is at the correct path: `~/.local/share/gnome-shell/extensions/touchpad-speed-control@ritesh/`
2. Recompile the schema: `glib-compile-schemas ~/.local/share/gnome-shell/extensions/touchpad-speed-control@ritesh/schemas/`
3. Restart GNOME Shell

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    GNOME Shell                          │
│                                                         │
│  ┌──────────────┐    ┌──────────────┐                   │
│  │ Focus Signal │    │ Cursor Poller│ (300ms)            │
│  │ (event-driven│    │ (position    │                   │
│  │  Alt+Tab,    │    │  deduped)    │                   │
│  │  click)      │    │              │                   │
│  └──────┬───────┘    └──────┬───────┘                   │
│         │                   │                           │
│         └────────┬──────────┘                           │
│                  ▼                                      │
│         ┌────────────────┐                              │
│         │  _handleChange │                              │
│         │  (app detect)  │                              │
│         └────────┬───────┘                              │
│                  │                                      │
│         ┌────────▼────────┐                             │
│         │ _resolveFactor  │                             │
│         │ (v + h axes)    │                             │
│         └────────┬────────┘                             │
│                  │                                      │
│         ┌────────▼────────┐                             │
│         │  Factor Cache   │                             │
│         │ (skip if same)  │                             │
│         └────────┬────────┘                             │
│                  │                                      │
│    ┌─────────────┴─────────────┐                        │
│    ▼                           ▼                        │
│ wsf set --scroll-v    wsf set --scroll-h               │
│ <factor>              <factor>                         │
└─────────────────────────────────────────────────────────┘
```

## Support

If this extension has helped improve your daily workflow, consider supporting its ongoing development:

- [Sponsor on GitHub Sponsors](https://github.com/sponsors/ritesh-777)

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the GNU General Public License v3.0 — see the [LICENSE](LICENSE) file for details.

## Acknowledgments

- [Wayland Scroll Factor (WSF)](https://github.com/daniel-g-carrasco/wayland-scroll-factor) by daniel-g-carrasco — the underlying scroll adjustment mechanism
- GNOME Shell Extensions framework
