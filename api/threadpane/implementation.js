/**
 * Thundericon — privileged Experiment API.
 *
 * Bridges the WebExtension world and the privileged about:3pane document. The
 * message list cannot be reached by ordinary content scripts, so this parent
 * code injects our renderer + stylesheet into each about:3pane window, relays
 * configuration, and tears everything down cleanly on shutdown.
 */

"use strict";

/* global ExtensionCommon, ChromeUtils, Services */

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { ExtensionSupport } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);

const MESSENGER_WINDOW = "chrome://messenger/content/messenger.xhtml";
const STYLE_ID = "thundericon-style";

async function readText(url) {
  // Fetch our own packaged resource. `fetch` handles moz-extension URLs in the
  // privileged parent context; fall back to XHR if it is unavailable.
  try {
    const resp = await fetch(url);
    return await resp.text();
  } catch (e) {
    return await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", url);
      xhr.onload = () => resolve(xhr.responseText);
      xhr.onerror = () => reject(xhr.statusText);
      xhr.send();
    });
  }
}

function is3PaneBrowser(browser) {
  try {
    return !!browser && !!browser.currentURI &&
      browser.currentURI.spec.startsWith("about:3pane");
  } catch (e) {
    return false;
  }
}

var threadPaneAvatars = class extends ExtensionCommon.ExtensionAPI {
  getAPI(context) {
    // Initialize shared state ONCE. getAPI() runs again every time a context
    // (re)connects — notably when Thunderbird's MV3 background event page wakes
    // from suspension. Re-running it would wipe the live renderer registry, so
    // updateConfig()/broadcast() would push to an empty set and option changes
    // would only show after a restart. Guard it.
    if (!this._initialized) {
      this._initialized = true;
      this._config = null;
      this._cssText = "";
      this._coreURL = context.extension.getURL("src/avatar-core.js");
      this._rendererURL = context.extension.getURL("injected/avatar-renderer.js");
      this._cssURL = context.extension.getURL("injected/avatars.css");
      this._listenerId = "thundericon-" + context.extension.id;
      this._mailWindows = new Set(); // messenger windows we have hooked
      this._renderers = new Set(); // about:3pane content windows we injected into
      this._winCleanups = new WeakMap(); // window -> cleanup fn
      this._started = false;
    }

    return {
      threadPaneAvatars: {
        start: async (config) => {
          this._config = config;
          if (this._started) {
            this._broadcast();
            return;
          }
          this._started = true;
          try {
            this._cssText = await readText(this._cssURL);
          } catch (e) {
            this._reportError("Failed to load stylesheet: " + e);
          }
          ExtensionSupport.registerWindowListener(this._listenerId, {
            chromeURLs: [MESSENGER_WINDOW],
            onLoadWindow: (win) => this._hookWindow(win)
          });
        },

        updateConfig: async (config) => {
          this._config = config;
          this._broadcast();
        },

        stop: async () => {
          this._teardown();
        },

        onError: new ExtensionCommon.EventManager({
          context,
          name: "threadPaneAvatars.onError",
          register: (fire) => {
            this._fireError = (msg) => fire.async(msg);
            return () => {
              this._fireError = null;
            };
          }
        }).api()
      }
    };
  }

  onShutdown(/* isAppShutdown */) {
    this._teardown();
  }

  /* ---- error plumbing --------------------------------------------------- */

  _reportError(message) {
    console.error("[Thundericon]", message);
    if (this._fireError) {
      try {
        this._fireError(String(message));
      } catch (e) {
        /* listener gone */
      }
    }
  }

  /* ---- window / tab lifecycle ------------------------------------------ */

  _hookWindow(win) {
    if (this._mailWindows.has(win)) {
      return;
    }
    this._mailWindows.add(win);

    const rescan = () => win.setTimeout(() => this._scanWindow(win), 0);
    const tabmail = win.document.getElementById("tabmail");
    if (tabmail) {
      tabmail.addEventListener("TabOpen", rescan);
      tabmail.addEventListener("TabSelect", rescan);
    }
    const onUnload = () => this._forgetWindow(win);
    win.addEventListener("unload", onUnload, { once: true });

    this._winCleanups.set(win, () => {
      if (tabmail) {
        tabmail.removeEventListener("TabOpen", rescan);
        tabmail.removeEventListener("TabSelect", rescan);
      }
      win.removeEventListener("unload", onUnload);
    });

    // The 3pane browser may not be ready on first load; scan now and shortly after.
    this._scanWindow(win);
    win.setTimeout(() => this._scanWindow(win), 250);
    win.setTimeout(() => this._scanWindow(win), 1000);
  }

  _forgetWindow(win) {
    const cleanup = this._winCleanups.get(win);
    if (cleanup) {
      cleanup();
      this._winCleanups.delete(win);
    }
    this._mailWindows.delete(win);
  }

  _scanWindow(win) {
    if (win.closed) {
      return;
    }
    let tabmail;
    try {
      tabmail = win.document.getElementById("tabmail");
    } catch (e) {
      return;
    }
    if (!tabmail || !tabmail.tabInfo) {
      return;
    }
    for (const info of tabmail.tabInfo) {
      const browser = info.chromeBrowser || info.browser || null;
      this._handleBrowser(browser);
    }
  }

  _handleBrowser(browser) {
    if (!is3PaneBrowser(browser)) {
      return;
    }
    const doc = browser.contentDocument;
    if (doc && (doc.readyState === "interactive" || doc.readyState === "complete")) {
      this._inject(browser.contentWindow);
      return;
    }
    // Inject once the inner document is parsed; the renderer itself waits for the
    // thread tree element, so injecting at DOMContentLoaded is safe.
    const onReady = () => {
      browser.removeEventListener("DOMContentLoaded", onReady, true);
      this._inject(browser.contentWindow);
    };
    browser.addEventListener("DOMContentLoaded", onReady, true);
  }

  /* ---- injection -------------------------------------------------------- */

  _inject(cw) {
    if (!cw || cw.closed) {
      return;
    }
    try {
      if (!cw.__thundericon) {
        Services.scriptloader.loadSubScript(this._coreURL, cw);
        Services.scriptloader.loadSubScript(this._rendererURL, cw);
        this._renderers.add(cw);
      }
      this._loadStyle(cw);
      if (cw.__thundericon && this._config) {
        cw.__thundericon.apply(JSON.stringify(this._config));
      }
    } catch (e) {
      this._reportError("Injection failed: " + (e && e.message ? e.message : e));
    }
  }

  // Load avatars.css straight from the packaged resource using the chrome sheet
  // loader. This needs no fetch/XHR (which are unreliable in the experiment
  // sandbox), so the badge styles actually arrive. nsIDOMWindowUtils sheet
  // types: AGENT = 0, USER = 1, AUTHOR = 2.
  _loadStyle(cw) {
    if (cw.__thundericonSheet) {
      return;
    }
    try {
      cw.windowUtils.loadSheetUsingURIString(this._cssURL, 2);
      cw.__thundericonSheet = true;
      return;
    } catch (e) {
      this._reportError(
        "loadSheet failed, trying <style> fallback: " + (e && e.message ? e.message : e)
      );
    }
    // Fallback: inline <style> from the text read at startup (best effort).
    const doc = cw.document;
    if (doc && this._cssText && !doc.getElementById(STYLE_ID)) {
      const style = doc.createElement("style");
      style.id = STYLE_ID;
      style.textContent = this._cssText;
      (doc.head || doc.documentElement).appendChild(style);
      cw.__thundericonSheet = true;
    }
  }

  _broadcast() {
    if (!this._config) {
      return;
    }
    const payload = JSON.stringify(this._config);
    for (const cw of this._renderers) {
      try {
        if (cw && !cw.closed && cw.__thundericon) {
          cw.__thundericon.apply(payload);
        }
      } catch (e) {
        /* window navigated away; will be re-injected on next scan */
      }
    }
  }

  /* ---- teardown --------------------------------------------------------- */

  _teardown() {
    if (!this._started) {
      return;
    }
    this._started = false;
    try {
      ExtensionSupport.unregisterWindowListener(this._listenerId);
    } catch (e) {
      /* not registered */
    }
    for (const cw of this._renderers) {
      try {
        if (cw && !cw.closed) {
          if (cw.__thundericon) {
            cw.__thundericon.destroy();
            delete cw.__thundericon;
          }
          try {
            cw.windowUtils.removeSheetUsingURIString(this._cssURL, 2);
          } catch (e) {
            /* sheet was not loaded this way */
          }
          delete cw.__thundericonSheet;
          const style = cw.document && cw.document.getElementById(STYLE_ID);
          if (style) {
            style.remove();
          }
        }
      } catch (e) {
        /* best effort */
      }
    }
    this._renderers.clear();
    for (const win of this._mailWindows) {
      this._forgetWindow(win);
    }
    this._mailWindows.clear();
  }
};
