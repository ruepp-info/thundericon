#!/usr/bin/env python3
"""Validate and bundle Thundericon into an installable .xpi (no external deps).

Usage: python3 tools/package.py

Validates the manifest and every file it references, then writes
dist/thundericon-<version>.xpi with manifest.json at the archive root.
Exits non-zero if validation fails (so a broken add-on is never produced).
"""
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

# Only these are shipped in the .xpi; tooling/tests/node_modules stay out.
INCLUDE_DIRS = ("api", "injected", "src", "options", "icons", "_locales")
INCLUDE_FILES = ("manifest.json", "background.js")
EXCLUDE_NAMES = {".DS_Store", "Thumbs.db"}


def load_json(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def included_files():
    """Repo-relative paths that go into the archive."""
    seen = []
    for name in INCLUDE_FILES:
        if os.path.isfile(os.path.join(ROOT, name)):
            seen.append(name)
    for d in INCLUDE_DIRS:
        base = os.path.join(ROOT, d)
        for dirpath, _dirs, files in os.walk(base):
            for fn in sorted(files):
                if fn in EXCLUDE_NAMES:
                    continue
                seen.append(os.path.relpath(os.path.join(dirpath, fn), ROOT))
    return sorted(set(seen))


def referenced_files(manifest):
    """Repo-relative paths the manifest points at (must all exist)."""
    refs = set(manifest.get("background", {}).get("scripts", []))
    page = manifest.get("options_ui", {}).get("page")
    if page:
        refs.add(page)
    for api in manifest.get("experiment_apis", {}).values():
        if api.get("schema"):
            refs.add(api["schema"])
        script = api.get("parent", {}).get("script")
        if script:
            refs.add(script)
    refs.update(manifest.get("icons", {}).values())
    loc = manifest.get("default_locale")
    if loc:
        refs.add(f"_locales/{loc}/messages.json")
    return sorted(refs)


def validate():
    errors = []
    manifest_path = os.path.join(ROOT, "manifest.json")
    if not os.path.isfile(manifest_path):
        return ["manifest.json not found"], None
    try:
        manifest = load_json(manifest_path)
    except Exception as e:  # noqa: BLE001
        return [f"manifest.json is not valid JSON: {e}"], None

    if manifest.get("manifest_version") != 3:
        errors.append("manifest_version must be 3")
    if not manifest.get("version"):
        errors.append("manifest is missing a version")

    packaged = set(included_files())
    for rel in referenced_files(manifest):
        if not os.path.isfile(os.path.join(ROOT, rel)):
            errors.append(f"referenced file missing on disk: {rel}")
        elif rel not in packaged:
            errors.append(f"referenced file not included in package: {rel}")

    for rel in packaged:
        if rel.endswith(".json"):
            try:
                load_json(os.path.join(ROOT, rel))
            except Exception as e:  # noqa: BLE001
                errors.append(f"invalid JSON: {rel}: {e}")

    return errors, manifest


def build(version):
    dist = os.path.join(ROOT, "dist")
    os.makedirs(dist, exist_ok=True)
    out = os.path.join(dist, f"thundericon-{version}.xpi")
    files = included_files()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for rel in files:
            z.write(os.path.join(ROOT, rel), rel)
    return out, len(files)


def main():
    print("Validating…")
    errors, manifest = validate()
    if errors:
        for e in errors:
            print(f"  ✗ {e}")
        print(f"\nBuild aborted: {len(errors)} problem(s).")
        sys.exit(1)
    print("  ✓ manifest, references and JSON OK")

    version = manifest.get("version", "0.0.0")
    out, count = build(version)
    size = os.path.getsize(out) / 1024
    print(f"  ✓ packaged {count} files ({size:.1f} KiB)")
    print(f"\n→ {os.path.relpath(out, ROOT)}")


if __name__ == "__main__":
    main()
