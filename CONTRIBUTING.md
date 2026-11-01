# Contributing to Touchpad Speed Control

Thank you for your interest in contributing! This project welcomes bug reports, feature requests, and code contributions.

## Table of Contents

- [Reporting Bugs](#reporting-bugs)
- [Suggesting Features](#suggesting-features)
- [Submitting Pull Requests](#submitting-pull-requests)
- [Development Setup](#development-setup)
- [Code Style](#code-style)
- [Testing Changes](#testing-changes)
- [Releasing](#releasing)

## Reporting Bugs

Before opening a bug report, please:

1. Check the [existing issues](https://github.com/ritesh-777/touchpad-speed-control/issues) to avoid duplicates
2. Ensure WSF is properly installed and active (`wsf status`)
3. Check the extension logs: `journalctl -f | grep TouchpadSpeed`

When reporting a bug, include:

- **GNOME Shell version** (run `gnome-shell --version`)
- **Distribution** (e.g., Fedora 44, Ubuntu 24.04, Arch)
- **WSF version** (run `wsf --version` or check the repo)
- **Steps to reproduce** the issue
- **Expected behavior** vs **actual behavior**
- **Relevant logs** from `journalctl -f | grep TouchpadSpeed`

## Suggesting Features

Open a [new issue](https://github.com/ritesh-777/touchpad-speed-control/issues/new) with the label `enhancement`. Describe:

- What problem the feature solves
- How you envision it working
- Any alternative approaches you've considered

## Submitting Pull Requests

1. **Fork** the repository
2. **Create a branch** for your changes:
   ```bash
   git checkout -b feature/your-feature-name
   ```
3. **Make your changes** following the [code style](#code-style)
4. **Test locally** (see [Development Setup](#development-setup))
5. **Commit** with a clear message:
   ```bash
   git commit -m "feat: add per-monitor scroll factor support"
   ```
6. **Push** to your fork:
   ```bash
   git push origin feature/your-feature-name
   ```
7. **Open a Pull Request** against the `main` branch

### Commit Message Convention

Follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` — New feature
- `fix:` — Bug fix
- `docs:` — Documentation changes
- `refactor:` — Code restructuring (no behavior change)
- `style:` — Formatting, semicolons, etc.
- `chore:` — Build process, tooling, dependencies

## Development Setup

### Prerequisites

- GNOME Shell 46–51 on Wayland
- [Wayland Scroll Factor (WSF)](https://github.com/daniel-g-carrasco/wayland-scroll-factor) installed and active
- GNOME Shell Extensions app

### Local Development

1. Clone your fork:
   ```bash
   git clone git@github.com:your-username/touchpad-speed-control.git
   cd touchpad-speed-control
   ```

2. Create a symlink to your local GNOME extensions directory:
   ```bash
   ln -sf "$(pwd)" ~/.local/share/gnome-shell/extensions/touchpad-speed-control@ritesh
   ```

3. Compile the GSettings schema:
   ```bash
   glib-compile-schemas schemas/
   ```

4. Restart GNOME Shell (log out and back in on Wayland).

5. Enable the extension:
   ```bash
   gnome-extensions enable touchpad-speed-control@ritesh
   ```

6. Make changes. GNOME Shell keeps an extension's code loaded until the session ends, so:
   - changes to `extension.js`, `factorResolver.js` or `wsf.js` need a log out and back in;
   - changes to `prefs.js` apply the next time the preferences window opens:
     ```bash
     gnome-extensions prefs touchpad-speed-control@ritesh
     ```

7. Turn on **Debug logging** in the General tab, then view logs in real time:
   ```bash
   journalctl -f -o cat | grep TouchpadSpeed
   ```

### File Structure

| File | Purpose |
|------|---------|
| `extension.js` | GNOME Shell-side logic: window detection, factor resolution, WSF communication |
| `prefs.js` | Preferences UI: settings panels, app discovery, GSettings binding |
| `factorResolver.js` | Chooses an app's speed: exact ID, wildcard rules, partial match, global (shared, unit tested) |
| `wsf.js` | Finds the `wsf` binary and reads `wsf status` (shared) |
| `tests/` | Unit tests, run with `gjs -m` |
| `schemas/*.gschema.xml` | GSettings schema definition |
| `metadata.json` | Extension metadata (version, GNOME Shell compatibility) |
| `scripts/release.sh` | Checks the extension and builds the extensions.gnome.org upload ZIP |

## Code Style

### JavaScript

- Use **4-space indentation**
- Use **single quotes** for strings
- Use **JSDoc comments** for classes and public methods
- Use `const` by default, `let` when reassignment is needed — never `var`
- Place opening braces on the same line
- Use `console.log()` for debug logging with `[TouchpadSpeed]` prefix
- Use `console.error()` for errors

### Example

```javascript
/**
 * Resolves the scroll factor for a given app and axis.
 *
 * @param {string} axis - 'v' for vertical, 'h' for horizontal.
 * @param {string} appId - The application ID.
 * @returns {number} The resolved scroll factor.
 */
_resolveFactor(axis, appId) {
    const factorsKey = axis === 'v' ? 'app-factors' : 'h-app-factors';
    const factors = this._settings.get_value(factorsKey).deep_unpack();

    // Try exact match first
    const factor = factors[appId];
    if (factor !== undefined) {
        return factor;
    }

    // Fallback to global factor
    return this._settings.get_double('global-factor');
}
```

### GSettings

- New keys must be added to `schemas/org.gnome.shell.extensions.touchpad-speed-control.gschema.xml`
- Recompile after changes: `glib-compile-schemas schemas/`
- Use descriptive key names with hyphens (e.g., `global-factor`, `h-app-factors`)

## Testing Changes

Run the unit tests for the speed-matching logic (needs `gjs`, installed with GNOME):

```bash
gjs -m tests/factorResolver.test.js
```

Then test in GNOME Shell:

1. Log out and back in so GNOME Shell loads the new code.
2. Turn on **Debug logging** in the General tab and watch the log:
   ```bash
   journalctl -f -o cat | grep TouchpadSpeed
   ```
3. Move the pointer between apps with different speeds and check the applied values:
   ```bash
   wsf get
   ```

`scripts/release.sh` (below) runs the unit tests and the package checks together.

## Releasing

Always build the upload ZIP with the release script, never by hand:

```bash
scripts/release.sh --lint
```

It checks `metadata.json`, the schema, the JavaScript syntax (when `node` is installed) and the unit tests (when `gjs` is installed), builds `dist/touchpad-speed-control-v<version>.zip` from exactly the files that belong in the upload, and runs [Shexli](https://pypi.org/project/shexli/) on it. The ZIP is reproducible: the same commit always gives the same bytes. Install Shexli with:

```bash
pip install 'shexli==0.2.1' 'tree-sitter==0.25.2' 'tree-sitter-javascript==0.25.0'
```

Shexli 0.2.1 wrongly reports GNOME Shell 51 as a "future release" (`EGO-M-004`). The script accepts that one finding for the versions listed in `SHEXLI_ACCEPTED_FUTURE_VERSIONS`; any other finding fails the build.

GitHub Actions runs the same checks on every push and pull request and keeps the ZIP as a build artifact. To publish a release:

1. Increase `version` in `metadata.json` and commit it.
2. Tag the commit with the same number and push the tag:
   ```bash
   git tag v6 && git push origin v6
   ```
3. CI checks that the tag matches `version`, then creates a GitHub release with the ZIP attached.
4. Upload that ZIP at [extensions.gnome.org/upload](https://extensions.gnome.org/upload/).

## License

By contributing, you agree that your contributions will be licensed under the [GNU General Public License v3.0](LICENSE).
