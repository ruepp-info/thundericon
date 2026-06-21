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

test("encodeDnsTxtQuery builds a well-formed TXT question", () => {
  const q = B.encodeDnsTxtQuery("default._bimi.example.com");
  // Header: ID=0, flags RD=1 (0x0100), QDCOUNT=1, others 0.
  assert.deepEqual([...q.slice(0, 12)], [0, 0, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
  // Question name encoded as length-prefixed labels ending in a root 0.
  const labels = "default._bimi.example.com".split(".");
  let p = 12;
  for (const l of labels) {
    assert.equal(q[p], l.length);
    assert.equal(String.fromCharCode(...q.slice(p + 1, p + 1 + l.length)), l);
    p += 1 + l.length;
  }
  assert.equal(q[p++], 0); // root label
  assert.deepEqual([...q.slice(p, p + 4)], [0x00, 0x10, 0x00, 0x01]); // TXT / IN
  assert.equal(p + 4, q.length);
});

test("bytesToBase64Url matches base64url with no padding", () => {
  const q = B.encodeDnsTxtQuery("default._bimi.example.com");
  assert.equal(B.bytesToBase64Url(q), Buffer.from(q).toString("base64url"));
  assert.equal(B.bytesToBase64Url(new Uint8Array([0xff])), "_w");
  assert.equal(B.bytesToBase64Url(new Uint8Array([1, 2])), Buffer.from([1, 2]).toString("base64url"));
  assert.equal(B.bytesToBase64Url(new Uint8Array([])), "");
});

// Build a synthetic DNS response (question + one TXT answer) for decode tests.
function buildTxtResponse(host, txt) {
  const q = B.encodeDnsTxtQuery(host); // header + question
  const rdata = [];
  for (let i = 0; i < txt.length; i += 255) {
    const seg = txt.slice(i, i + 255);
    rdata.push(seg.length);
    for (let j = 0; j < seg.length; j++) {
      rdata.push(seg.charCodeAt(j));
    }
  }
  const answer = [
    0xc0, 0x0c, // name: compression pointer to the question at offset 12
    0x00, 0x10, // type TXT
    0x00, 0x01, // class IN
    0x00, 0x00, 0x0e, 0x10, // TTL 3600
    (rdata.length >> 8) & 0xff, rdata.length & 0xff,
    ...rdata
  ];
  const out = new Uint8Array(q.length + answer.length);
  out.set(q, 0);
  out.set(answer, q.length);
  out[2] = 0x81; out[3] = 0x80; // flags: QR=1, RD=1, RA=1
  out[7] = 0x01; // ANCOUNT=1
  return out;
}

test("decodeDnsTxtAnswers extracts a TXT record from a response", () => {
  const txt = "v=BIMI1; l=https://example.com/logo.svg";
  const resp = buildTxtResponse("default._bimi.example.com", txt);
  assert.deepEqual(B.decodeDnsTxtAnswers(resp), [txt]);
});

test("decodeDnsTxtAnswers rejoins a record split across character-strings", () => {
  const txt = "v=BIMI1; l=https://example.com/" + "a".repeat(300) + ".svg"; // > 255 bytes
  const resp = buildTxtResponse("default._bimi.example.com", txt);
  assert.deepEqual(B.decodeDnsTxtAnswers(resp), [txt]);
});

test("decodeDnsTxtAnswers tolerates empty/short input", () => {
  assert.deepEqual(B.decodeDnsTxtAnswers(new Uint8Array([])), []);
  assert.deepEqual(B.decodeDnsTxtAnswers(null), []);
  assert.deepEqual(B.decodeDnsTxtAnswers(new Uint8Array([0, 0, 0])), []);
});

test("a wireformat TXT response round-trips into parseBimiRecord", () => {
  const resp = buildTxtResponse(
    "default._bimi.disneyplus.com",
    "v=BIMI1; l=https://secure.disney.com/bimi/logo.svg; a="
  );
  const [txt] = B.decodeDnsTxtAnswers(resp);
  assert.equal(
    B.parseBimiRecord(txt).logoUrl,
    "https://secure.disney.com/bimi/logo.svg"
  );
});

test("isFresh honors the refresh window", () => {
  const now = 1_000_000_000_000;
  assert.equal(B.isFresh(now - 1000, 24, now), true);
  assert.equal(B.isFresh(now - 25 * 3600 * 1000, 24, now), false); // older than 24h
  assert.equal(B.isFresh(now - 2 * 3600 * 1000, 1, now), false); // 1h window, 2h old
  assert.equal(B.isFresh(0, 24, now), false);
  assert.equal(B.isFresh(undefined, 24, now), false);
});
