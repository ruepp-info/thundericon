"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");

// avatar-core.js is an IIFE that publishes globalThis.ThundericonCore.
require("../src/avatar-core.js");
const C = globalThis.ThundericonCore;

const NEUTRAL = { colorMode: "mutedPalette", initialsCount: 2, initialsSource: "displayName", uppercase: true };

test("parseSender handles the common header forms", () => {
  assert.deepEqual(C.parseSender("Ada Lovelace <ada@analytical.org>"), {
    name: "Ada Lovelace",
    email: "ada@analytical.org"
  });
  assert.deepEqual(C.parseSender("<solo@example.com>"), {
    name: "solo",
    email: "solo@example.com"
  });
  assert.deepEqual(C.parseSender("bare@example.com"), {
    name: "bare",
    email: "bare@example.com"
  });
  assert.deepEqual(C.parseSender('"Quoted Name" <q@x.io>'), {
    name: "Quoted Name",
    email: "q@x.io"
  });
  assert.deepEqual(C.parseSender("Just A Name"), { name: "Just A Name", email: "" });
  assert.deepEqual(C.parseSender(""), { name: "", email: "" });
});

test("getInitials covers two-word, single-word, email and empty", () => {
  const o = { count: 2, source: "displayName", uppercase: true };
  assert.equal(C.getInitials("Ada Lovelace", "ada@x.org", o), "AL");
  assert.equal(C.getInitials("Cher", "", o), "CH"); // single word -> first two letters
  assert.equal(C.getInitials("", "alan.turing@x.uk", o), "AT"); // email local part, split on dot
  assert.equal(C.getInitials("", "", o), "?");
  assert.equal(C.getInitials("Ada Lovelace", "", { count: 1, uppercase: true }), "A");
  assert.equal(C.getInitials("ada lovelace", "", { count: 2, uppercase: false }), "al");
});

test("getInitials with source=email prefers the address", () => {
  assert.equal(
    C.getInitials("Display Name", "system.bot@corp.com", { count: 2, source: "email", uppercase: true }),
    "SB"
  );
});

test("getColor is deterministic per sender", () => {
  const a = C.getColor("Grace Hopper", "grace@navy.mil", NEUTRAL, {});
  const b = C.getColor("Grace Hopper", "grace@navy.mil", NEUTRAL, {});
  assert.equal(a, b);
  assert.match(a, /^#[0-9a-f]{6}$/);
  assert.ok(C.MUTED_PALETTE.includes(a));
});

test("domain override beats every color mode", () => {
  const map = { "mit.edu": "#123456" };
  assert.equal(C.getColor("X", "x@mit.edu", NEUTRAL, map), "#123456");
  assert.equal(C.getColor("X", "x@mit.edu", { colorMode: "hslHash" }, map), "#123456");
  // unmapped domain falls through to the mode
  assert.notEqual(C.getColor("X", "x@other.edu", NEUTRAL, map), "#123456");
});

test("fixed mode returns the configured color; customPalette cycles", () => {
  assert.equal(C.getColor("a", "a@b.c", { colorMode: "fixed", fixedColor: "#abcdef" }, {}), "#abcdef");
  const pal = ["#111111", "#222222", "#333333"];
  const got = C.getColor("a", "a@b.c", { colorMode: "customPalette", customPalette: pal }, {});
  assert.ok(pal.includes(got));
  // empty custom palette falls back to the neutral palette
  const fb = C.getColor("a", "a@b.c", { colorMode: "customPalette", customPalette: [] }, {});
  assert.ok(C.MUTED_PALETTE.includes(fb));
});

test("grayscale and hsl modes emit valid hex within expected bands", () => {
  for (const mode of ["grayscale", "lowsatHsl", "hslHash"]) {
    const c = C.getColor("sample", "s@x.io", { colorMode: mode }, {});
    assert.match(c, /^#[0-9a-f]{6}$/, mode);
  }
  // grayscale means r==g==b
  const g = C.getColor("sample", "s@x.io", { colorMode: "grayscale" }, {});
  assert.equal(g.slice(1, 3), g.slice(3, 5));
  assert.equal(g.slice(3, 5), g.slice(5, 7));
});

test("pickForeground gives legible contrast", () => {
  assert.equal(C.pickForeground("#ffffff"), "#1f2933"); // dark text on light bg
  assert.equal(C.pickForeground("#000000"), "#ffffff"); // light text on dark bg
  assert.equal(C.pickForeground("#6b7280"), "#ffffff"); // slate -> white
});

test("normalizeHex accepts shorthand and rejects garbage", () => {
  assert.equal(C.normalizeHex("#abc"), "#aabbcc");
  assert.equal(C.normalizeHex("AABBCC"), "#aabbcc");
  assert.equal(C.normalizeHex("#AaBbCc"), "#aabbcc");
  assert.equal(C.normalizeHex("not-a-color"), null);
  assert.equal(C.normalizeHex(""), null);
  assert.equal(C.normalizeHex(null), null);
});

test("describe bundles initials + colors + parsed identity", () => {
  const d = C.describe("Ada Lovelace <ada@analytical.org>", NEUTRAL, {});
  assert.equal(d.initials, "AL");
  assert.equal(d.name, "Ada Lovelace");
  assert.equal(d.email, "ada@analytical.org");
  assert.match(d.background, /^#[0-9a-f]{6}$/);
  assert.equal(d.foreground, C.pickForeground(d.background));
});
