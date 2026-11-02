# Touchpad Speed Control

[![GNOME Shell](https://img.shields.io/badge/GNOME%20Shell-46%E2%80%9351-blue.svg)](https://gnome.org)
[![License](https://img.shields.io/badge/License-GPL%20v3-blue.svg)](LICENSE)
[![Sponsor on GitHub](https://img.shields.io/badge/Sponsor-GitHub%20Sponsors-ea4aaa?style=flat&logo=github-sponsors)](https://github.com/sponsors/ritesh-777)

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

Install from [extensions.gnome.org](https://extensions.gnome.org/extension/10008/touchpad-speed-control/).

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
- **Cursor check interval (ms)** — The shortest time between checks of which window is under the pointer while it moves (50ms – 2000ms, default 50ms). Lower values switch speeds sooner; nothing runs while the pointer is still.
- **Enable focus detection** — Detects application changes when you switch active windows (e.g. via Alt+Tab or clicking).
- **Use global speed in the Overview** — While the Activities overview or app grid is open, use the global speed instead of the focused app's, so swiping between workspaces is not slowed down by a slow app (on by default).
- **Quick Settings tile** — A Touchpad Speed tile in Quick Settings (on by default) shows the applied speeds. Click it to open these settings; open its menu for − / + buttons that change the focused app's vertical and horizontal speed, and for the calibration actions.
- **Calibration** — Lists the apps you have measured (see [Matching apps automatically](#matching-apps-automatically)): the reference app, how much faster or slower each app scrolls than it, a switch to make an app follow the reference, ★ to make it the reference, and 🗑 to forget a measurement.
- **Panel indicator** — Displays the currently applied vertical and horizontal factors in the GNOME Shell top panel status area for real-time diagnostics. Its menu also has the calibration actions.
- **Export/Import Settings** — Save or restore your custom scroll factors to/from a JSON backup file.

#### 2. Vertical Scroll

Controls vertical (up/down) scroll speed:
- **Global Factor** — The default scroll speed applied to all applications. Adjust the slider to change the baseline speed for every app.
- **Rules** — Give every app whose ID matches a wildcard rule the same speed, including apps installed later. `*` matches anything and `?` one character; for example `brave-*` covers every Brave web app. Rules ignore upper/lower case.
- **Per-App Sliders** — Individual scroll speed controls for each installed application. Apps with custom values override rules and the global factor. Hover over a value to see which rule set it.

#### 3. Horizontal Scroll

Controls horizontal (left/right) scroll speed with the same layout and options as the Vertical axis, operating independently.

### Controls

| Control | Description |
|---------|-------------|
| **Slider** | Drag to adjust the scroll factor (0.05 – 2.00) |
| **− / +** | Fine-tune by 0.01 increments |
| **Search** | Filter applications by name or ID |
| **Add Rule / 🗑** | Add or remove a wildcard rule such as `brave-*` |
| **Reset to Defaults** | Reset all factors to 1.0 for the current axis |
| **Sync to Horizontal / Vertical** | Copy all settings from one axis to the other |
| **Export Settings** | Save all factors to a JSON file |
| **Import Settings** | Load all factors from a JSON file |

### How It Works

The extension detects which application you're interacting with using two methods:

1. **Window Focus** — When you switch windows via Alt+Tab or clicking, the extension detects the newly focused window and applies its scroll factor.

2. **Cursor Tracking** — When you hover over an unfocused window and scroll (GNOME's "scroll focus follows mouse" behavior), the extension detects the window under your cursor and applies the correct factor.

Calibration measures an app by sending a short, slow two-finger scroll to its window through a virtual pointer, capturing a strip of the window before and after, and finding how far the content moved. It repeats with twice the scroll and only accepts a result when the content moved twice as far. Virtual scroll events reach the app without passing through WSF, so the measurement does not depend on the factor currently applied.

Scroll factors are cached and only updated when the application changes, minimizing system overhead.

For each application the speed is chosen in this order:

1. A speed set for that exact app (upper/lower case does not matter)
2. The most specific matching rule (most letters besides `*` and `?`)
3. A saved app ID that is part of the app's ID, or the other way round
4. The global factor

### Matching Apps Automatically

Apps scroll different distances for the same swipe: on a typical system Chrome and other Chromium-based apps scroll about six times as far as GTK apps such as Files or Text Editor. Instead of tuning every app by hand, you can measure each app once and let it follow one **reference** app whose speed you like.

1. Open the **Touchpad Speed** tile's menu in Quick Settings (the arrow next to the tile). The same actions are in the panel indicator's menu if you turn that on.
2. Open a long page or document in the app you want as the reference (for example Text Editor), scroll to the middle and click into it. From the tile's menu, choose **Use … as scroll reference**. Keep your hands off the touchpad for a few seconds: the extension scrolls the page a little, measures how far it moved, and scrolls it back.
3. Do the same in each other app, choosing **Match … to …** instead.

Matched apps get the factor that makes a swipe move the same distance as in the reference, on both axes. Horizontal scrolling uses the same ratio unless you measure it too: open something that scrolls sideways (a wide table, long lines of code, Files' column view) and choose **Measure horizontal scrolling of …** from the tile's menu. The horizontal factor then comes from how far the app scrolls sideways compared with the reference. The reference is taken to scroll as far sideways as vertically unless you measure it sideways too. Some views scroll far faster sideways than down; Files' column view moves about 25 times as far, and its factor may hit WSF's minimum of 0.05. They keep following it: change the reference app's speed or the global factor and every matched app is recalculated, so one slider sets the feel everywhere. Setting a matched app's speed by hand stops it following.

Measurements run on your own machine, so your touchpad, display scaling and app versions are taken into account. Pick a page with plenty of text, away from its top and bottom; a chat that sits at its bottom is fine, since calibration then measures by scrolling up.

### Scroll Factor Values

| Value | Effect |
|-------|--------|
| `0.05` | Very slow scrolling |
| `0.15` | Slow scrolling |
| `0.35` | Moderate scrolling |
| `0.50` | Slightly slow |
| `1.00` | Default (no change) |
| `2.00` | Fast scrolling |

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
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐   │
│  │ Focus signal │  │ Cursor       │  │ Restack,     │   │
│  │ (Alt+Tab,    │  │ tracker      │  │ workspace,   │   │
│  │  click)      │  │ (on motion,  │  │ overview,    │   │
│  │              │  │  ≤1 per 50ms)│  │ prefs edits  │   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘   │
│         └─────────────────┼─────────────────┘           │
│                           ▼                             │
│                  ┌────────────────┐                     │
│                  │  _handleChange │                     │
│                  │  (app detect)  │                     │
│                  └────────┬───────┘                     │
│                  ┌────────▼────────┐                    │
│                  │ _resolveFactor  │                    │
│                  │ (v + h axes)    │                    │
│                  └────────┬────────┘                    │
│                  ┌────────▼────────┐                    │
│                  │  Factor cache   │                    │
│                  │ (skip if same)  │                    │
│                  └────────┬────────┘                    │
│                  ┌────────▼────────┐                    │
│                  │ Serialized queue│                    │
│                  │ (one at a time, │                    │
│                  │  latest wins)   │                    │
│                  └────────┬────────┘                    │
│                           ▼                             │
│     wsf set --scroll-vertical V --scroll-horizontal H   │
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
