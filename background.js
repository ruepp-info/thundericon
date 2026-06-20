/**
 * Thundericon — background.
 *
 * Loads preferences from storage, hands them to the privileged experiment that
 * decorates the message list, and relays any preference change so the open list
 * updates without a restart.
 */
"use strict";

/* global messenger, ThundericonConfig */

const api = typeof messenger !== "undefined" ? messenger : browser;

let starting = null;

// BIMI logo cache persistence. Resolved logos are written back to storage.local
// (debounced/coalesced) so they survive restarts and feed the experiment on the
// next launch. Capped so a long-lived profile can't grow the cache unbounded.
const BIMI_MAX_ENTRIES = 500;
let bimiPendingWrites = new Map(); // domain -> { status, logo, ts }
let bimiFlushTimer = null;

async function startAvatars() {
  const config = await ThundericonConfig.load();
  await api.threadPaneAvatars.start(config);
  // Prime the experiment's in-memory logo cache from what we persisted.
  try {
    await api.threadPaneAvatars.seedBimiCache(JSON.stringify(config.bimiCache || {}));
  } catch (e) {
    console.error("[Thundericon] seedBimiCache failed:", e);
  }
}

function scheduleBimiFlush() {
  if (bimiFlushTimer) {
    return;
  }
  bimiFlushTimer = setTimeout(flushBimiWrites, 1500);
}

async function flushBimiWrites() {
  bimiFlushTimer = null;
  if (!bimiPendingWrites.size) {
    return;
  }
  const writes = bimiPendingWrites;
  bimiPendingWrites = new Map();
  try {
    const stored = await api.storage.local.get("bimiCache");
    const cache = (stored && stored.bimiCache) || {};
    for (const [domain, entry] of writes) {
      cache[domain] = entry;
    }
    capBimiCache(cache, BIMI_MAX_ENTRIES);
    await api.storage.local.set({ bimiCache: cache });
  } catch (e) {
    console.error("[Thundericon] bimi persist failed:", e);
  }
}

// Evict the oldest entries (by timestamp) once over the cap.
function capBimiCache(cache, max) {
  const keys = Object.keys(cache);
  if (keys.length <= max) {
    return;
  }
  keys.sort((a, b) => ((cache[a] && cache[a].ts) || 0) - ((cache[b] && cache[b].ts) || 0));
  for (let i = 0; i < keys.length - max; i++) {
    delete cache[keys[i]];
  }
}

// Wipe the persisted + in-memory BIMI caches and force a fresh re-resolve.
async function clearBimiCache() {
  bimiPendingWrites = new Map();
  if (bimiFlushTimer) {
    clearTimeout(bimiFlushTimer);
    bimiFlushTimer = null;
  }
  await api.storage.local.set({ bimiCache: {} });
  try {
    await api.threadPaneAvatars.seedBimiCache("{}");
  } catch (e) {
    /* experiment may not be started yet */
  }
  // Re-push config so open lists drop their per-message logos and re-resolve.
  const config = await ThundericonConfig.load();
  try {
    await api.threadPaneAvatars.updateConfig(config);
  } catch (e) {
    /* nothing injected yet */
  }
}

// Coalesce concurrent start triggers (top-level load + onStartup/onInstalled).
function ensureStarted() {
  if (!starting) {
    starting = startAvatars().catch((e) => {
      starting = null;
      console.error("[Thundericon] start failed:", e);
    });
  }
  return starting;
}

// Push preference changes through to every open message list.
ThundericonConfig.subscribe(async (config) => {
  try {
    await api.threadPaneAvatars.updateConfig(config);
  } catch (e) {
    console.error("[Thundericon] updateConfig failed:", e);
  }
});

// Surface recoverable injection errors to the console.
if (api.threadPaneAvatars && api.threadPaneAvatars.onError) {
  api.threadPaneAvatars.onError.addListener((message) => {
    console.warn("[Thundericon]", message);
  });
}

// Persist BIMI logos as the experiment resolves them.
if (api.threadPaneAvatars && api.threadPaneAvatars.onBimiResolved) {
  api.threadPaneAvatars.onBimiResolved.addListener((domain, entryJson) => {
    try {
      bimiPendingWrites.set(domain, JSON.parse(entryJson));
      scheduleBimiFlush();
    } catch (e) {
      /* ignore malformed entry */
    }
  });
}

// The options page asks us to clear the BIMI cache via a runtime message.
api.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "thundericon:clearBimi") {
    clearBimiCache().then(
      () => sendResponse({ ok: true }),
      (e) => sendResponse({ ok: false, error: String(e) })
    );
    return true; // keep the message channel open for the async response
  }
  return false;
});

api.runtime.onInstalled.addListener(ensureStarted);
api.runtime.onStartup.addListener(ensureStarted);

// Also start immediately when the background page loads.
ensureStarted();
