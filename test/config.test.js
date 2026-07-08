"use strict";
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// --- mock browser.storage.local BEFORE requiring config.js (it captures the
//     API reference at load time) -----------------------------------------
const store = {};
let listeners = [];
const clone = (v) => JSON.parse(JSON.stringify(v));

globalThis.browser = {
  storage: {
    local: {
      async get(keys) {
        const arr = Array.isArray(keys) ? keys : [keys];
        const out = {};
        for (const k of arr) {
          if (k in store) out[k] = clone(store[k]);
        }
        return out;
      },
      async set(obj) {
        const changes = {};
        for (const k of Object.keys(obj)) {
          changes[k] = { oldValue: store[k], newValue: obj[k] };
          store[k] = clone(obj[k]);
        }
        for (const l of listeners.slice()) {
          l(changes, "local");
        }
      }
    },
    onChanged: {
      addListener: (l) => listeners.push(l),
      removeListener: (l) => {
        listeners = listeners.filter((x) => x !== l);
      }
    }
  }
};

require("../src/config.js");
const Cfg = globalThis.ThundericonConfig;

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  listeners = [];
});

test("load() returns defaults when storage is empty", async () => {
  const c = await Cfg.load();
  assert.deepEqual(c, Cfg.DEFAULTS);
});

test("save() then load() round-trips and re-applies defaults for missing keys", async () => {
  await Cfg.save({ settings: { enabled: false, colorMode: "grayscale" } });
  const c = await Cfg.load();
  assert.equal(c.settings.enabled, false);
  assert.equal(c.settings.colorMode, "grayscale");
  // untouched keys keep their defaults
  assert.equal(c.settings.badgeSize, Cfg.DEFAULTS.settings.badgeSize);
  assert.equal(c.settings.fontWeight, Cfg.DEFAULTS.settings.fontWeight);
});

test("domainColors persist independently", async () => {
  await Cfg.save({ domainColors: { "x.com": "#111111" } });
  const c = await Cfg.load();
  assert.deepEqual(c.domainColors, { "x.com": "#111111" });
});

test("mergeSettings merges the layouts sub-object", () => {
  const m = Cfg.mergeSettings({ settings: { layouts: { cards: false } } });
  assert.equal(m.settings.layouts.cards, false);
  assert.equal(m.settings.layouts.table, true); // default preserved
});

test("unread-emphasis defaults exist", () => {
  const s = Cfg.DEFAULTS.settings;
  assert.equal(s.unreadEmphasis, true);
  assert.equal(s.unreadStyle, "bar");
  assert.equal(s.unreadAccentColor, "#4aa9ff");
  assert.equal(s.unreadBarWidth, "medium");
  assert.equal(s.unreadGlyph, "»");
  assert.equal(s.unreadGlyphSize, 14);
  assert.equal(s.unreadGlyphBold, false);
  assert.ok(s.unreadGlyphFont);
});

test("tuned defaults: vibrant color mode, and Junk/Trash not skipped", () => {
  const s = Cfg.DEFAULTS.settings;
  assert.equal(s.colorMode, "hslHash");
  assert.equal(s.bimiSkipFolders.junk, false);
  assert.equal(s.bimiSkipFolders.trash, false);
  assert.equal(s.gravatarSkipFolders.junk, false);
  assert.equal(s.gravatarSkipFolders.trash, false);
});

test("attachment auto-expand is on by default and survives partial stored settings", () => {
  assert.equal(Cfg.DEFAULTS.settings.attachmentsAutoExpand, true);
  // absent from an older stored profile -> default surfaces on upgrade
  const m = Cfg.mergeSettings({ settings: { badgeSize: 40 } });
  assert.equal(m.settings.attachmentsAutoExpand, true);
  // an explicit override still wins
  const m2 = Cfg.mergeSettings({ settings: { attachmentsAutoExpand: false } });
  assert.equal(m2.settings.attachmentsAutoExpand, false);
});

test("unread-emphasis defaults survive a partial stored settings (existing profiles)", () => {
  // A profile saved before this feature existed won't have the keys; the defaults
  // must still surface so the feature is available on upgrade.
  const m = Cfg.mergeSettings({ settings: { badgeSize: 40 } });
  assert.equal(m.settings.unreadEmphasis, true);
  assert.equal(m.settings.unreadStyle, "bar");
  assert.equal(m.settings.unreadAccentColor, "#4aa9ff");
  // an explicit override still wins
  const m2 = Cfg.mergeSettings({ settings: { unreadStyle: "ring" } });
  assert.equal(m2.settings.unreadStyle, "ring");
});

test("subscribe() fires with a merged config on change", async () => {
  const got = await new Promise((resolve) => {
    const unsub = Cfg.subscribe((cfg) => {
      unsub();
      resolve(cfg);
    });
    Cfg.save({ settings: { badgeSize: 40 } });
  });
  assert.equal(got.settings.badgeSize, 40);
  assert.equal(got.settings.colorMode, Cfg.DEFAULTS.settings.colorMode);
});

test("unsubscribe() stops notifications", async () => {
  let count = 0;
  const unsub = Cfg.subscribe(() => count++);
  unsub();
  await Cfg.save({ settings: { badgeSize: 12 } });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(count, 0);
});
