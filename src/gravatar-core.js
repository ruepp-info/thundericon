/**
 * Thundericon — Gravatar helpers (pure, dependency-free).
 *
 * Gravatar serves a sender's self-published profile photo at
 * `https://gravatar.com/avatar/<hash>` where <hash> is the MD5 of the lowercased,
 * trimmed email address. Unlike BIMI there is no DNS or DMARC step — the URL is
 * fully derived from the address. These helpers build that URL and base64-encode
 * the fetched image bytes into a data: URL.
 *
 * Published as globalThis.ThundericonGravatar so it can run both in the privileged
 * experiment (via loadSubScript) and in Node unit tests. Must stay pure ES (no
 * DOM, no btoa) so `node --test` can exercise it.
 */
(function (root) {
  "use strict";

  /**
   * Normalize an address for hashing: pull the address out of a "Name <addr>"
   * string, lowercase and trim it. Returns "" for anything that isn't an email
   * (Gravatar is keyed by address, so a bare domain has no avatar).
   */
  function normalizeEmail(email) {
    let s = String(email == null ? "" : email).trim();
    const angled = s.match(/<([^>]+)>/);
    if (angled) {
      s = angled[1].trim();
    }
    s = s.toLowerCase().replace(/^mailto:/, "");
    if (!s || /\s/.test(s) || s.indexOf("@") < 0) {
      return "";
    }
    return s;
  }

  /* ---- MD5 (pure, operating on UTF-8 bytes) ----------------------------- */

  // K[i] = floor(abs(sin(i + 1)) * 2^32) — the standard MD5 sine table, computed
  // once at load rather than bundled as 64 magic constants.
  const K = (function () {
    const t = new Array(64);
    for (let i = 0; i < 64; i++) {
      t[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296);
    }
    return t;
  })();

  // Per-round left-rotate amounts.
  const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21
  ];

  function utf8Bytes(str) {
    const out = [];
    for (let i = 0; i < str.length; i++) {
      let c = str.charCodeAt(i);
      if (c < 0x80) {
        out.push(c);
      } else if (c < 0x800) {
        out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
      } else if (c >= 0xd800 && c <= 0xdbff) {
        // High surrogate — combine with the following low surrogate.
        const c2 = str.charCodeAt(++i);
        const cp = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
        out.push(
          0xf0 | (cp >> 18),
          0x80 | ((cp >> 12) & 0x3f),
          0x80 | ((cp >> 6) & 0x3f),
          0x80 | (cp & 0x3f)
        );
      } else {
        out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
      }
    }
    return out;
  }

  function rotl(x, c) {
    return (x << c) | (x >>> (32 - c));
  }

  // MD5 of a byte array → 16-byte Uint8Array digest.
  function md5bytes(bytes) {
    const len = bytes.length;
    const bitLen = len * 8;
    // Padded length: append 0x80, pad with zeros, reserve 8 bytes for the length,
    // round up to a multiple of 64.
    const total = (((len + 8) >> 6) + 1) << 6;
    const m = new Uint8Array(total);
    m.set(bytes);
    m[len] = 0x80;
    const lo = bitLen >>> 0;
    const hi = Math.floor(bitLen / 0x100000000) >>> 0;
    m[total - 8] = lo & 0xff;
    m[total - 7] = (lo >>> 8) & 0xff;
    m[total - 6] = (lo >>> 16) & 0xff;
    m[total - 5] = (lo >>> 24) & 0xff;
    m[total - 4] = hi & 0xff;
    m[total - 3] = (hi >>> 8) & 0xff;
    m[total - 2] = (hi >>> 16) & 0xff;
    m[total - 1] = (hi >>> 24) & 0xff;

    let a0 = 0x67452301;
    let b0 = 0xefcdab89 | 0;
    let c0 = 0x98badcfe | 0;
    let d0 = 0x10325476;

    const M = new Array(16);
    for (let off = 0; off < total; off += 64) {
      for (let i = 0; i < 16; i++) {
        const j = off + i * 4;
        M[i] = m[j] | (m[j + 1] << 8) | (m[j + 2] << 16) | (m[j + 3] << 24);
      }
      let A = a0;
      let B = b0;
      let C = c0;
      let D = d0;
      for (let i = 0; i < 64; i++) {
        let F;
        let g;
        if (i < 16) {
          F = (B & C) | (~B & D);
          g = i;
        } else if (i < 32) {
          F = (D & B) | (~D & C);
          g = (5 * i + 1) & 15;
        } else if (i < 48) {
          F = B ^ C ^ D;
          g = (3 * i + 5) & 15;
        } else {
          F = C ^ (B | ~D);
          g = (7 * i) & 15;
        }
        F = (F + A + K[i] + M[g]) | 0;
        A = D;
        D = C;
        C = B;
        B = (B + rotl(F, S[i])) | 0;
      }
      a0 = (a0 + A) | 0;
      b0 = (b0 + B) | 0;
      c0 = (c0 + C) | 0;
      d0 = (d0 + D) | 0;
    }

    const out = new Uint8Array(16);
    const words = [a0, b0, c0, d0];
    for (let i = 0; i < 4; i++) {
      const w = words[i];
      out[i * 4] = w & 0xff;
      out[i * 4 + 1] = (w >>> 8) & 0xff;
      out[i * 4 + 2] = (w >>> 16) & 0xff;
      out[i * 4 + 3] = (w >>> 24) & 0xff;
    }
    return out;
  }

  function bytesToHex(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) {
      s += (bytes[i] >>> 4).toString(16) + (bytes[i] & 0xf).toString(16);
    }
    return s;
  }

  /** MD5 hex digest of a string (UTF-8). */
  function md5(str) {
    return bytesToHex(md5bytes(utf8Bytes(String(str == null ? "" : str))));
  }

  /** Gravatar hash for an email address, or "" if the input isn't an address. */
  function hashEmail(email) {
    const norm = normalizeEmail(email);
    return norm ? md5(norm) : "";
  }

  /**
   * Build the avatar URL for a hash. `d=404` makes Gravatar return HTTP 404 when
   * the address has no avatar, which we treat as "no photo" (show initials).
   */
  function avatarUrl(hash, px) {
    const size = Number(px) > 0 ? Math.floor(Number(px)) : 80;
    return "https://gravatar.com/avatar/" + hash + "?s=" + size + "&d=404";
  }

  /** Standard base64-encode bytes WITH padding (for a `data:` URL). */
  function bytesToBase64(bytes) {
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let out = "";
    let i = 0;
    for (; i + 3 <= bytes.length; i += 3) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + A[(n >> 6) & 63] + A[n & 63];
    }
    const rem = bytes.length - i;
    if (rem === 1) {
      const n = bytes[i] << 16;
      out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + "==";
    } else if (rem === 2) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + A[(n >> 6) & 63] + "=";
    }
    return out;
  }

  root.ThundericonGravatar = {
    normalizeEmail,
    md5,
    hashEmail,
    avatarUrl,
    bytesToBase64
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
