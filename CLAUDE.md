# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Thundericon is a Thunderbird MailExtension that injects sender-avatar badges (initials, verified BIMI brand logos, or Gravatar profile photos) into every row of the message list, in both Table and Cards layouts.

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

The `npm test` script is `node --test test/*.test.js` — an **intentionally unquoted** glob so the POSIX shell expands it to the five real test files (Node's own glob handling for test specifiers varies by version). Do **not** change it to `node --test` (auto-discovery) or `node --test test/`: both match `options/bimi-test.js` / `options/gravatar-test.js` — the options UI scripts, whose names fit Node's `*-test.js` discovery pattern — which then throw on load and break the run.

### Versioning & releases
Version is **tag-driven**, so there is no need to hand-bump for a release. The committed `version` in `manifest.json` + `package.json` is a deliberate dummy (`0.0.0`) — don't rely on it matching releases. `tools/package.py` reads the version only from `manifest.json` and names the artifact `thundericon-<version>.xpi`; `options.js` reads the running version from the manifest at runtime. On a published GitHub Release, `.github/workflows/release.yml` derives the version from the tag (read from `github.event.release.tag_name`; `v1.2.3` or `1.2.3`), injects it into both files at build time (**not** committed back), **auto-sets `strict_max_version`** to the current Thunderbird release (from Mozilla's product-details feed), runs `npm ci && npm test`, packages, and uploads the `.xpi`. `.github/workflows/ci.yml` runs `npm ci && npm test` + `package.py` validation on every push to `main`/`master` and on PRs. Both workflows run on Node 24 (`actions/*@v5`). The `release` workflow runs from the **default branch's** copy, so its file must be on the default branch for releases to build. Full procedure: `RELEASE.md`.

### Running in Thunderbird
Use **Tools → Developer Tools → Debug Add-ons → Load Temporary Add-on…** and pick `manifest.json` (not the `.xpi`). This loads enabled and hot-reloads on edit — no rebuild needed. Release Thunderbird disables unsigned permanently-installed add-ons, so the `.xpi` is only for signing/distribution. See `README.md` for full install/verify steps.

## Architecture

### Why an Experiment API
The message list lives in the privileged `about:3pane` document, which ordinary WebExtension content scripts cannot reach. So the add-on ships a privileged **Experiment API** (`api/threadpane/`, registered in `manifest.json` under `experiment_apis`) that runs in the parent process and is the only bridge to the list. It relies on internal Thunderbird globals (`gDBView`, the thread-tree DOM) that are **not stable WebExtension API** — the renderer falls back to scraping the correspondent cell when `gDBView` is unavailable.

### Three execution contexts, one global-module pattern
There is no shared module system across the contexts, so the pure modules in `src/` each publish a single global via an IIFE (`globalThis.ThundericonCore`, `ThundericonConfig`, `ThundericonBimi`, `ThundericonGravatar`) and are loaded three different ways:
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

`mergeSettings` deep-merges stored prefs over defaults, so **stored prefs win** — changing a default in `config.js` only affects fresh installs / "Reset to defaults", not existing profiles. Adding a setting means touching `config.js` (DEFAULTS), `options.html` (control), and `options.js` (`populate`, the `scalars` list, `collectScalars`, and sometimes the matching `update*State`, e.g. `updateBimiState` / `updateGravatarState`). A new top-level persisted key (like `bimiCache`/`gravatarCache`) also needs adding to `mergeSettings` and the `load()` key list in `config.js`.

### Renderer performance contract (`injected/avatar-renderer.js`)
Runs inside `about:3pane`. Keeps the main thread free via: a single `MutationObserver` on the virtualized thread tbody; mutations coalesced and processed in idle, time-sliced batches; recycled rows tracked in a `WeakMap` keyed by a render signature so unchanged rows are skipped; decoration is idempotent. All geometry/typography comes from CSS custom properties set once on the document root (`--ti-*` in `injected/avatars.css`); only per-sender color is written per badge.

