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

  /** Is a cache entry still fresh given a refresh interval in hours? */
  function isFresh(ts, refreshHours, now) {
    if (typeof ts !== "number" || !ts) {
      return false;
    }
    const hours = typeof refreshHours === "number" && refreshHours > 0 ? refreshHours : 24;
    const at = typeof now === "number" ? now : Date.now();
    return at - ts < hours * 3600 * 1000;
  }

  root.ThundericonBimi = { parseBimiRecord, dmarcPassed, isFresh, txtFromDohData };
})(typeof globalThis !== "undefined" ? globalThis : this);
