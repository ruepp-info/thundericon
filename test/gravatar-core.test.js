"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

require("../src/gravatar-core.js");
const G = globalThis.ThundericonGravatar;

const refMd5 = (s) => crypto.createHash("md5").update(s, "utf8").digest("hex");

test("md5 matches known vectors", () => {
  assert.equal(G.md5(""), "d41d8cd98f00b204e9800998ecf8427e");
  assert.equal(G.md5("abc"), "900150983cd24fb0d6963f7d28e17f72");
  assert.equal(
    G.md5("The quick brown fox jumps over the lazy dog"),
    "9e107d9d372bb6826bd81d3542a419d6"
  );
});

test("md5 matches Node's crypto across ASCII, UTF-8 and long input", () => {
  const samples = [
    "",
    "abc",
    "héllo wörld",
    "📧 emoji@example.com",
    "a".repeat(1000) // spans multiple 64-byte blocks
  ];
  for (const s of samples) {
    assert.equal(G.md5(s), refMd5(s));
  }
});

test("normalizeEmail lowercases, trims and unwraps Name <addr>", () => {
  assert.equal(G.normalizeEmail("  Foo@Example.COM "), "foo@example.com");
  assert.equal(G.normalizeEmail("Ada Lovelace <Ada@Analytical.org>"), "ada@analytical.org");
  assert.equal(G.normalizeEmail("mailto:Bob@x.io"), "bob@x.io");
});

test("normalizeEmail rejects non-addresses", () => {
  assert.equal(G.normalizeEmail(""), "");
  assert.equal(G.normalizeEmail("example.com"), ""); // bare domain, no @
  assert.equal(G.normalizeEmail("two words@x.io"), ""); // contains whitespace
  assert.equal(G.normalizeEmail(null), "");
});

test("hashEmail matches the documented Gravatar example", () => {
  // Gravatar's own example: "MyEmailAddress@example.com " (trimmed, lowercased).
  assert.equal(
    G.hashEmail("MyEmailAddress@example.com "),
    "0bc83cb571cd1c50ba6f3e8a78ef1346"
  );
});

test("hashEmail returns empty for a non-address", () => {
  assert.equal(G.hashEmail("not-an-email"), "");
});

test("avatarUrl builds a 404-default Gravatar URL", () => {
  const url = G.avatarUrl("0bc83cb571cd1c50ba6f3e8a78ef1346", 80);
  assert.equal(
    url,
    "https://gravatar.com/avatar/0bc83cb571cd1c50ba6f3e8a78ef1346?s=80&d=404"
  );
  // Falls back to a sane size for bad input.
  assert.match(G.avatarUrl("abc", 0), /\?s=80&d=404$/);
});

test("bytesToBase64 round-trips against Buffer", () => {
  const cases = [
    [],
    [0],
    [0, 1],
    [0, 1, 2],
    [255, 254, 253, 252, 0, 1, 2, 3]
  ];
  for (const arr of cases) {
    const bytes = Uint8Array.from(arr);
    assert.equal(G.bytesToBase64(bytes), Buffer.from(bytes).toString("base64"));
  }
});