**Unread emphasis** (Cards layout only): `decorate` reads `hdr.isRead` synchronously (no host bridge), tags the card badge `ti-avatar--unread`/`ti-avatar--read` (never both; unknown/scraped rows get neither), and folds the read state into the render signature so a mark-as-read flip repaints. `applyConfig` writes the accent color (`--ti-unread-accent`), the accent-bar thickness (`--ti-unread-bar-width`, from `unreadBarWidth` → `narrow`/`medium`/`wide`), the `glyph`-style character + its font/size/weight (`--ti-unread-glyph*`; the char is emitted as a CSS-`content` quoted string via `glyphContent()`), the `fill`-style background (`--ti-unread-fill` + its contrast-picked `--ti-unread-fill-fg`, with `data-ti-fill-mode` = `fixed`/`iconColor`), and which cues to show as space-separated tokens on `:root[data-ti-unread-style]` (e.g. `"bar fade"`); the CSS rules gate on those tokens and are scoped to `tr[is="thread-card"]`, so Table view is untouched. The `bar`/`dot`/`glyph` cues all share the cell's single `td::before` — the tokens are mutually exclusive presets, so they never collide. The `fill` style instead recolours the unread badge itself (and drops its corner radius so the colour covers the whole square box, not just the rounded silhouette): fixed mode fills every unread avatar (initials get the contrast fg); icon-colour mode leaves initials on their own colour and only fills image badges (BIMI/Gravatar), which have no single colour. Live update relies on TB rewriting the card's bold text (a `characterData`/`childList` mutation) on mark-read; if a future TB flips read state via a class-only change, add a scoped `attributeFilter` to the observer.

### BIMI resolution pipeline
BIMI = a brand logo published in a DNS TXT record at `default._bimi.<domain>`, shown only for DMARC-passing mail. Split across renderer (`avatar-renderer.js`) and host (`api/threadpane/implementation.js`):

1. Renderer requests per message (keyed by message-id, cached in `bimiByMsg`) via the `__thundericonHost.resolveBimi` bridge; skips folders configured in `bimiSkipFolders`.
2. Host `_resolveBimi(domain, msgHdr)`: optional base-domain reduction (`bimiBaseDomainOnly` → `ThundericonBimi.baseDomainOf`, e.g. `mail2.disneyplus.com` → `disneyplus.com`) → **DMARC gate** (`_dmarcPass`, per-message MIME parse, memoized in `_dmarcCache`) → domain cache → fresh resolve.
3. Fresh resolve is **coalesced per domain** (`_resolveDomainFresh` + `_bimiInflight`): concurrent requests for the same domain share one DNS query. Results — **including negative "none" results** — are cached in `_bimiCache` (domain-keyed) and fired via `onBimiResolved` to `background.js`, which debounce-persists them to `storage.local` (capped at 500 entries, oldest-evicted).
4. DNS is resolved **purely over DoH** using the RFC 8484 binary wireformat (`_dohFetchWire` + the pure encoder/decoder in `bimi-core.js`). Provider list is the static `DOH_PROVIDERS` table; the JSON DoH API was removed (wireformat is universal). Privileged HTTP goes through `NetUtil` with the system principal (bypasses CORS); `_httpGet` has a `binary` mode for the wireformat response.

Set `BIMI_DEBUG = true` at the top of `implementation.js` to trace the whole chain to the Error Console (Gravatar resolution logs through the same flag). The **Test BIMI…** tool (`options/bimi-test.*`) runs the same DNS/parse/fetch path without the DMARC gate and shows a step-by-step log.

### Gravatar resolution pipeline
Gravatar = a sender's self-published profile photo, fetched from `https://gravatar.com/avatar/<md5(lowercased email)>?s=80&d=404` (`d=404` ⇒ HTTP 404 = "no photo"). It is **opt-in and off by default** (a lookup sends a hash of the sender address to gravatar.com) and **takes precedence over BIMI** (renderer order: Gravatar photo > BIMI logo > initials). Much simpler than BIMI — no DNS, no DMARC, no base-domain:

