#!/usr/bin/env bash
# Builds and checks the extensions.gnome.org upload ZIP.
#
# Usage: scripts/release.sh [options]
#   -o, --output PATH         Write the ZIP here (default: dist/touchpad-speed-control-v<version>.zip)
#   --lint                    Require Shexli and gjs (fail if either is missing)
#   --require-clean           Fail if release files differ from the last commit
#   --expect-version N        Fail unless metadata.json "version" is N (used for tag releases)
#   -h, --help                Show this help
#
# The ZIP is reproducible: the same commit always produces the same bytes.
set -euo pipefail

cd "$(dirname "$0")/.."

# The exact files uploaded to extensions.gnome.org. Icons, install.sh and the
# compiled schema are deliberately left out (earlier GNOME review feedback).
RELEASE_FILES=(
    CONTRIBUTING.md
    LICENSE
    README.md
    calibration.js
    extension.js
    factorResolver.js
    metadata.json
    prefs.js
    scrollShift.js
    schemas/org.gnome.shell.extensions.touchpad-speed-control.gschema.xml
    wsf.js
)

# Shell versions Shexli wrongly reports as "implausible future releases"
# (Shexli 0.2.1 treats every major version above 50 as future). An EGO-M-004
# finding is accepted only when these are the sole versions above 50.
# Remove entries once Shexli knows about them.
SHEXLI_ACCEPTED_FUTURE_VERSIONS="51"

output=""
lint=false
require_clean=false
expect_version=""

while [ $# -gt 0 ]; do
    case "$1" in
        -o|--output) output="$2"; shift 2 ;;
        --lint) lint=true; shift ;;
        --require-clean) require_clean=true; shift ;;
        --expect-version) expect_version="$2"; shift 2 ;;
        -h|--help) sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $1" >&2; exit 2 ;;
    esac
done

step() { printf '\n==> %s\n' "$1"; }
fail() { printf 'ERROR: %s\n' "$1" >&2; exit 1; }

for tool in python3 zip glib-compile-schemas; do
    command -v "$tool" >/dev/null || fail "$tool is required"
done

step "Checking metadata.json"
version=$(python3 - "$expect_version" <<'EOF'
import json, re, sys
expect = sys.argv[1]
try:
    md = json.load(open('metadata.json', encoding='utf-8'))
except ValueError as e:
    sys.exit(f'ERROR: metadata.json is not valid JSON: {e}')
errors = []
for key in ('uuid', 'name', 'description', 'version', 'shell-version', 'url', 'settings-schema'):
    if key not in md:
        errors.append(f'missing "{key}"')
if md.get('uuid') != 'touchpad-speed-control@ritesh':
    errors.append('unexpected uuid')
if not isinstance(md.get('version'), int) or isinstance(md.get('version'), bool):
    errors.append('"version" must be an integer')
versions = md.get('shell-version', [])
if not versions or not all(isinstance(v, str) and re.fullmatch(r'\d+', v) for v in versions):
    errors.append('"shell-version" must be a non-empty list of major versions like "50"')
elif [int(v) for v in versions] != sorted({int(v) for v in versions}):
    errors.append('"shell-version" must be ascending without duplicates')
if expect and str(md.get('version')) != expect:
    errors.append(f'version is {md.get("version")}, expected {expect}')
if errors:
    sys.exit('ERROR: metadata.json: ' + '; '.join(errors))
schema = open(f'schemas/{md["settings-schema"]}.gschema.xml', encoding='utf-8').read()
if f'id="{md["settings-schema"]}"' not in schema:
    sys.exit('ERROR: settings-schema id not found in the schema file')
print(md['version'])
EOF
)
echo "version $version"

step "Checking schema"
glib-compile-schemas --strict --dry-run schemas/
echo "ok"

step "Checking JavaScript syntax"
if command -v node >/dev/null; then
    tmp_js=$(mktemp -d)
    trap 'rm -rf "$tmp_js"' EXIT
    for f in $(printf '%s\n' "${RELEASE_FILES[@]}" | grep '\.js$'); do
        # .mjs makes node parse the file as an ES module without resolving imports
        cp "$f" "$tmp_js/$(basename "$f" .js).mjs"
        node --check "$tmp_js/$(basename "$f" .js).mjs" || fail "syntax error in $f"
    done
    echo "ok"
else
    echo "skipped (node not installed)"
fi

step "Running unit tests"
if command -v gjs >/dev/null; then
    for t in tests/*.test.js; do
        gjs -m "$t" || fail "unit tests failed: $t"
    done
elif $lint; then
    fail "gjs is required for the unit tests"
else
    echo "skipped (gjs not installed)"
fi

if $require_clean; then
    step "Checking that release files are committed"
    if ! git diff --quiet HEAD -- "${RELEASE_FILES[@]}"; then
        git status --short -- "${RELEASE_FILES[@]}"
        fail "release files have uncommitted changes"
    fi
    echo "ok"
fi

step "Building ZIP"
[ -n "$output" ] || output="dist/touchpad-speed-control-v${version}.zip"
mkdir -p "$(dirname "$output")"
output=$(cd "$(dirname "$output")" && pwd)/$(basename "$output")

stage=$(mktemp -d)
trap 'rm -rf "$stage" ${tmp_js:+"$tmp_js"}' EXIT
for f in "${RELEASE_FILES[@]}"; do
    [ -f "$f" ] || fail "missing release file: $f"
    mkdir -p "$stage/$(dirname "$f")"
    cp "$f" "$stage/$f"
done

# Fixed permissions and timestamps make the archive reproducible, and avoid
# executable bits from filesystems like exFAT ending up in the upload.
epoch=$(git log -1 --format=%ct 2>/dev/null || date +%s)
find "$stage" -type d -exec chmod 755 {} +
find "$stage" -type f -exec chmod 644 {} +
find "$stage" -exec touch -h -d "@$epoch" {} +

rm -f "$output"
(cd "$stage" && printf '%s\n' "${RELEASE_FILES[@]}" | LC_ALL=C sort | TZ=UTC zip -q -X -D "$output" -@)
unzip -l "$output"

step "Running Shexli"
if command -v shexli >/dev/null; then
    shexli --format json "$output" > "$stage/shexli.json" || true
    python3 - "$stage/shexli.json" "$SHEXLI_ACCEPTED_FUTURE_VERSIONS" <<'EOF'
import json, re, sys
report = json.load(open(sys.argv[1]))
accepted = set(sys.argv[2].split())
blocking = []
for f in report.get('findings', []):
    label = f'{f["rule_id"]} ({f["severity"]}): {f["message"]}'
    if f['rule_id'] == 'EGO-M-004':
        snippet = ' '.join(e.get('snippet') or '' for e in f.get('evidence', []))
        above_50 = {v for v in re.findall(r"'(\d+)'", snippet) if int(v) > 50}
        if above_50 and above_50 <= accepted:
            print(f'accepted: {label} [known Shexli gap for {", ".join(sorted(above_50))}]')
            continue
    blocking.append(label)
    print(f'FINDING: {label}')
    for e in f.get('evidence', []):
        print(f'    {e.get("path")}: {e.get("snippet") or ""}')
if blocking:
    sys.exit(f'ERROR: Shexli reported {len(blocking)} blocking finding(s)')
print('ok')
EOF
elif $lint; then
    fail "shexli is not installed (pip install shexli 'tree-sitter<0.26')"
else
    echo "skipped (shexli not installed; use --lint to require it)"
fi

step "Done"
sha256sum "$output"
