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
// Diagnostic logging for the BIMI resolution chain (Error Console). The "Test
// BIMI…" window builds its own in-window log independently, so this can stay off
// for normal use; flip to true to also trace live-list resolution to the console.
const BIMI_DEBUG = false;

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
      this._listenerId = "thundericon-" + context.extension.id;
      this._mailWindows = new Set(); // messenger windows we have hooked
      this._renderers = new Set(); // about:3pane content windows we injected into
      this._winCleanups = new WeakMap(); // window -> cleanup fn
      this._started = false;
      this._bimiCache = new Map(); // domain -> { status, logo, ts }
      this._dmarcCache = new Map(); // messageId -> bool (session only)
      this._bimiLoaded = false;
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

        testBimi: async (query) => this._runBimiTest(query),

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
      // Host bridge the renderer calls to resolve a BIMI logo for a message.
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
      if (settings.bimiBaseDomainOnly) {
        const base = Bimi.baseDomainOf(domain);
        if (base && base !== domain) {
          out("Base-domain lookup is on → using: " + base);
          domain = base;
        }
      }

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
      if (settings.bimiBaseDomainOnly) {
        const base = Bimi.baseDomainOf(domain);
        if (base && base !== domain) {
          this._blog(domain, "→ base domain:", base);
          domain = base;
        }
      }
      // DMARC gate: never show a logo for an unauthenticated message.
      const passed = await this._dmarcPass(msgHdr);
      if (!passed) {
        this._blog(domain, "→ DMARC not pass → initials");
        return null;
      }
      // Cached logo (respecting the refresh TTL).
      const entry = this._bimiCache.get(domain);
      if (entry && Bimi.isFresh(entry.ts, settings.bimiRefreshHours, Date.now())) {
        this._blog(domain, "→ cache hit:", entry.status);
        return entry.status === "ok" ? entry.logo : null;
      }
      // Resolve fresh: DNS TXT -> logo URL -> SVG -> data URL.
      const logo = await this._fetchBimiLogo(domain);
      const fresh = logo
        ? { status: "ok", logo, ts: Date.now() }
        : { status: "none", logo: null, ts: Date.now() };
      this._bimiCache.set(domain, fresh);
      this._blog(domain, "→ resolved:", fresh.status, logo ? "(logo shown)" : "");
      if (this._fireBimi) {
        try {
          this._fireBimi(domain, JSON.stringify(fresh));
        } catch (e) {
          /* no listener */
        }
      }
      return logo;
    } catch (e) {
      this._blog("resolve error:", e && e.message ? e.message : e);
      return null;
    }
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

  // Resolve a TXT record. Tries Thunderbird's own DNS service first (honors the
  // user's system/TRR resolver when it can do TXT), then falls back to
  // DNS-over-HTTPS. The fallback is required because Gecko's OS resolver only
  // does A/AAAA lookups — TXT/by-type queries fail with NS_ERROR_UNKNOWN_HOST
  // unless TRR is enabled, which it usually is not.
  async _dnsTxt(host, log) {
    const native = await this._dnsTxtNative(host, log);
    if (native) {
      return native;
    }
    return this._dnsTxtDoH(host, log);
  }

  // Attempt via nsIDNSService. Resolves to the joined record string, or null on
  // any failure. Thunderbird's DNS API has changed shape across versions
  // (asyncResolve gained a type arg; asyncResolveByType came and went), so we try
  // the known signatures in turn and accept either listener callback — whichever
  // the running build actually invokes.
  _dnsTxtNative(host, log) {
    const note = (m) => {
      this._blog(m);
      if (log) {
        log.push(m);
      }
    };
    return new Promise((resolve) => {
      let settled = false;
      const done = (val) => {
        if (!settled) {
          settled = true;
          resolve(val);
        }
      };
      const handle = (record, status) => {
        try {
          if (!Components.isSuccessCode(status) || !record) {
            note("DNS lookup failed (status=" + status + ")");
            done(null);
            return;
          }
          const txt = record.QueryInterface(Ci.nsIDNSTXTRecord);
          const records = txt.getRecords();
          done(records && records.length ? records.join("") : null);
        } catch (e) {
          note("DNS record parse error: " + (e && e.message ? e.message : e));
          done(null);
        }
      };
      try {
        const dns = Services.dns;
        const TXT =
          (Ci.nsIDNSService && Ci.nsIDNSService.RESOLVE_TYPE_TXT) || 16;
        const listener = {
          onLookupComplete(req, record, status) {
            handle(record, status);
          },
          onLookupByTypeComplete(req, record, status) {
            handle(record, status);
          }
        };
        const target =
          (Services.tm && (Services.tm.mainThread || Services.tm.mainThreadEventTarget)) ||
          null;
        // Try each known signature until one launches without throwing.
        const attempts = [
          ["asyncResolve+resolverInfo", () => dns.asyncResolve(host, TXT, 0, null, listener, target, {})],
          ["asyncResolveByType+resolverInfo", () => dns.asyncResolveByType(host, TXT, 0, null, listener, target, {})],
          ["asyncResolveByType", () => dns.asyncResolveByType(host, TXT, 0, listener, target, {})],
          ["asyncResolve", () => dns.asyncResolve(host, TXT, 0, listener, target, {})]
        ];
        let launched = "";
        for (const [name, fn] of attempts) {
          try {
            fn();
            launched = name;
            break;
          } catch (e) {
            /* signature not supported on this build; try the next */
          }
        }
        if (launched) {
          note("DNS query sent via " + launched);
        } else {
          note("DNS: no usable asyncResolve signature on this build");
          done(null);
        }
      } catch (e) {
        note("DNS error: " + (e && e.message ? e.message : e));
        done(null);
      }
    });
  }

  // The DoH provider to use for TXT, per user settings. Returns a single
  // { name, url } — we honor the explicit choice rather than silently querying a
  // different provider. An invalid custom URL falls back to Cloudflare so BIMI
  // still works.
  _dohProvider() {
    const CLOUDFLARE = {
      name: "Cloudflare",
      url: "https://cloudflare-dns.com/dns-query?type=TXT&name="
    };
    const s = (this._config && this._config.settings) || {};
    switch (s.bimiDohProvider) {
      case "google":
        return { name: "Google", url: "https://dns.google/resolve?type=TXT&name=" };
      case "custom": {
        const base = String(s.bimiDohCustomUrl || "").trim();
        if (/^https:\/\/\S+$/i.test(base)) {
          const sep = base.includes("?") ? "&" : "?";
          return {
            name: "custom (" + base + ")",
            url: base + sep + "type=TXT&name=", // JSON-API form
            endpoint: base, // raw endpoint for the RFC 8484 wireformat
            custom: true
          };
        }
        return CLOUDFLARE; // invalid/empty custom URL
      }
      default:
        return CLOUDFLARE;
    }
  }

  // TXT lookup over DNS-over-HTTPS, using the configured provider. Returns the
  // record string (preferring a BIMI1 record), or null. This is what makes BIMI
  // work on a normal profile, at the cost of sending the queried name to the DoH
  // provider instead of the system resolver.
  //
  // The built-in Cloudflare/Google providers use the JSON DoH API. Custom
  // endpoints try the universal RFC 8484 binary wireformat first (AdGuard, Quad9,
  // NextDNS, self-hosted resolvers and even Google's /dns-query only speak that),
  // and fall back to JSON for the rarer JSON-only endpoint.
  async _dnsTxtDoH(host, log) {
    const note = (m) => {
      this._blog(m);
      if (log) {
        log.push(m);
      }
    };
    const p = this._dohProvider();
    note("Falling back to DNS-over-HTTPS via " + p.name + " …");

    if (p.custom) {
      const wire = await this._dohFetchWire(p.endpoint, host, log);
      if (wire) {
        note("DoH returned (wireformat): " + wire);
        return wire;
      }
      note("Wireformat lookup yielded nothing; trying the JSON DoH API …");
      const json = await this._dohFetchJson(p.url + encodeURIComponent(host), log);
      if (json) {
        note("DoH returned (JSON): " + json);
        return json;
      }
      return null;
    }

    const txt = await this._dohFetchJson(p.url + encodeURIComponent(host), log);
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
    const note = (m) => {
      this._blog(m);
      if (options.log) {
        options.log.push(m);
      }
    };
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
                // Binary mode (DNS wireformat) reads raw bytes as a Latin-1 string
                // — one char per byte — so the bytes survive intact for decoding.
                text = options.binary
                  ? NetUtil.readInputStreamToString(stream, avail)
                  : NetUtil.readInputStreamToString(stream, avail, { charset: "UTF-8" });
              }
            } catch (e) {
              /* empty body */
            }
            resolve({ ok: httpStatus >= 200 && httpStatus < 300, status: httpStatus, text });
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
            resolve({ ok: resp.ok, status: resp.status, text });
          },
          (e2) => fail(e2 && e2.message ? e2.message : String(e2))
        );
      }
    });
  }

  // TXT lookup via the JSON DoH API (Cloudflare/Google style).
  async _dohFetchJson(url, log) {
    const note = (m) => {
      this._blog(m);
      if (log) {
        log.push(m);
      }
    };
    const Bimi = globalThis.ThundericonBimi;
    const res = await this._httpGet(url, {
      headers: { accept: "application/dns-json" }, // Cloudflare needs this for JSON
      log
    });
    if (!res.ok) {
      note("DoH request failed (" + (res.status || res.error || "?") + ")");
      return null;
    }
    try {
      const data = JSON.parse(res.text || "{}");
      const answers = Array.isArray(data.Answer) ? data.Answer : [];
      const candidates = [];
      for (const a of answers) {
        if (a && Number(a.type) === 16) {
          const s = (Bimi ? Bimi.txtFromDohData(a.data) : String(a.data || "")).trim();
          if (s) {
            candidates.push(s);
          }
        }
      }
      const bimi = candidates.find((c) => /^v\s*=\s*BIMI1/i.test(c));
      return bimi || candidates[0] || null;
    } catch (e) {
      note("DoH parse error: " + (e && e.message ? e.message : e));
      return null;
    }
  }

  // TXT lookup via the RFC 8484 DNS-wireformat: a binary query base64url-encoded
  // into the URL's `dns` parameter, with an Accept of application/dns-message.
  // This is the format every standards-compliant DoH endpoint understands.
  async _dohFetchWire(endpoint, host, log) {
    const note = (m) => {
      this._blog(m);
      if (log) {
        log.push(m);
      }
    };
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
    const note = (m) => {
      this._blog(m);
      if (log) {
        log.push(m);
      }
    };
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
