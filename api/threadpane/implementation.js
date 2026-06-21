/**
 * Thundericon — privileged Experiment API.
 *
 * Bridges the WebExtension world and the privileged about:3pane document. The
 * message list cannot be reached by ordinary content scripts, so this parent
 * code injects our renderer + stylesheet into each about:3pane window, relays
 * configuration, and tears everything down cleanly on shutdown.
 */

"use strict";

/* global ExtensionCommon, ChromeUtils, Services, Ci, Components, XMLHttpRequest, fetch */

var { ExtensionCommon } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
var { ExtensionSupport } = ChromeUtils.importESModule(
  "resource:///modules/ExtensionSupport.sys.mjs"
);

const MESSENGER_WINDOW = "chrome://messenger/content/messenger.xhtml";
const STYLE_ID = "thundericon-style";
// Pixel size requested from Gravatar (crisp up to ~48px badges on HiDPI). Fixed
// so the cache key stays stable regardless of badge-size settings.
const GRAVATAR_PX = 80;
// Reject anything larger than this (parity with the BIMI SVG cap); a profile
// photo at GRAVATAR_PX is comfortably under it.
const GRAVATAR_MAX_BYTES = 64 * 1024;
// Diagnostic logging for the BIMI resolution chain (Error Console). The "Test
// BIMI…" window builds its own in-window log independently, so this can stay off
// for normal use; flip to true to also trace live-list resolution to the console.
const BIMI_DEBUG = false;

