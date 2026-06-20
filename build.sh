#!/usr/bin/env bash
#
# Build Thundericon into an installable .xpi for Thunderbird.
#
#   ./build.sh            validate + package -> dist/thundericon-<version>.xpi
#   ./build.sh --test     run the test suite first
#   ./build.sh --icons    force-regenerate the PNG icons
#   ./build.sh --clean    remove dist/ before building
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

run_tests=0
force_icons=0
clean=0

usage() {
  sed -n '3,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

for arg in "$@"; do
  case "$arg" in
    -t|--test)  run_tests=1 ;;
    -i|--icons) force_icons=1 ;;
    -c|--clean) clean=1 ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

command -v python3 >/dev/null 2>&1 || { echo "Error: python3 is required." >&2; exit 1; }

echo "Thundericon · build"
echo "==================="

# 1. Icons — generate if missing (or forced).
if [ "$force_icons" -eq 1 ] || [ ! -f icons/icon-128.png ]; then
  echo "→ Generating icons"
  python3 tools/make-icons.py
fi

# 2. Tests (optional).
if [ "$run_tests" -eq 1 ]; then
  if command -v npm >/dev/null 2>&1; then
    echo "→ Running tests"
    npm test
  else
    echo "Warning: npm not found; skipping tests." >&2
  fi
fi

# 3. Clean.
if [ "$clean" -eq 1 ]; then
  echo "→ Cleaning dist/"
  rm -rf dist
fi

# 4. Validate + package (aborts on any manifest/reference problem).
echo "→ Packaging"
python3 tools/package.py

xpi="$(ls -t dist/*.xpi 2>/dev/null | head -1 || true)"

cat <<EOF

Done. Install in Thunderbird:

  • Temporary (dev, recommended):
      Tools → Developer Tools → Debug Add-ons → "Load Temporary Add-on…"
      and pick:  $ROOT/manifest.json
      (loads directly from source; re-pick to reload after edits)

  • From the packaged .xpi:
      Add-ons Manager (Tools → Add-ons and Themes) → gear ⚙ → "Install Add-on From File…"
      and pick:  ${xpi:-dist/thundericon-<version>.xpi}
      Note: installing an unsigned .xpi permanently requires a Daily/Developer build,
      or set xpinstall.signatures.required = false in the Config Editor.
EOF
