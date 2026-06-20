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

async function startAvatars() {
  const config = await ThundericonConfig.load();
  await api.threadPaneAvatars.start(config);
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

api.runtime.onInstalled.addListener(ensureStarted);
api.runtime.onStartup.addListener(ensureStarted);

// Also start immediately when the background page loads.
ensureStarted();
