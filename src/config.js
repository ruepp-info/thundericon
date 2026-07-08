/**
 * Thundericon — configuration & storage.
 *
 * Single source of truth for defaults and for reading/writing user preferences
 * in browser.storage.local. Used by the background page and the options page.
 * Publishes `globalThis.ThundericonConfig`.
 */
(function (root) {
  "use strict";

  const api = (typeof messenger !== "undefined" && messenger) ||
    (typeof browser !== "undefined" && browser) || null;

  const DEFAULTS = {
    settings: {
      enabled: true,
      layouts: { table: true, cards: true },

      // Color determination
      colorMode: "hslHash", // mutedPalette | grayscale | lowsatHsl | hslHash | fixed | customPalette
      fixedColor: "#6b7280",
      customPalette: ["#6b7280", "#7c8b73", "#b08968", "#6e8198"],

      // Initials font & styling
      fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      fontWeight: 600,
      uppercase: true,
      fontScale: 0.42, // initials font-size as a fraction of badge size

      // Badge geometry
      badgeSize: 30, // px (Table view); Cards view scales up via CSS
      borderRadius: 25, // percent (50 = circle, 0 = square)

      // Initials derivation
      initialsCount: 2, // 1 or 2
      initialsSource: "displayName", // displayName | email

      // Unread emphasis (Cards layout only) — make new/unread mail stand out
      // more strongly than Thunderbird's default bold, which is hard to see in
      // dark mode. Pure local styling (no network/privacy cost), so it's on by
      // default. `unreadStyle` selects the cues: an accent bar on the leading
      // edge of unread cards and/or fading read messages' avatars.
      unreadEmphasis: true,
      unreadStyle: "bar", // barFade | bar | dot | ring | fade
      unreadAccentColor: "#4aa9ff", // bar/ring color; bright azure, pops on dark
      unreadBarWidth: "medium", // narrow | medium | wide (accent bar thickness)
      // "glyph" style: a single character drawn where the dot sits, in the accent
      // color, with its own font / size / weight.
      unreadGlyph: "»",
      unreadGlyphFont: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      unreadGlyphSize: 14, // px
      unreadGlyphBold: false,

      // Auto-expand the attachment list in the message reader so attachments are
      // visible without clicking to expand. Pure local UI tweak (no network), so
      // it's on by default. Handled by the privileged experiment (about:message).
      attachmentsAutoExpand: true,

      // BIMI (Brand Indicators for Message Identification) — opt-in.
      bimiEnabled: false,
      bimiRefreshHours: 168, // 1 week (logos change rarely, like Gravatars)
      // Look up the logo on the sender's registrable ("base") domain instead of
      // the exact From domain, e.g. resolve test@trx.mail2.disneyplus.com against
      // disneyplus.com. Lets a brand's subdomains share one published logo.
      bimiBaseDomainOnly: true,
      // TXT lookups use Thunderbird's resolver first, then DNS-over-HTTPS (the
      // OS resolver can't do TXT). Which DoH provider to use for that fallback:
      // adguard-family | cloudflare-family | opendns-family | adguard | cloudflare |
      // opendns | quad9 | mullvad | google | custom.
      // Default to AdGuard Family Protection so DNS lookups block explicit content.
      bimiDohProvider: "adguard-family",
      bimiDohCustomUrl: "", // JSON DoH endpoint, used when provider = custom

      // Folder types to skip BIMI lookups in (own/untrusted mail). Keyed by
      // folder role; matched against the message folder's flags in the renderer.
      bimiSkipFolders: {
        sent: true,
        drafts: true,
        templates: true,
        outbox: true,
        junk: false,
        trash: false
      },

      // Gravatar profile photos — opt-in. A lookup sends a hash of the sender's
      // address to gravatar.com, so this is off by default. Photos take
      // precedence over BIMI logos. The refresh interval is much longer than
      // BIMI's: people change their Gravatar rarely.
      gravatarEnabled: false,
      gravatarRefreshHours: 168, // 1 week
      // Folder types to skip Gravatar lookups in (same roles as BIMI).
      gravatarSkipFolders: {
        sent: true,
        drafts: true,
        templates: true,
        outbox: true,
        junk: false,
        trash: false
      }
    },
    // domain -> hex override map, e.g. { "example.com": "#8a9a5b" }
    domainColors: {},
    // domain -> { status:"ok"|"none", logo:<dataURL>|null, ts:<epoch ms> }
    bimiCache: {},
    // email -> { status:"ok"|"none", logo:<dataURL>|null, ts:<epoch ms> }
    gravatarCache: {}
  };

  function deepClone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function mergeSettings(stored) {
    const out = deepClone(DEFAULTS);
    if (stored && stored.settings) {
      Object.assign(out.settings, stored.settings);
      if (stored.settings.layouts) {
        out.settings.layouts = Object.assign(
          {},
          DEFAULTS.settings.layouts,
          stored.settings.layouts
        );
      }
      if (stored.settings.bimiSkipFolders) {
        out.settings.bimiSkipFolders = Object.assign(
          {},
          DEFAULTS.settings.bimiSkipFolders,
          stored.settings.bimiSkipFolders
        );
      }
      if (stored.settings.gravatarSkipFolders) {
        out.settings.gravatarSkipFolders = Object.assign(
          {},
          DEFAULTS.settings.gravatarSkipFolders,
          stored.settings.gravatarSkipFolders
        );
      }
    }
    if (stored && stored.domainColors && typeof stored.domainColors === "object") {
      out.domainColors = deepClone(stored.domainColors);
    }
    if (stored && stored.bimiCache && typeof stored.bimiCache === "object") {
      out.bimiCache = deepClone(stored.bimiCache);
    }
    if (stored && stored.gravatarCache && typeof stored.gravatarCache === "object") {
      out.gravatarCache = deepClone(stored.gravatarCache);
    }
    return out;
  }

  /** Read the full, defaults-merged config. */
  async function load() {
    if (!api || !api.storage) {
      return deepClone(DEFAULTS);
    }
    const stored = await api.storage.local.get([
      "settings",
      "domainColors",
      "bimiCache",
      "gravatarCache"
    ]);
    return mergeSettings(stored);
  }

  /**
   * Persist a partial config. Accepts { settings?, domainColors? }; the provided
   * objects fully replace their stored counterpart (callers pass merged state).
   */
  async function save(patch) {
    if (!api || !api.storage) {
      return;
    }
    const toWrite = {};
    if (patch.settings) {
      toWrite.settings = patch.settings;
    }
    if (patch.domainColors) {
      toWrite.domainColors = patch.domainColors;
    }
    await api.storage.local.set(toWrite);
  }

  /** Subscribe to local-storage changes; returns an unsubscribe function. */
  function subscribe(callback) {
    if (!api || !api.storage || !api.storage.onChanged) {
      return () => {};
    }
    const listener = (changes, areaName) => {
      if (areaName !== "local") {
        return;
      }
      if (changes.settings || changes.domainColors) {
        load().then(callback);
      }
    };
    api.storage.onChanged.addListener(listener);
    return () => api.storage.onChanged.removeListener(listener);
  }

  root.ThundericonConfig = { DEFAULTS, load, save, subscribe, mergeSettings };
})(typeof globalThis !== "undefined" ? globalThis : this);
