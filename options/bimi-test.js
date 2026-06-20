/**
 * Thundericon — BIMI test tool.
 *
 * Standalone diagnostic window. Asks the privileged experiment to resolve a
 * domain's BIMI logo (DNS + SVG fetch, no DMARC gate) and shows the resulting
 * logo plus a step-by-step log, so DNS/fetch problems are visible to the user.
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
    const res = await api.threadPaneAvatars.testBimi(query);
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
    verdict.textContent = "✓ BIMI logo found";
    verdict.className = "verdict ok";
    meta.textContent = (res.domain || "") + (res.logoUrl ? " — " + res.logoUrl : "");
  } else {
    badge.appendChild(document.createTextNode("—"));
    verdict.textContent = "✗ No displayable BIMI logo";
    verdict.className = "verdict bad";
    meta.textContent = res.domain ? "for " + res.domain : "";
  }
  $("result").hidden = false;
}
