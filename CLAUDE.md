# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Thundericon is a Thunderbird MailExtension that injects sender-avatar badges (initials, or verified BIMI brand logos) into every row of the message list, in both Table and Cards layouts.

## Commands

```sh
npm test                                   # run the full suite (node --test)
node --test test/bimi-core.test.js         # run a single test file
node --test --test-name-pattern="baseDomain"  # run tests matching a name

./build.sh            # validate + package -> dist/thundericon-<version>.xpi
./build.sh --test     # run the test suite before packaging
./build.sh --clean    # wipe dist/ first
npm run package       # python3 tools/package.py: validate + zip only (no icons/tests)
```

`build.sh`/`package.py` abort non-zero if the manifest is invalid or references a missing file, so a broken add-on is never produced. `dist/` is gitignored and rebuilt by `tools/package.py`.

There is **no linter** configured. Match the surrounding style (the codebase is heavily commented, explaining the *why*).

The `npm test` script is `node --test test/*.test.js` — an **intentionally unquoted** glob so the POSIX shell expands it (Node only self-expands glob patterns from v21+, and CI runs Node 20). Do **not** change it to `node --test` (auto-discovery) or `node --test test/`: both match `options/bimi-test.js` — the options UI script, whose name fits Node's `*-test.js` discovery pattern — which then throws on load and breaks the run.

### Versioning & releases
Version is **tag-driven**, so there is no need to hand-bump for a release. `tools/package.py` reads the version only from `manifest.json` and names the artifact `thundericon-<version>.xpi`; `options.js` reads the running version from the manifest at runtime. On a published GitHub Release, `.github/workflows/release.yml` derives the version from the tag (`v1.2.3` or `1.2.3`), injects it into `manifest.json` + `package.json` at build time (**not** committed back), runs `npm ci && npm test`, packages, and uploads the `.xpi` to the release. The committed version strings are therefore dev placeholders — don't rely on them matching releases. `.github/workflows/ci.yml` runs `npm ci && npm test` + `package.py` validation on every push to `main`/`master` and on PRs. The `release` workflow runs from the **default branch's** copy, so its file must be on the default branch for releases to build.

### Running in Thunderbird
Use **Tools → Developer Tools → Debug Add-ons → Load Temporary Add-on…** and pick `manifest.json` (not the `.xpi`). This loads enabled and hot-reloads on edit — no rebuild needed. Release Thunderbird disables unsigned permanently-installed add-ons, so the `.xpi` is only for signing/distribution. See `README.md` for full install/verify steps.

## Architecture

### Why an Experiment API
The message list lives in the privileged `about:3pane` document, which ordinary WebExtension content scripts cannot reach. So the add-on ships a privileged **Experiment API** (`api/threadpane/`, registered in `manifest.json` under `experiment_apis`) that runs in the parent process and is the only bridge to the list. It relies on internal Thunderbird globals (`gDBView`, the thread-tree DOM) that are **not stable WebExtension API** — the renderer falls back to scraping the correspondent cell when `gDBView` is unavailable.

### Three execution contexts, one global-module pattern
There is no shared module system across the contexts, so the pure modules in `src/` each publish a single global via an IIFE (`globalThis.ThundericonCore`, `ThundericonConfig`, `ThundericonBimi`) and are loaded three different ways:
- **background page** — via `<script>` in `manifest.json` (`src/config.js`)
- **options page** — via `<script>` tags in `options/options.html`
- **privileged renderer + experiment** — via `Services.scriptloader.loadSubScript(...)`

Consequence: code in `src/*.js` must be portable to all three (plain ES, no `btoa`/DOM/browser-only deps) so it also runs under `node --test`. Anything that needs the network, DOM, or Gecko internals belongs in the experiment or the renderer, **not** in `src/`.

### Config flow (live updates, no restart)
`src/config.js` is the single source of truth for `DEFAULTS` and all `storage.local` access. Round-trip:

```
options.js writes storage.local
  -> ThundericonConfig.subscribe (fires only on settings/domainColors changes)
  -> background.js relays to experiment.updateConfig
  -> experiment._broadcast()  -> each renderer's __thundericon.apply(json)
```

`mergeSettings` deep-merges stored prefs over defaults, so **stored prefs win** — changing a default in `config.js` only affects fresh installs / "Reset to defaults", not existing profiles. Adding a setting means touching `config.js` (DEFAULTS), `options.html` (control), and `options.js` (`populate`, the `scalars` list, `collectScalars`, and sometimes `updateBimiState`).

### Renderer performance contract (`injected/avatar-renderer.js`)
Runs inside `about:3pane`. Keeps the main thread free via: a single `MutationObserver` on the virtualized thread tbody; mutations coalesced and processed in idle, time-sliced batches; recycled rows tracked in a `WeakMap` keyed by a render signature so unchanged rows are skipped; decoration is idempotent. All geometry/typography comes from CSS custom properties set once on the document root (`--ti-*` in `injected/avatars.css`); only per-sender color is written per badge.

### BIMI resolution pipeline
BIMI = a brand logo published in a DNS TXT record at `default._bimi.<domain>`, shown only for DMARC-passing mail. Split across renderer (`avatar-renderer.js`) and host (`api/threadpane/implementation.js`):

1. Renderer requests per message (keyed by message-id, cached in `bimiByMsg`) via the `__thundericonHost.resolveBimi` bridge; skips folders configured in `bimiSkipFolders`.
2. Host `_resolveBimi(domain, msgHdr)`: optional base-domain reduction (`bimiBaseDomainOnly` → `ThundericonBimi.baseDomainOf`, e.g. `mail2.disneyplus.com` → `disneyplus.com`) → **DMARC gate** (`_dmarcPass`, per-message MIME parse, memoized in `_dmarcCache`) → domain cache → fresh resolve.
3. Fresh resolve is **coalesced per domain** (`_resolveDomainFresh` + `_bimiInflight`): concurrent requests for the same domain share one DNS query. Results — **including negative "none" results** — are cached in `_bimiCache` (domain-keyed) and fired via `onBimiResolved` to `background.js`, which debounce-persists them to `storage.local` (capped at 500 entries, oldest-evicted).
4. DNS is resolved **purely over DoH** using the RFC 8484 binary wireformat (`_dohFetchWire` + the pure encoder/decoder in `bimi-core.js`). Provider list is the static `DOH_PROVIDERS` table; the JSON DoH API was removed (wireformat is universal). Privileged HTTP goes through `NetUtil` with the system principal (bypasses CORS); `_httpGet` has a `binary` mode for the wireformat response.

Set `BIMI_DEBUG = true` at the top of `implementation.js` to trace the whole chain to the Error Console. The **Test BIMI…** tool (`options/bimi-test.*`) runs the same DNS/parse/fetch path without the DMARC gate and shows a step-by-step log.

### Tests
- `test/avatar-core.test.js`, `test/bimi-core.test.js` — pure logic (initials, colors, BIMI record parsing, base-domain, DNS wireformat encode/decode/base64url).
- `test/config.test.js` — defaults, storage round-trip + merge, change subscription (storage mocked).
- `test/renderer.test.js` — drives `avatar-renderer.js` against a **jsdom** `about:3pane`: badge rendering, no duplicates, virtualized-row recycling, BIMI logo swap-in, DMARC gate, folder skipping, `destroy()`.

The privileged experiment (`api/threadpane/implementation.js`) is **not** unit-testable — it needs Gecko. Verify those changes in a live Thunderbird (temporary load + Test BIMI / Error Console).
