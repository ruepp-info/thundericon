"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadExperiment() {
  const registrations = [];
  const handle = {
    destructCalls: 0,
    destruct() {
      this.destructCalls++;
    }
  };
  const services = {
    io: {
      newURI(spec, charset, base) {
        return { spec, charset, base };
      }
    }
  };
  const sandbox = {
    console,
    Services: services,
    Ci: { amIAddonManagerStartup: Symbol("amIAddonManagerStartup") },
    Components: {
      classes: {
        "@mozilla.org/addons/addon-manager-startup;1": {
          getService(iface) {
            return {
              registerChrome(manifestURI, entries) {
                registrations.push({ iface, manifestURI, entries });
                return handle;
              }
            };
          }
        }
      }
    },
    ChromeUtils: {
      importESModule(url) {
        if (url.endsWith("ExtensionCommon.sys.mjs")) {
          return {
            ExtensionCommon: {
              ExtensionAPI: class {},
              EventManager: class {
                api() {
                  return {};
                }
              }
            }
          };
        }
        return { ExtensionSupport: {} };
      }
    }
  };
  vm.createContext(sandbox);
  const source = fs.readFileSync(
    path.join(__dirname, "../api/threadpane/implementation.js"),
    "utf8"
  );
  vm.runInContext(source, sandbox);
  return { Api: sandbox.threadPaneAvatars, registrations, handle };
}

test("Experiment registers CSP-compatible chrome URLs for injected assets", () => {
  const { Api, registrations, handle } = loadExperiment();
  const instance = new Api();
  const rootURI = { spec: "moz-extension://example/" };
  instance.getAPI({
    extension: {
      id: "thundericon@thundericon.addons",
      rootURI,
      getURL: file => "moz-extension://example/" + file
    }
  });

  assert.equal(registrations.length, 1);
  // Values created inside vm have a different Array prototype, so compare the
  // structured data after crossing the realm boundary.
  assert.equal(
    JSON.stringify(registrations[0].entries),
    JSON.stringify([["content", "thundericon", "./"]])
  );
  assert.equal(registrations[0].manifestURI.spec, "manifest.json");
  assert.equal(registrations[0].manifestURI.base, rootURI);
  assert.equal(
    instance._rendererURL,
    "chrome://thundericon/content/injected/avatar-renderer.js"
  );
  assert.equal(
    instance._cssURL,
    "chrome://thundericon/content/injected/avatars.css"
  );

  instance.onShutdown(true);
  assert.equal(handle.destructCalls, 1);
});
