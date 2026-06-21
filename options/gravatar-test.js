/**
 * Thundericon — Gravatar test tool.
 *
 * Standalone diagnostic window. Asks the privileged experiment to resolve an
 * address's Gravatar photo (MD5 hash + image fetch) and shows the resulting photo
 * plus a step-by-step log, so hash/fetch problems are visible to the user.
 */
"use strict";

const api = typeof messenger !== "undefined" ? messenger : browser;
const $ = (id) => document.getElementById(id);

// Prefill from ?q= if the opener passed one.
const initialQuery = new URLSearchParams(location.search).get("q");
if (initialQuery) {
  $("query").value = initialQuery;
}

$("form").addEventListener("submit", (e) => {
  e.preventDefault();
  run();
});

function setLog(lines) {
  $("log").textContent = (lines && lines.length ? lines : ["(no output)"]).join("\n");
}

async function run() {
  const query = $("query").value.trim();
  if (!query) {
    return;
  }
  $("run").disabled = true;
  $("result").hidden = true;
  setLog(["Checking " + query + " …"]);

  try {
    const res = await api.threadPaneAvatars.testGravatar(query);
    setLog(res.log);
    showResult(res);
  } catch (e) {
    setLog(["Failed to call the test API: " + (e && e.message ? e.message : e)]);
  } finally {
    $("run").disabled = false;
  }
}

function showResult(res) {
  const badge = $("logoBadge");
  const verdict = $("verdict");
  const meta = $("meta");
  badge.textContent = "";
  meta.textContent = "";

  if (res.ok && res.dataUrl) {
    const img = document.createElement("img");
    img.src = res.dataUrl;
    img.alt = "";
    badge.appendChild(img);
    verdict.textContent = "✓ Gravatar photo found";
    verdict.className = "verdict ok";
    meta.textContent = (res.email || "") + (res.hash ? " — " + res.hash : "");
  } else {
    badge.appendChild(document.createTextNode("—"));
    verdict.textContent = "✗ No Gravatar photo";
    verdict.className = "verdict bad";
    meta.textContent = res.email ? "for " + res.email : "";
  }
  $("result").hidden = false;
}
