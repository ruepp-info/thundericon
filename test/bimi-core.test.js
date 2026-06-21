"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");

require("../src/bimi-core.js");
const B = globalThis.ThundericonBimi;

test("parseBimiRecord extracts an https logo URL", () => {
  const r = B.parseBimiRecord("v=BIMI1; l=https://example.com/logo.svg; a=https://example.com/vmc.pem");
  assert.equal(r.version, "BIMI1");
  assert.equal(r.logoUrl, "https://example.com/logo.svg");
  assert.equal(r.vmcUrl, "https://example.com/vmc.pem");
});

test("parseBimiRecord tolerates spacing and case", () => {
  const r = B.parseBimiRecord("  v = BIMI1 ; l = https://x.io/a.svg ");
  assert.equal(r.logoUrl, "https://x.io/a.svg");
});

test("parseBimiRecord returns null for non-BIMI records", () => {
  assert.equal(B.parseBimiRecord("v=spf1 include:_spf.x.io ~all"), null);
  assert.equal(B.parseBimiRecord(""), null);
  assert.equal(B.parseBimiRecord(null), null);
});

test("parseBimiRecord blanks a declined or non-https logo", () => {
  assert.equal(B.parseBimiRecord("v=BIMI1; l=").logoUrl, ""); // declined
  assert.equal(B.parseBimiRecord("v=BIMI1; l=http://x.io/a.svg").logoUrl, ""); // not https
  assert.equal(B.parseBimiRecord("v=BIMI1;").logoUrl, "");
});

test("dmarcPassed detects dmarc=pass anywhere in the header", () => {
  assert.equal(B.dmarcPassed("mx.google.com; spf=pass; dkim=pass; dmarc=pass (p=REJECT)"), true);
  assert.equal(B.dmarcPassed("mx; dmarc = pass"), true);
  assert.equal(B.dmarcPassed("mx; dmarc=fail"), false);
  assert.equal(B.dmarcPassed("mx; spf=pass"), false);
  assert.equal(B.dmarcPassed(""), false);
  assert.equal(B.dmarcPassed(null), false);
});

test("txtFromDohData strips quotes and joins split character-strings", () => {
  assert.equal(
    B.txtFromDohData('"v=BIMI1; l=https://x.io/a.svg"'),
    "v=BIMI1; l=https://x.io/a.svg"
  );
  // A long record split into multiple quoted segments is rejoined.
  assert.equal(
    B.txtFromDohData('"v=BIMI1; " "l=https://x.io/a.svg"'),
    "v=BIMI1; l=https://x.io/a.svg"
  );
  // Escaped quotes inside the string are unescaped.
  assert.equal(B.txtFromDohData('"a\\"b"'), 'a"b');
  // Unquoted data is returned trimmed; non-strings yield "".
  assert.equal(B.txtFromDohData("v=BIMI1"), "v=BIMI1");
  assert.equal(B.txtFromDohData(null), "");
});

test("a DoH TXT round-trips into parseBimiRecord", () => {
  const txt = B.txtFromDohData(
    '"v=BIMI1; l=https://static.ruepp.info/BIMI/sr.svg; a=; avp=personal;"'
  );
  assert.equal(B.parseBimiRecord(txt).logoUrl, "https://static.ruepp.info/BIMI/sr.svg");
});

test("baseDomainOf reduces a subdomain to its registrable domain", () => {
  assert.equal(B.baseDomainOf("trx.mail2.disneyplus.com"), "disneyplus.com");
  assert.equal(B.baseDomainOf("mail.example.com"), "example.com");
  assert.equal(B.baseDomainOf("example.com"), "example.com");
  assert.equal(B.baseDomainOf("a.b.c.d.example.com"), "example.com");
});

test("baseDomainOf keeps multi-label public suffixes intact", () => {
  assert.equal(B.baseDomainOf("news.bbc.co.uk"), "bbc.co.uk");
  assert.equal(B.baseDomainOf("bbc.co.uk"), "bbc.co.uk");
  assert.equal(B.baseDomainOf("shop.example.com.au"), "example.com.au");
});

test("baseDomainOf normalizes case, trailing dots and empty input", () => {
  assert.equal(B.baseDomainOf("MAIL.Example.COM"), "example.com");
  assert.equal(B.baseDomainOf("mail.example.com."), "example.com");
  assert.equal(B.baseDomainOf("  example.com  "), "example.com");
  assert.equal(B.baseDomainOf(""), "");
  assert.equal(B.baseDomainOf(null), "");
});

test("isFresh honors the refresh window", () => {
  const now = 1_000_000_000_000;
  assert.equal(B.isFresh(now - 1000, 24, now), true);
  assert.equal(B.isFresh(now - 25 * 3600 * 1000, 24, now), false); // older than 24h
  assert.equal(B.isFresh(now - 2 * 3600 * 1000, 1, now), false); // 1h window, 2h old
  assert.equal(B.isFresh(0, 24, now), false);
  assert.equal(B.isFresh(undefined, 24, now), false);
});