// Built-in DoH resolvers for TXT lookups, keyed by the setting value. Each
// descriptor is just { name, endpoint }; all lookups use the universal RFC 8484
// wireformat, which every DoH endpoint understands. Static, so it lives at module
// scope rather than being rebuilt on every lookup.
const DOH_PROVIDERS = {
  // Content-filtering / family-safe resolvers.
  "adguard-family": {
    name: "AdGuard DNS (Family Protection)",
    endpoint: "https://family.adguard-dns.com/dns-query"
  },
  "cloudflare-family": {
    name: "Cloudflare (Family Protection)",
    endpoint: "https://family.cloudflare-dns.com/dns-query"
  },
  "opendns-family": {
    name: "Cisco Umbrella FamilyShield",
    endpoint: "https://doh.familyshield.opendns.com/dns-query"
  },
  // General-purpose resolvers.
  adguard: {
    name: "AdGuard DNS",
    endpoint: "https://dns.adguard-dns.com/dns-query"
  },
  cloudflare: {
    name: "Cloudflare",
    endpoint: "https://cloudflare-dns.com/dns-query"
  },
  opendns: {
    name: "Cisco Umbrella (OpenDNS)",
    endpoint: "https://doh.opendns.com/dns-query"
  },
  quad9: {
    name: "Quad9",
    endpoint: "https://dns.quad9.net/dns-query"
  },
  mullvad: {
    name: "Mullvad",
    endpoint: "https://dns.mullvad.net/dns-query"
  },
  google: {
    name: "Google",
    endpoint: "https://dns.google/dns-query"
  }
};

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
      this._bimiCoreURL = context.extension.getURL("src/bimi-core.js");
      this._gravatarCoreURL = context.extension.getURL("src/gravatar-core.js");
      this._listenerId = "thundericon-" + context.extension.id;
      this._mailWindows = new Set(); // messenger windows we have hooked
      this._renderers = new Set(); // about:3pane content windows we injected into
      this._winCleanups = new WeakMap(); // window -> cleanup fn
      this._started = false;
      this._bimiCache = new Map(); // domain -> { status, logo, ts }
      this._bimiInflight = new Map(); // domain -> Promise (coalesce concurrent lookups)
      this._dmarcCache = new Map(); // messageId -> bool (session only)
      this._bimiLoaded = false;
      this._gravatarCache = new Map(); // email -> { status, logo, ts }
      this._gravatarInflight = new Map(); // email -> Promise (coalesce concurrent lookups)
      this._gravatarLoaded = false;
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
          this._ensureBimiCore();
          this._ensureGravatarCore();
          ExtensionSupport.registerWindowListener(this._listenerId, {
            chromeURLs: [MESSENGER_WINDOW],
            onLoadWindow: (win) => this._hookWindow(win)
          });
        },

        updateConfig: async (config) => {
          this._config = config;
          this._broadcast();
        },

        seedBimiCache: async (cacheJson) => {
          try {
            const obj = JSON.parse(cacheJson || "{}");
            this._bimiCache = new Map(Object.entries(obj));
          } catch (e) {
            this._bimiCache = new Map();
          }
        },

        seedGravatarCache: async (cacheJson) => {
          try {
            const obj = JSON.parse(cacheJson || "{}");
            this._gravatarCache = new Map(Object.entries(obj));
          } catch (e) {
            this._gravatarCache = new Map();
          }
        },

        testBimi: async (query) => this._runBimiTest(query),

        testGravatar: async (query) => this._runGravatarTest(query),

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
        }).api(),

        onBimiResolved: new ExtensionCommon.EventManager({
          context,
          name: "threadPaneAvatars.onBimiResolved",
          register: (fire) => {
            this._fireBimi = (domain, entryJson) => fire.async(domain, entryJson);
            return () => {
              this._fireBimi = null;
            };
          }
        }).api(),

        onGravatarResolved: new ExtensionCommon.EventManager({
          context,
          name: "threadPaneAvatars.onGravatarResolved",
          register: (fire) => {
            this._fireGravatar = (emailKey, entryJson) => fire.async(emailKey, entryJson);
            return () => {
              this._fireGravatar = null;
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
      // Host bridge the renderer calls to resolve a logo/photo for a message.
      cw.__thundericonHost = {
        resolveBimi: (domain, msgHdr, cb) => {
          this._resolveBimi(domain, msgHdr).then(
            (logo) => {
              try {
                cb(logo);
              } catch (e) {
                /* renderer gone */
              }
            },
            () => {
              try {
                cb(null);
              } catch (e) {
                /* renderer gone */
              }
            }
          );
        },
        resolveGravatar: (email, cb) => {
          this._resolveGravatar(email).then(
            (photo) => {
              try {
                cb(photo);
              } catch (e) {
                /* renderer gone */
              }
            },
            () => {
              try {
                cb(null);
              } catch (e) {
                /* renderer gone */
              }
            }
          );
        }
      };
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

  /* ---- BIMI resolution -------------------------------------------------- */

  // Diagnostic logging for the BIMI chain. Visible in Tools → Developer Tools →
  // Error Console (parent process). Flip to false to silence once it works.
  _blog(...args) {
    if (BIMI_DEBUG) {
      console.log("[Thundericon BIMI]", ...args);
    }
  }

  // Build a step logger: writes to the BIMI debug console and, when a log array
  // is supplied (the "Test BIMI" window), appends the line for the user to see.
  _noter(log) {
    return (m) => {
      this._blog(m);
      if (log) {
        log.push(m);
      }
    };
  }

  _ensureBimiCore() {
    if (this._bimiLoaded) {
      return;
    }
    try {
      Services.scriptloader.loadSubScript(this._bimiCoreURL, globalThis);
      this._bimiLoaded = !!globalThis.ThundericonBimi;
      this._blog("bimi-core loaded:", this._bimiLoaded);
    } catch (e) {
      this._reportError("bimi-core load failed: " + (e && e.message ? e.message : e));
    }
  }

  // Fold a sender domain to its registrable base when the option is enabled;
  // returns the (possibly reduced) domain. `note`, if given, is called with
  // (newBase, originalDomain) only when a reduction actually happens.
  _baseDomain(domain, settings, note) {
    const Bimi = globalThis.ThundericonBimi;
    if (!Bimi || !settings || !settings.bimiBaseDomainOnly) {
      return domain;
    }
    const base = Bimi.baseDomainOf(domain);
    if (base && base !== domain) {
      if (note) {
        note(base, domain);
      }
      return base;
    }
    return domain;
  }

  // Diagnostic resolve used by the options "Test BIMI" window. Runs the real
  // DNS + parse + SVG-fetch path (the SAME code as the live list) but WITHOUT the
  // DMARC gate, since there is no specific message here — we are only asking
  // "does this domain publish a usable BIMI logo?". Returns a structured result
  // with a human-readable step log so problems are visible to the user.
  async _runBimiTest(query) {
    const log = [];
    const out = (m) => {
      log.push(m);
      this._blog("[test]", m);
    };
    try {
      this._ensureBimiCore();
      const Bimi = globalThis.ThundericonBimi;
      if (!Bimi) {
        out("ERROR: bimi-core module is not loaded.");
        return { ok: false, log };
      }

      const raw = String(query || "").trim();
      let domain = raw;
      const at = raw.lastIndexOf("@");
      if (at >= 0) {
        domain = raw.slice(at + 1);
      }
      domain = domain
        .trim()
        .toLowerCase()
        .replace(/^@+/, "")
        .replace(/^https?:\/\//, "")
        .replace(/[/?#].*$/, "");
      if (!domain) {
        out("ERROR: could not read a domain from the input.");
        return { ok: false, log };
      }
      out("Domain: " + domain);

      // Mirror the live list: when base-domain lookup is on, fold subdomains
      // into the registrable domain before querying.
      const settings = (this._config && this._config.settings) || {};
      domain = this._baseDomain(domain, settings, (base) =>
        out("Base-domain lookup is on → using: " + base)
      );

      const host = "default._bimi." + domain;
      out("Looking up DNS TXT record: " + host);
      const txt = await this._dnsTxt(host, log);
      if (!txt) {
        out("Result: no BIMI TXT record published for this domain.");
        return { ok: false, domain, log };
      }
      out("TXT record: " + txt);

      const rec = Bimi.parseBimiRecord(txt);
      if (!rec) {
        out("Result: record is not a valid BIMI1 record.");
        return { ok: false, domain, record: txt, log };
      }
      out(
        "Parsed → version=" + rec.version +
        ", logo=" + (rec.logoUrl || "(none)") +
        ", vmc=" + (rec.vmcUrl || "(none)")
      );
      if (!rec.logoUrl) {
        out("Result: no usable https logo URL (domain declined, or URL is not https).");
        return { ok: false, domain, record: txt, log };
      }

      out("Fetching the SVG logo …");
      const dataUrl = await this._fetchSvgDataUrl(rec.logoUrl, log);
      if (!dataUrl) {
        out("Result: the logo could not be fetched or failed validation.");
        return { ok: false, domain, logoUrl: rec.logoUrl, record: txt, log };
      }

      out("SUCCESS: a valid BIMI logo is available for " + domain + ".");
      out("Note: in the message list the logo also requires the message to PASS DMARC.");
      return {
        ok: true,
        domain,
        logoUrl: rec.logoUrl,
        vmcUrl: rec.vmcUrl,
        record: txt,
        dataUrl,
        log
      };
    } catch (e) {
      out("ERROR: " + (e && e.message ? e.message : e));
      return { ok: false, log };
    }
  }

  // Resolve the BIMI logo for a sender domain + message, honoring the DMARC gate
  // and the cached/TTL logo. Returns a data: URL string or null. Always resolves
  // (never rejects) — any failure means "no logo", so the renderer shows initials.
  async _resolveBimi(domain, msgHdr) {
    try {
      const settings = (this._config && this._config.settings) || {};
      const Bimi = globalThis.ThundericonBimi;
      if (!settings.bimiEnabled || !domain || !Bimi) {
        this._blog("skip:", domain, "enabled=" + !!settings.bimiEnabled, "core=" + !!Bimi);
        return null;
      }
      // Optionally fold subdomains into the registrable base domain, so the DNS
      // lookup, the TTL'd cache and the persisted entry all key off it.
      domain = this._baseDomain(domain, settings, (base, from) =>
        this._blog(from, "→ base domain:", base)
      );
      // DMARC gate: never show a logo for an unauthenticated message.
      const passed = await this._dmarcPass(msgHdr);
      if (!passed) {
        this._blog(domain, "→ DMARC not pass → initials");
        return null;
      }
      // Cached result — a found logo OR a cached "none" (respecting the refresh
      // TTL). Negative results are cached too, so a sender without BIMI is looked
      // up once per refresh window rather than once per message.
      const entry = this._bimiCache.get(domain);
      if (entry && Bimi.isFresh(entry.ts, settings.bimiRefreshHours, Date.now())) {
        this._blog(domain, "→ cache hit:", entry.status);
        return entry.status === "ok" ? entry.logo : null;
      }
      // Cache miss: resolve fresh (coalesced per domain — see _resolveDomainFresh).
      const fresh = await this._resolveDomainFresh(domain);
      return fresh.status === "ok" ? fresh.logo : null;
    } catch (e) {
      this._blog("resolve error:", e && e.message ? e.message : e);
      return null;
    }
  }

  // Fetch and cache a domain's BIMI status (a found logo OR a "none"), while
  // de-duplicating concurrent lookups: when a folder full of mail from the same
  // sender is rendered, every row asks at once — so the first request issues the
  // single DNS query and the rest await its promise instead of flooding the
  // resolver. The result is cached (and persisted) for the refresh window.
  _resolveDomainFresh(domain) {
    const inflight = this._bimiInflight.get(domain);
    if (inflight) {
      return inflight;
    }
    const promise = (async () => {
      // Resolve fresh: DNS TXT -> logo URL -> SVG -> data URL.
      const logo = await this._fetchBimiLogo(domain);
      const fresh = logo
        ? { status: "ok", logo, ts: Date.now() }
        : { status: "none", logo: null, ts: Date.now() };
      this._bimiCache.set(domain, fresh);
      this._blog(domain, "→ resolved:", fresh.status, logo ? "(logo shown)" : "(no logo)");
      if (this._fireBimi) {
        try {
          this._fireBimi(domain, JSON.stringify(fresh));
        } catch (e) {
          /* no listener */
        }
      }
      return fresh;
    })();
    this._bimiInflight.set(domain, promise);
    // Clear the in-flight slot once settled so the next refresh can re-resolve.
    promise.then(
      () => this._bimiInflight.delete(domain),
      () => this._bimiInflight.delete(domain)
    );
    return promise;
  }

  async _fetchBimiLogo(domain) {
    const txt = await this._dnsTxt("default._bimi." + domain);
    this._blog(domain, "DNS TXT:", txt ? JSON.stringify(txt) : "(none)");
    if (!txt) {
      return null;
    }
    const rec = globalThis.ThundericonBimi.parseBimiRecord(txt);
    this._blog(domain, "parsed logoUrl:", rec && rec.logoUrl ? rec.logoUrl : "(none)");
    if (!rec || !rec.logoUrl) {
      return null;
    }
    return this._fetchSvgDataUrl(rec.logoUrl);
  }

  // The DoH provider to use for TXT, per user settings. Returns a descriptor
  // from DOH_PROVIDERS, or a descriptor built from the user's custom URL. We
  // honor the explicit choice rather than silently querying a different provider;
  // an invalid/empty custom URL falls back to Cloudflare so BIMI still works.
  _dohProvider() {
    const s = (this._config && this._config.settings) || {};
    if (s.bimiDohProvider === "custom") {
      const base = String(s.bimiDohCustomUrl || "").trim();
      if (/^https:\/\/\S+$/i.test(base)) {
        return { name: "custom (" + base + ")", endpoint: base };
      }
      return DOH_PROVIDERS.cloudflare; // invalid/empty custom URL
    }
    return DOH_PROVIDERS[s.bimiDohProvider] || DOH_PROVIDERS.cloudflare;
  }

  // Resolve a TXT record purely over DNS-over-HTTPS, using the configured
  // provider. Returns the record string (preferring a BIMI1 record), or null.
  // Uses the universal RFC 8484 binary wireformat, which every DoH endpoint
  // understands. DoH (rather than Gecko's resolver) is required because the OS
  // resolver only does A/AAAA — TXT queries need TRR/DoH, which it usually lacks.
  async _dnsTxt(host, log) {
    const note = this._noter(log);
    const p = this._dohProvider();
    note("Resolving TXT over DNS-over-HTTPS via " + p.name + " …");
    const txt = await this._dohFetchWire(p.endpoint, host, log);
    if (txt) {
      note("DoH returned: " + txt);
      return txt;
    }
    return null;
  }

  // Privileged HTTP GET. The experiment sandbox has neither a usable XHR contract
  // ID nor the XMLHttpRequest global, and the logo host sends no CORS header — so
  // we issue the request through NetUtil with the SYSTEM principal, which bypasses
  // CORS. Resolves to { ok, status, text }. Never rejects.
  _httpGet(url, options) {
    options = options || {};
    const note = this._noter(options.log);
    return new Promise((resolve) => {
      const fail = (msg) => resolve({ ok: false, status: 0, text: "", error: msg });
      try {
        const { NetUtil } = ChromeUtils.importESModule(
          "resource://gre/modules/NetUtil.sys.mjs"
        );
        const channel = NetUtil.newChannel({
          uri: url,
          loadUsingSystemPrincipal: true,
          contentPolicyType: Ci.nsIContentPolicy.TYPE_OTHER
        });
        if (options.headers) {
          try {
            const http = channel.QueryInterface(Ci.nsIHttpChannel);
            for (const k of Object.keys(options.headers)) {
              http.setRequestHeader(k, options.headers[k], false);
            }
          } catch (e) {
            /* not an http channel; ignore */
          }
        }
        NetUtil.asyncFetch(channel, (stream, statusCode, request) => {
          try {
            if (!Components.isSuccessCode(statusCode)) {
              fail("nsresult " + statusCode);
              return;
            }
            let httpStatus = 200;
            try {
              httpStatus = request.QueryInterface(Ci.nsIHttpChannel).responseStatus;
            } catch (e) {
              /* non-http (shouldn't happen for https) */
            }
            let text = "";
            try {
              const avail = stream.available();
              if (avail > 0) {
                // Binary mode (DNS wireformat, images) reads raw bytes as a
                // Latin-1 string — one char per byte — so the bytes survive intact.
                text = options.binary
                  ? NetUtil.readInputStreamToString(stream, avail)
                  : NetUtil.readInputStreamToString(stream, avail, { charset: "UTF-8" });
              }
            } catch (e) {
              /* empty body */
            }
            let contentType = "";
            try {
              contentType = request.contentType || "";
            } catch (e) {
              /* non-http or unavailable */
            }
            resolve({
              ok: httpStatus >= 200 && httpStatus < 300,
              status: httpStatus,
              text,
              contentType
            });
          } catch (e) {
            fail(e && e.message ? e.message : String(e));
          }
        });
      } catch (e) {
        // Last resort: plain fetch (works for CORS-enabled endpoints like DoH).
        note("NetUtil unavailable, trying fetch: " + (e && e.message ? e.message : e));
        const init = { method: "GET" };
        if (options.headers) {
          init.headers = options.headers;
        }
        fetch(url, init).then(
          async (resp) => {
            let text = "";
            try {
              if (options.binary) {
                const u8 = new Uint8Array(await resp.arrayBuffer());
                for (let i = 0; i < u8.length; i++) {
                  text += String.fromCharCode(u8[i]);
                }
              } else {
                text = await resp.text();
              }
            } catch (e2) {
              /* ignore */
            }
            let contentType = "";
            try {
              contentType = resp.headers.get("content-type") || "";
            } catch (e2) {
              /* ignore */
            }
            resolve({ ok: resp.ok, status: resp.status, text, contentType });
          },
          (e2) => fail(e2 && e2.message ? e2.message : String(e2))
        );
      }
    });
  }

  // TXT lookup via the RFC 8484 DNS-wireformat: a binary query base64url-encoded
  // into the URL's `dns` parameter, with an Accept of application/dns-message.
  // This is the format every standards-compliant DoH endpoint understands.
  async _dohFetchWire(endpoint, host, log) {
    const note = this._noter(log);
    const Bimi = globalThis.ThundericonBimi;
    if (!Bimi || !Bimi.encodeDnsTxtQuery) {
      return null;
    }
    let url;
    try {
      const dns = Bimi.bytesToBase64Url(Bimi.encodeDnsTxtQuery(host));
      const sep = endpoint.includes("?") ? "&" : "?";
      url = endpoint + sep + "dns=" + dns;
    } catch (e) {
      note("DoH wireformat: failed to build query: " + (e && e.message ? e.message : e));
      return null;
    }
    const res = await this._httpGet(url, {
      headers: { accept: "application/dns-message" },
      binary: true,
      log
    });
    if (!res.ok) {
      note("DoH wireformat request failed (" + (res.status || res.error || "?") + ")");
      return null;
    }
    try {
      const bin = res.text || "";
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) {
        bytes[i] = bin.charCodeAt(i) & 0xff;
      }
      const answers = Bimi.decodeDnsTxtAnswers(bytes);
      const bimi = answers.find((c) => /^v\s*=\s*BIMI1/i.test(c));
      return bimi || answers[0] || null;
    } catch (e) {
      note("DoH wireformat parse error: " + (e && e.message ? e.message : e));
      return null;
    }
  }

  // Fetch a remote SVG (system principal, no CORS) and return a data: URL.
  // Rejects anything that is not a small SVG. Resolves to null on failure.
  async _fetchSvgDataUrl(url, log) {
    const note = this._noter(log);
    const res = await this._httpGet(url, { log });
    const text = res.text || "";
    const looksSvg = /<svg[\s>]/i.test(text);
    const small = text.length <= 64 * 1024;
    note(
      "SVG HTTP " + res.status + ", " + text.length + " bytes, " +
      "looksSvg=" + looksSvg + ", withinSizeLimit=" + small
    );
    if (res.ok && looksSvg && small) {
      return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(text);
    }
    if (!res.ok) {
      note("→ rejected: request failed" + (res.error ? " (" + res.error + ")" : ""));
    } else if (!looksSvg) {
      note("→ rejected: response is not an <svg> document");
    } else if (!small) {
      note("→ rejected: larger than 64 KB limit");
    }
    return null;
  }

  // Did this message pass DMARC? Reads Authentication-Results via the gloda mime
  // parser. Memoized per message-id (session). Fails closed (false) on any error.
  _dmarcPass(msgHdr) {
    return new Promise((resolve) => {
      try {
        if (!msgHdr || !globalThis.ThundericonBimi) {
          resolve(false);
          return;
        }
        const id = msgHdr.messageId || "";
        if (id && this._dmarcCache.has(id)) {
          resolve(this._dmarcCache.get(id));
          return;
        }
        let MsgHdrToMimeMessage;
        try {
          ({ MsgHdrToMimeMessage } = ChromeUtils.importESModule(
            "resource:///modules/gloda/MimeMessage.sys.mjs"
          ));
        } catch (e) {
          ({ MsgHdrToMimeMessage } = ChromeUtils.importESModule(
            "resource:///modules/MimeMessage.sys.mjs"
          ));
        }
        MsgHdrToMimeMessage(
          msgHdr,
          null,
          (hdr, mimeMsg) => {
            let pass = false;
            try {
              const ar =
                mimeMsg && mimeMsg.headers
                  ? mimeMsg.headers["authentication-results"]
                  : null;
              const joined = Array.isArray(ar) ? ar.join("\n") : ar || "";
              pass = globalThis.ThundericonBimi.dmarcPassed(joined);
              this._blog(
                "DMARC",
                pass ? "PASS" : "no-pass",
                "AR=" + (joined ? JSON.stringify(joined.slice(0, 200)) : "(missing)")
              );
            } catch (e) {
              pass = false;
            }
            if (id) {
              this._dmarcCache.set(id, pass);
            }
            resolve(pass);
          },
          false,
          { partsOnDemand: true, examineEncryptedParts: false }
        );
      } catch (e) {
        this._blog("DMARC parse threw:", e && e.message ? e.message : e);
        resolve(false);
      }
    });
  }

  /* ---- Gravatar resolution ---------------------------------------------- */

  _ensureGravatarCore() {
    if (this._gravatarLoaded) {
      return;
    }
    try {
      Services.scriptloader.loadSubScript(this._gravatarCoreURL, globalThis);
      this._gravatarLoaded = !!globalThis.ThundericonGravatar;
      this._blog("gravatar-core loaded:", this._gravatarLoaded);
    } catch (e) {
      this._reportError("gravatar-core load failed: " + (e && e.message ? e.message : e));
    }
  }

  // Resolve the Gravatar photo for a sender address, honoring the TTL'd cache.
  // Returns a data: URL string or null. Always resolves (never rejects) — any
  // failure means "no photo", so the renderer falls back to BIMI / initials.
  // Unlike BIMI there is no DNS or DMARC step: the URL is derived from the hash.
  async _resolveGravatar(email) {
    try {
      const settings = (this._config && this._config.settings) || {};
      const G = globalThis.ThundericonGravatar;
      const Bimi = globalThis.ThundericonBimi;
      if (!settings.gravatarEnabled || !email || !G) {
        return null;
      }
      const key = G.normalizeEmail(email);
      if (!key) {
        return null;
      }
      // Cached result — a found photo OR a cached "none" (respecting the refresh
      // TTL). Negative results are cached too, so an address without a Gravatar is
      // looked up once per refresh window rather than once per message.
      const entry = this._gravatarCache.get(key);
      if (entry && Bimi && Bimi.isFresh(entry.ts, settings.gravatarRefreshHours, Date.now())) {
        this._blog("gravatar", key, "→ cache hit:", entry.status);
        return entry.status === "ok" ? entry.logo : null;
      }
      const fresh = await this._resolveGravatarFresh(key);
      return fresh.status === "ok" ? fresh.logo : null;
    } catch (e) {
      this._blog("gravatar resolve error:", e && e.message ? e.message : e);
      return null;
    }
  }

  // Fetch and cache an address's Gravatar status (a found photo OR a "none"),
  // de-duplicating concurrent lookups per address (a folder full of mail from the
  // same sender asks at once). The result is cached (and persisted) for the
  // refresh window.
  _resolveGravatarFresh(emailKey) {
    const inflight = this._gravatarInflight.get(emailKey);
    if (inflight) {
      return inflight;
    }
    const promise = (async () => {
      const photo = await this._fetchGravatar(emailKey);
      const fresh = photo
        ? { status: "ok", logo: photo, ts: Date.now() }
        : { status: "none", logo: null, ts: Date.now() };
      this._gravatarCache.set(emailKey, fresh);
      this._blog("gravatar", emailKey, "→ resolved:", fresh.status);
      if (this._fireGravatar) {
        try {
          this._fireGravatar(emailKey, JSON.stringify(fresh));
        } catch (e) {
          /* no listener */
        }
      }
      return fresh;
    })();
    this._gravatarInflight.set(emailKey, promise);
    promise.then(
      () => this._gravatarInflight.delete(emailKey),
      () => this._gravatarInflight.delete(emailKey)
    );
    return promise;
  }

  async _fetchGravatar(emailKey, log) {
    const G = globalThis.ThundericonGravatar;
    if (!G) {
      return null;
    }
    const hash = G.hashEmail(emailKey);
    if (!hash) {
      return null;
    }
    const url = G.avatarUrl(hash, GRAVATAR_PX);
    return this._fetchImageDataUrl(url, log);
  }

  // Fetch a remote raster image (system principal, no CORS) and return a base64
  // data: URL. With Gravatar's `d=404`, a missing photo comes back as HTTP 404 →
  // null. Rejects non-image or oversized responses. Resolves to null on failure.
  async _fetchImageDataUrl(url, log) {
    const note = this._noter(log);
    const G = globalThis.ThundericonGravatar;
    const res = await this._httpGet(url, { binary: true, log });
    if (!res.ok) {
      // 404 is the normal "this address has no Gravatar" answer.
      note("Image HTTP " + (res.status || res.error || "?") + " → no photo");
      return null;
    }
    const ct = (res.contentType || "").toLowerCase().split(";")[0].trim();
    const bin = res.text || "";
    const size = bin.length;
    note("Image HTTP " + res.status + ", " + size + " bytes, type=" + (ct || "(none)"));
    if (!/^image\//.test(ct)) {
      note("→ rejected: response is not an image");
      return null;
    }
    if (size === 0 || size > GRAVATAR_MAX_BYTES) {
      note("→ rejected: " + (size === 0 ? "empty body" : "larger than " + GRAVATAR_MAX_BYTES + " bytes"));
      return null;
    }
    if (!G || !G.bytesToBase64) {
      return null;
    }
    const bytes = new Uint8Array(size);
    for (let i = 0; i < size; i++) {
      bytes[i] = bin.charCodeAt(i) & 0xff;
    }
    return "data:" + ct + ";base64," + G.bytesToBase64(bytes);
  }

  // Diagnostic resolve used by the options "Test Gravatar" window. Runs the real
  // hash + image-fetch path (the SAME code as the live list). Returns a structured
  // result with a human-readable step log so problems are visible to the user.
  async _runGravatarTest(query) {
    const log = [];
    const out = (m) => {
      log.push(m);
      this._blog("[gravatar test]", m);
    };
    try {
      this._ensureGravatarCore();
      const G = globalThis.ThundericonGravatar;
      if (!G) {
        out("ERROR: gravatar-core module is not loaded.");
        return { ok: false, log };
      }
      const email = G.normalizeEmail(query);
      if (!email) {
        out("ERROR: please enter a full email address (e.g. name@example.com).");
        return { ok: false, log };
      }
      out("Address: " + email);
      const hash = G.hashEmail(email);
      out("MD5 hash: " + hash);
      const url = G.avatarUrl(hash, GRAVATAR_PX);
      out("Fetching: " + url);
      const dataUrl = await this._fetchImageDataUrl(url, log);
      if (!dataUrl) {
        out("Result: no Gravatar photo for this address (or it failed validation).");
        return { ok: false, email, hash, url, log };
      }
      out("SUCCESS: a Gravatar photo is available for " + email + ".");
      return { ok: true, email, hash, url, dataUrl, log };
    } catch (e) {
      out("ERROR: " + (e && e.message ? e.message : e));
      return { ok: false, log };
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
