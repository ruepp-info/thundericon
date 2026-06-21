/**
 * Thundericon — BIMI helpers (pure, dependency-free).
 *
 * Parses BIMI DNS records and DMARC results, plus a small cache-freshness check.
 * Published as globalThis.ThundericonBimi so it can run both in the privileged
 * experiment (via loadSubScript) and in Node unit tests.
 *
 * BIMI = Brand Indicators for Message Identification: a domain publishes a logo
 * URL in a DNS TXT record at `default._bimi.<domain>`. The logo should only be
 * shown for messages that passed DMARC (this MVP does not verify the VMC).
 */
(function (root) {
  "use strict";

  /**
   * Parse a BIMI TXT record string into its tags.
   * @returns {{version:string, logoUrl:string, vmcUrl:string}|null}
   *          logoUrl is "" when the domain declined or it isn't a valid https URL.
   */
  function parseBimiRecord(txt) {
    if (typeof txt !== "string") {
      return null;
    }
    const trimmed = txt.trim();
    if (!/^v\s*=\s*BIMI1\b/i.test(trimmed)) {
      return null;
    }
    const tags = {};
    for (const part of trimmed.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) {
        continue;
      }
      const key = part.slice(0, eq).trim().toLowerCase();
      const value = part.slice(eq + 1).trim();
      if (key) {
        tags[key] = value;
      }
    }
    let logoUrl = (tags.l || "").trim();
    // Only accept https logo URLs (BIMI requires https; reject anything else).
    if (!logoUrl || !/^https:\/\/\S+$/i.test(logoUrl)) {
      logoUrl = "";
    }
    return { version: "BIMI1", logoUrl, vmcUrl: (tags.a || "").trim() };
  }

  /**
   * Did the message pass DMARC? Scans one or more joined Authentication-Results
   * header values for `dmarc=pass`.
   *
   * NOTE: this trusts any Authentication-Results line; a fully correct check
   * would match the receiving server's authserv-id. Good enough as a gate for a
   * cosmetic logo, but not a security guarantee.
   */
  function dmarcPassed(authResults) {
    if (typeof authResults !== "string") {
      return false;
    }
    return /\bdmarc\s*=\s*pass\b/i.test(authResults);
  }

  /**
   * Turn a DoH JSON Answer's `data` field into a plain TXT string.
   * DNS-over-HTTPS providers return TXT data as one or more quoted, possibly
   * escaped, character-strings (e.g. `"\"v=BIMI1; \" \"l=https://…\""`). Strip the
   * quotes and concatenate the segments back into the original record.
   */
  function txtFromDohData(data) {
    if (typeof data !== "string") {
      return "";
    }
    const segments = data.match(/"((?:[^"\\]|\\.)*)"/g);
    if (segments && segments.length) {
      return segments
        .map((s) => s.slice(1, -1).replace(/\\(.)/g, "$1"))
        .join("");
    }
    return data.trim();
  }

  // A pragmatic (deliberately NOT exhaustive) set of multi-label public
  // suffixes, so baseDomainOf("news.bbc.co.uk") → "bbc.co.uk" rather than the
  // unregistrable "co.uk". The long tail not listed here falls back to the last
  // two labels, which is correct for the common case this option targets
  // (e.g. "trx.mail2.disneyplus.com" → "disneyplus.com"). This is not the full
  // Public Suffix List; bundling that would be overkill for a cosmetic logo.
  const MULTI_PART_SUFFIXES = new Set([
    "co.uk", "org.uk", "gov.uk", "ac.uk", "me.uk", "ltd.uk", "plc.uk", "net.uk", "sch.uk",
    "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
    "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
    "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp", "ad.jp",
    "com.br", "net.br", "org.br", "gov.br",
    "com.cn", "net.cn", "org.cn", "gov.cn",
    "co.in", "net.in", "org.in", "gen.in", "firm.in", "ind.in",
    "co.za", "org.za", "net.za", "gov.za",
    "co.kr", "or.kr", "co.il", "co.id", "co.th",
    "com.mx", "com.sg", "com.hk", "com.tr", "com.tw", "com.ar",
    "com.pl", "com.ua", "com.my"
  ]);

  /**
   * Reduce a hostname to its registrable ("base") domain, e.g.
   * "trx.mail2.disneyplus.com" → "disneyplus.com". Used by the opt-in
   * base-domain BIMI lookup so a brand's subdomains all resolve to the logo
   * published on the parent domain. Returns "" for empty/invalid input.
   */
  function baseDomainOf(domain) {
    if (typeof domain !== "string") {
      return "";
    }
    const host = domain.trim().toLowerCase().replace(/\.+$/, "");
    if (!host) {
      return "";
    }
    const labels = host.split(".");
    if (labels.length <= 2) {
      return host;
    }
    const lastTwo = labels.slice(-2).join(".");
    const keep = MULTI_PART_SUFFIXES.has(lastTwo) ? 3 : 2;
    return labels.slice(-keep).join(".");
  }

  /* ---- RFC 8484 DNS-wireformat (for arbitrary DoH endpoints) ------------ */

  // The JSON DoH API (?type=TXT&name=… returning JSON) is essentially a
  // Cloudflare/Google extension. Most other resolvers — AdGuard, Quad9, NextDNS,
  // a self-hosted AdGuard Home, even Google's own /dns-query — speak only the
  // standard binary wireformat (RFC 8484). These pure helpers build a TXT query
  // and decode the answer so custom endpoints work too. They operate on bytes
  // (Uint8Array); the privileged layer handles base64url-on-the-URL and HTTP.

  /** Build a minimal DNS query message (header + question) for a TXT record. */
  function encodeDnsTxtQuery(host) {
    const name = String(host || "").replace(/\.+$/, "");
    const labels = name.length ? name.split(".") : [];
    let qnameLen = 1; // terminating root label
    for (const l of labels) {
      qnameLen += 1 + l.length;
    }
    const buf = new Uint8Array(12 + qnameLen + 4);
    let p = 0;
    // Header: ID=0 (RFC 8484 recommends 0 for cache-friendliness).
    buf[p++] = 0; buf[p++] = 0;
    buf[p++] = 0x01; buf[p++] = 0x00; // flags: RD=1 (recursion desired)
    buf[p++] = 0x00; buf[p++] = 0x01; // QDCOUNT=1
    buf[p++] = 0; buf[p++] = 0; // ANCOUNT
    buf[p++] = 0; buf[p++] = 0; // NSCOUNT
    buf[p++] = 0; buf[p++] = 0; // ARCOUNT
    for (const l of labels) {
      buf[p++] = l.length & 0x3f; // labels are <=63 chars for any real domain
      for (let i = 0; i < l.length; i++) {
        buf[p++] = l.charCodeAt(i) & 0xff;
      }
    }
    buf[p++] = 0; // root label
    buf[p++] = 0x00; buf[p++] = 0x10; // QTYPE = TXT (16)
    buf[p++] = 0x00; buf[p++] = 0x01; // QCLASS = IN (1)
    return buf;
  }

  /**
   * Decode the TXT records from a DNS response message (Uint8Array). Each
   * record's character-strings are concatenated (matching txtFromDohData), so a
   * split BIMI record comes back whole. Returns an array of strings (possibly
   * empty); never throws on malformed input.
   */
  function decodeDnsTxtAnswers(bytes) {
    const out = [];
    if (!bytes || bytes.length < 12) {
      return out;
    }
    const u16 = (o) => (bytes[o] << 8) | bytes[o + 1];
    const qd = u16(4);
    const an = u16(6);
    // Advance past a name; a compression pointer (0xC0) terminates it in 2 bytes.
    const skipName = (off) => {
      while (off < bytes.length) {
        const len = bytes[off];
        if (len === 0) {
          return off + 1;
        }
        if ((len & 0xc0) === 0xc0) {
          return off + 2;
        }
        off += 1 + len;
      }
      return off;
    };
    let p = 12;
    for (let i = 0; i < qd; i++) {
      p = skipName(p);
      p += 4; // QTYPE + QCLASS
    }
    for (let i = 0; i < an && p + 10 <= bytes.length; i++) {
      p = skipName(p);
      const type = u16(p);
      const rdlen = u16(p + 8);
      let rp = p + 10;
      const rend = rp + rdlen;
      if (type === 16) {
        let s = "";
        while (rp < rend && rp < bytes.length) {
          const clen = bytes[rp++];
          for (let j = 0; j < clen && rp < bytes.length; j++) {
            s += String.fromCharCode(bytes[rp++]);
          }
        }
        if (s) {
          out.push(s);
        }
      }
      p = rend;
    }
    return out;
  }

  /** Base64url-encode bytes with no padding (for the DoH `?dns=` parameter). */
  function bytesToBase64Url(bytes) {
    const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let out = "";
    let i = 0;
    for (; i + 3 <= bytes.length; i += 3) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + A[(n >> 6) & 63] + A[n & 63];
    }
    const rem = bytes.length - i;
    if (rem === 1) {
      const n = bytes[i] << 16;
      out += A[(n >> 18) & 63] + A[(n >> 12) & 63];
    } else if (rem === 2) {
      const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
      out += A[(n >> 18) & 63] + A[(n >> 12) & 63] + A[(n >> 6) & 63];
    }
    return out;
  }

  /** Is a cache entry still fresh given a refresh interval in hours? */
  function isFresh(ts, refreshHours, now) {
    if (typeof ts !== "number" || !ts) {
      return false;
    }
    const hours = typeof refreshHours === "number" && refreshHours > 0 ? refreshHours : 24;
    const at = typeof now === "number" ? now : Date.now();
    return at - ts < hours * 3600 * 1000;
  }

  root.ThundericonBimi = {
    parseBimiRecord,
    dmarcPassed,
    isFresh,
    txtFromDohData,
    baseDomainOf,
    encodeDnsTxtQuery,
    decodeDnsTxtAnswers,
    bytesToBase64Url
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