1. Renderer requests per message (keyed by message-id, cached in `gravatarByMsg`) via the `__thundericonHost.resolveGravatar(email, cb)` bridge; skips folders configured in `gravatarSkipFolders`.
2. Host `_resolveGravatar(email)`: normalize+MD5 (`src/gravatar-core.js` → `ThundericonGravatar.hashEmail`) → email-keyed cache (TTL via the shared `ThundericonBimi.isFresh`, default `gravatarRefreshHours = 168` / 1 week) → fresh resolve.
3. Fresh resolve is **coalesced per address** (`_resolveGravatarFresh` + `_gravatarInflight`). Results — **including negative "none" results** — are cached in `_gravatarCache` (email-keyed) and fired via `onGravatarResolved` to `background.js`, which debounce-persists them to `storage.local` under `gravatarCache` (capped at 500 entries, oldest-evicted).
4. The image is fetched binary through `_fetchImageDataUrl` (privileged `NetUtil`, system principal, no CORS — same `_httpGet` as BIMI, now also returning `contentType`) and base64-encoded to a `data:` URL via `ThundericonGravatar.bytesToBase64`. Rejects non-`image/*` or oversized (>64 KB) responses.

The **Test Gravatar…** tool (`options/gravatar-test.*`) runs the same hash/fetch path and shows the MD5, URL, photo and a step-by-step log.

### Attachment auto-expand
Unrelated to avatars, but hosted in the **same experiment** (`implementation.js`) because it also needs privileged access to Thunderbird's mail UI. When `settings.attachmentsAutoExpand` is on (default), the message reader's attachment list is expanded automatically so attachments are visible without clicking the twisty. It lives entirely in the host — there is **no renderer/config-bridge change** (the experiment already holds `this._config`):

1. The window listener now also covers the standalone message window (`MESSAGE_WINDOW`), not just the main 3pane. `_scanAttachments` runs alongside the existing avatar scans (`_hookWindow` + `TabOpen`/`TabSelect`).
2. `_forEachAboutMessage` finds every `about:message` document — both the standalone/tab browser and the one **nested** in `about:3pane` as `#messageBrowser` (the preview pane).
3. `_hookAttachments` installs **one** `MutationObserver` per `about:message` doc (always, even when the feature is off, so toggling it on needs no rescan). On each coalesced mutation it calls `_expandAttachments`, which is **idempotent** — it force-sets the expanded state via the reader's own `toggleAttachmentList(true)` (guarded by the `#attachmentToggle` state), so it's safe to fire repeatedly and naturally re-expands per message (each message rebuilds the list).

Everything in `_expandAttachments` (`#attachmentList`, `#attachmentToggle`, `toggleAttachmentList`) is **internal about:message DOM, not stable WebExtension API** — verify/adjust on major TB updates. Set `ATTACH_DEBUG = true` at the top of `implementation.js` to trace hooking/expanding to the Error Console.

### Tests
- `test/avatar-core.test.js`, `test/bimi-core.test.js` — pure logic (initials, colors, BIMI record parsing, base-domain, DNS wireformat encode/decode/base64url).
- `test/gravatar-core.test.js` — pure logic (MD5 vectors + Node-crypto cross-check, email normalization, the documented Gravatar hash example, avatar URL, standard base64).
- `test/config.test.js` — defaults, storage round-trip + merge, change subscription (storage mocked).
- `test/renderer.test.js` — drives `avatar-renderer.js` against a **jsdom** `about:3pane`: badge rendering, no duplicates, virtualized-row recycling, BIMI/Gravatar image swap-in, Gravatar-over-BIMI precedence, DMARC gate, folder skipping, `destroy()`.

The privileged experiment (`api/threadpane/implementation.js`) is **not** unit-testable — it needs Gecko. Verify those changes in a live Thunderbird (temporary load + Test BIMI / Test Gravatar / Error Console; for attachment auto-expand, open a message with attachments and confirm the list is expanded).
