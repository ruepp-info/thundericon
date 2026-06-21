# Releasing Thundericon

Releases are **tag-driven and automated**. You publish a GitHub Release with a
version tag; the `.github/workflows/release.yml` workflow then tests, builds the
`.xpi` with that version baked in, and attaches it to the release. **You never
hand-edit the version in the source files for a release** — the tag is the single
source of truth.

## TL;DR

```sh
# from the default branch, fully pushed:
gh release create v1.2.3 --title "1.2.3" --notes "What changed in this release"
```

Wait ~1 minute, then `thundericon-1.2.3.xpi` appears under the release's **Assets**.

## Versioning rules

- The tag is the version. `v1.2.3` and `1.2.3` are both accepted (a leading `v`
  is stripped). Anything that is not `MAJOR.MINOR.PATCH` aborts the build.
- Versions must **increase** over time. addons.thunderbird.net (ATN) rejects a
  re-used or lower version, and Thunderbird won't "upgrade" to an equal version.
- The `version` strings committed in `manifest.json` and `package.json` are just
  dev placeholders — the workflow overwrites them at build time and does **not**
  commit the change back. Don't rely on the committed values matching releases.

## Before you release

1. **Be on the default branch and pushed.** GitHub runs `release.yml` from the
   **default branch's** copy, and the build checks out the tag's commit — so the
   workflow file *and* the code you want to ship must be on the default branch
   and pushed to GitHub.
2. **Green CI.** `ci.yml` runs `npm ci && npm test` + manifest validation on every
   push/PR. Make sure the latest commit passed before tagging.
3. **Thunderbird compatibility is automatic.** Because this is an Experiment
   add-on, `manifest.json` must pin `strict_max_version`. The release workflow sets
   it to the current Thunderbird release at build time (`<major>.*`, read from
   Mozilla's product-details feed), so it never goes stale — you don't bump it by
   hand. The committed value is only a fallback for local builds and if the feed is
   unreachable. Caveat: this declares compatibility with the latest Thunderbird, so
   ideally smoke-test on it (step 4) since an Experiment can break when internal
   APIs change. `strict_min_version` is still set by hand.
4. *(Optional)* **Smoke-test the build locally:** `./build.sh --test` produces
   `dist/thundericon-<version>.xpi` from the committed version, so you can load it
   in Thunderbird before cutting the release.

## Creating the release

### Option A — GitHub web UI

1. Repo → **Releases** → **Draft a new release**.
2. **Choose a tag** → type the new version (e.g. `v1.2.3`) →
   **Create new tag on publish**, targeting the default branch.
3. Add a title and release notes.
4. **Publish release**.

### Option B — `gh` CLI

```sh
gh release create v1.2.3 --title "1.2.3" --notes "What changed"
# or let GitHub draft notes from commits:
gh release create v1.2.3 --generate-notes
```

## What the pipeline does (`release.yml`)

On **Release → published** it:

1. Derives the version from the tag (and fails fast if it isn't semver).
2. Runs `npm ci && npm test`.
3. Injects the version into `manifest.json` + `package.json` (build-time only).
4. Builds `dist/thundericon-<version>.xpi` via `tools/package.py`.
5. Uploads the `.xpi` to the release with `gh release upload --clobber`.

If any step fails, **no asset is attached** — check the **Actions** tab.

## If something goes wrong

- **Fix and re-run:** push the fix, then re-run the failed job from the **Actions**
  tab (it rebuilds from the same tag). `--clobber` means a re-run overwrites a
  stale asset instead of erroring.
- **Wrong/missing version in the tag:** delete the release *and* its tag, then
  recreate with the correct tag. (Deleting only the release leaves the tag behind.)

## Signing / distribution

The attached `.xpi` is **unsigned**. It's fine for temporary-load development and
self-distribution, but **permanent install on release Thunderbird requires signing**
via [addons.thunderbird.net](https://addons.thunderbird.net). That's a separate,
manual step and is not part of this pipeline.
