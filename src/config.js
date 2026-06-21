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
      colorMode: "mutedPalette", // mutedPalette | grayscale | lowsatHsl | hslHash | fixed | customPalette
      fixedColor: "#6b7280",
      customPalette: ["#6b7280", "#7c8b73", "#b08968", "#6e8198"],

      // Initials font & styling
      fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
      fontWeight: 600,
      uppercase: true,
      fontScale: 0.42, // initials font-size as a fraction of badge size

      // Badge geometry
      badgeSize: 24, // px (Table view); Cards view scales up via CSS
      borderRadius: 50, // percent (50 = circle, 0 = square)

      // Initials derivation
      initialsCount: 2, // 1 or 2
      initialsSource: "displayName", // displayName | email

      // BIMI (Brand Indicators for Message Identification) — opt-in.
      bimiEnabled: false,
      bimiRefreshHours: 24,
      // Look up the logo on the sender's registrable ("base") domain instead of
      // the exact From domain, e.g. resolve test@trx.mail2.disneyplus.com against
      // disneyplus.com. Lets a brand's subdomains share one published logo.
      bimiBaseDomainOnly: false,
      // TXT lookups use Thunderbird's resolver first, then DNS-over-HTTPS (the
      // OS resolver can't do TXT). Which DoH provider to use for that fallback:
      bimiDohProvider: "cloudflare", // cloudflare | google | custom
      bimiDohCustomUrl: "", // JSON DoH endpoint, used when provider = custom

      // Folder types to skip BIMI lookups in (own/untrusted mail). Keyed by
      // folder role; matched against the message folder's flags in the renderer.
      bimiSkipFolders: {
        sent: true,
        drafts: true,
        templates: true,
        outbox: true,
        junk: true,
        trash: false
      }
    },
    // domain -> hex override map, e.g. { "example.com": "#8a9a5b" }
    domainColors: {},
    // domain -> { status:"ok"|"none", logo:<dataURL>|null, ts:<epoch ms> }
    bimiCache: {}
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
    }
    if (stored && stored.domainColors && typeof stored.domainColors === "object") {
      out.domainColors = deepClone(stored.domainColors);
    }
    if (stored && stored.bimiCache && typeof stored.bimiCache === "object") {
      out.bimiCache = deepClone(stored.bimiCache);
    }
    return out;
  }

  /** Read the full, defaults-merged config. */
  async function load() {
    if (!api || !api.storage) {
      return deepClone(DEFAULTS);
    }
    const stored = await api.storage.local.get(["settings", "domainColors", "bimiCache"]);
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
