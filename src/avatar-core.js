/**
 * Thundericon — shared avatar core.
 *
 * Pure, dependency-free logic for turning a sender into (initials + color).
 * Loaded in three contexts that do NOT share a module system:
 *   - the injected renderer inside about:3pane (via loadSubScript)
 *   - the options page (via <script>)
 *   - the background page (via <script>/import)
 * so it publishes a single global: `globalThis.ThundericonCore`.
 */
(function (root) {
  "use strict";

  /** Curated muted / neutral palette (the default look). Lower-case so that all
   *  color modes emit canonical, comparable hex strings. */
  const MUTED_PALETTE = [
    "#6b7280", // slate
    "#7c8b73", // sage
    "#b08968", // clay
    "#6e8198", // dusty blue
    "#9a8c98", // mauve
    "#a3937c", // taupe
    "#7d8ca3", // steel
    "#88927d"  // olive-gray
  ];

  /** Deterministic, fast string hash (FNV-1a 32-bit) → unsigned int. */
  function hashString(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      // h *= 16777619, kept in 32-bit unsigned range without BigInt
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  /** Parse an RFC5322-ish author header into { name, email }. */
  function parseSender(author) {
    const result = { name: "", email: "" };
    if (!author || typeof author !== "string") {
      return result;
    }
    const raw = author.trim();

    // "Display Name <user@host>" or "<user@host>"
    const angle = raw.match(/^(.*?)<([^<>]+)>\s*$/);
    if (angle) {
      result.name = stripQuotes(angle[1].trim());
      result.email = angle[2].trim().toLowerCase();
      if (!result.name) {
        result.name = localPart(result.email);
      }
      return result;
    }

    // Bare address with no display name.
    if (/^[^\s@]+@[^\s@]+$/.test(raw)) {
      result.email = raw.toLowerCase();
      result.name = localPart(result.email);
      return result;
    }

    // Just a display name (no parsable address).
    result.name = stripQuotes(raw);
    return result;
  }

  function stripQuotes(s) {
    return s.replace(/^"(.*)"$/, "$1").trim();
  }

  function localPart(email) {
    const at = email.indexOf("@");
    return at > 0 ? email.slice(0, at) : email;
  }

  function domainOf(email) {
    const at = email.indexOf("@");
    return at >= 0 ? email.slice(at + 1).toLowerCase() : "";
  }

  /** A stable key identifying a sender (prefer email, fall back to name). */
  function senderKey(name, email) {
    return (email || name || "").trim().toLowerCase();
  }

  /**
   * Derive initials.
   * @param {string} name  display name (may be empty)
   * @param {string} email sender email (may be empty)
   * @param {object} opts  { count: 1|2, source: "displayName"|"email", uppercase: bool }
   */
  function getInitials(name, email, opts) {
    const count = opts && opts.count === 1 ? 1 : 2;
    const uppercase = !opts || opts.uppercase !== false;
    const preferEmail = opts && opts.source === "email";

    let source = preferEmail ? (email || name) : (name || email);
    source = (source || "").trim();
    if (!source) {
      return "?";
    }

    // If the chosen source is an email address, use its local part.
    if (/@/.test(source)) {
      source = localPart(source.toLowerCase());
    }

    // Split on whitespace and common name separators.
    const words = source
      .split(/[\s._\-]+/)
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
      .filter(Boolean);

    let initials;
    if (words.length >= 2 && count === 2) {
      initials = firstChar(words[0]) + firstChar(words[words.length - 1]);
    } else if (words.length >= 1) {
      const w = words[0];
      initials = count === 2 ? (w.slice(0, 2) || firstChar(w)) : firstChar(w);
    } else {
      initials = firstChar(source);
    }

    return uppercase ? initials.toUpperCase() : initials;
  }

  function firstChar(s) {
    // Use spread to be surrogate-pair safe for the first glyph.
    return s ? [...s][0] || "" : "";
  }

  /* ---- color modes ------------------------------------------------------ */

  function hslToHex(h, s, l) {
    s /= 100;
    l /= 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const color = l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
      return Math.round(255 * color);
    };
    return rgbToHex(f(0), f(8), f(4));
  }

  function rgbToHex(r, g, b) {
    const to2 = (v) => v.toString(16).padStart(2, "0");
    return "#" + to2(r) + to2(g) + to2(b);
  }

  /**
   * Resolve the badge background color for a sender.
   * @param {string} name
   * @param {string} email
   * @param {object} settings    user settings (colorMode, fixedColor, customPalette)
   * @param {object} domainColors map of domain -> hex (overrides everything)
   */
  function getColor(name, email, settings, domainColors) {
    settings = settings || {};

    // Domain override always wins.
    if (domainColors && email) {
      const dom = domainOf(email);
      if (dom && Object.prototype.hasOwnProperty.call(domainColors, dom)) {
        const c = normalizeHex(domainColors[dom]);
        if (c) {
          return c;
        }
      }
    }

    const key = senderKey(name, email);
    const hash = hashString(key || "?");

    switch (settings.colorMode) {
      case "fixed":
        return normalizeHex(settings.fixedColor) || MUTED_PALETTE[0];

      case "customPalette": {
        const palette = (settings.customPalette || [])
          .map(normalizeHex)
          .filter(Boolean);
        const pool = palette.length ? palette : MUTED_PALETTE;
        return pool[hash % pool.length];
      }

      case "grayscale": {
        // Spread across a comfortable mid-gray ramp (lightness 38–66%).
        const l = 38 + (hash % 29);
        return hslToHex(0, 0, l);
      }

      case "lowsatHsl": {
        const h = hash % 360;
        const s = 22 + (hash % 14); // 22–35%
        const l = 55 + ((hash >> 3) % 8); // 55–62%
        return hslToHex(h, s, l);
      }

      case "hslHash": {
        const h = hash % 360;
        const s = 60 + (hash % 16); // 60–75%
        const l = 50 + ((hash >> 3) % 10); // 50–59%
        return hslToHex(h, s, l);
      }

      case "mutedPalette":
      default:
        return MUTED_PALETTE[hash % MUTED_PALETTE.length];
    }
  }

  /** Accept "#abc", "#aabbcc", "abc", "aabbcc" → "#aabbcc" (or null). */
  function normalizeHex(value) {
    if (typeof value !== "string") {
      return null;
    }
    let v = value.trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{3}$/.test(v)) {
      v = v.split("").map((c) => c + c).join("");
    }
    if (/^[0-9a-fA-F]{6}$/.test(v)) {
      return "#" + v.toLowerCase();
    }
    return null;
  }

  /** Choose a legible foreground for a hex background using WCAG luminance. */
  function pickForeground(hex) {
    const h = normalizeHex(hex) || "#000000";
    const r = parseInt(h.slice(1, 3), 16) / 255;
    const g = parseInt(h.slice(3, 5), 16) / 255;
    const b = parseInt(h.slice(5, 7), 16) / 255;
    const lin = (c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const L = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
    return L > 0.55 ? "#1f2933" : "#ffffff";
  }

  /** Parse a hex ("#abc"/"#aabbcc") or rgb()/rgba() string into {r,g,b,a}. The
   *  rgb() forms are needed because folder-pane colours come from getComputedStyle,
   *  which resolves to "rgb(…)" / "rgba(…)". Returns null if unparseable. */
  function parseColor(value) {
    if (typeof value !== "string") {
      return null;
    }
    const hex = normalizeHex(value);
    if (hex) {
      return {
        r: parseInt(hex.slice(1, 3), 16),
        g: parseInt(hex.slice(3, 5), 16),
        b: parseInt(hex.slice(5, 7), 16),
        a: null
      };
    }
    const m = value.trim().match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
      const parts = m[1].split(/[,\s/]+/).filter(Boolean);
      const r = parseFloat(parts[0]);
      const g = parseFloat(parts[1]);
      const b = parseFloat(parts[2]);
      const a = parts.length >= 4 ? parseFloat(parts[3]) : null;
      if ([r, g, b].every(Number.isFinite)) {
        return { r, g, b, a: a != null && Number.isFinite(a) ? a : null };
      }
    }
    return null;
  }

  /**
   * Lighten or darken a colour by `amount` (-100…100). 0 (or unparseable input)
   * returns the colour unchanged. Positive mixes toward white, negative toward
   * black — the standard tint/shade, so it works on any hue. Preserves an alpha
   * channel (returns rgba); otherwise returns "#rrggbb".
   */
  function adjustBrightness(color, amount) {
    const amt = Number(amount);
    if (!Number.isFinite(amt) || amt === 0) {
      return color;
    }
    const c = parseColor(color);
    if (!c) {
      return color;
    }
    const p = Math.max(-100, Math.min(100, amt)) / 100;
    const mix = (ch) => (p > 0 ? ch + (255 - ch) * p : ch * (1 + p));
    const clamp = (n) => Math.max(0, Math.min(255, Math.round(n)));
    const r = clamp(mix(c.r));
    const g = clamp(mix(c.g));
    const b = clamp(mix(c.b));
    if (c.a != null) {
      return "rgba(" + r + ", " + g + ", " + b + ", " + c.a + ")";
    }
    return rgbToHex(r, g, b);
  }

  /** Convenience: everything needed to render one badge. */
  function describe(author, settings, domainColors) {
    const { name, email } = parseSender(author);
    const bg = getColor(name, email, settings, domainColors);
    return {
      name,
      email,
      key: senderKey(name, email),
      initials: getInitials(name, email, {
        count: settings && settings.initialsCount,
        source: settings && settings.initialsSource,
        uppercase: settings ? settings.uppercase !== false : true
      }),
      background: bg,
      foreground: pickForeground(bg)
    };
  }

  root.ThundericonCore = {
    MUTED_PALETTE,
    hashString,
    parseSender,
    senderKey,
    domainOf,
    getInitials,
    getColor,
    pickForeground,
    normalizeHex,
    adjustBrightness,
    hslToHex,
    describe
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
