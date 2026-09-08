#!/usr/bin/env node
// smoke — run the Face's real boot script against a live door, without a browser.
//
// Two legs. GATE: with no cookie, / must bounce to /login, /login must serve the form, /health
// must be public and name the gate, and a door must answer 401 — each of those can go red.
// SESSION: only with WOSP_PASSWORD in the environment (the operator's shell, never a file): log in,
// then evaluate the page's inline <script> in a vm context with a DOM stub and the cookie,
// wait for runProbes() to reach its membrane line, and run one real DwEC through the door.
//
// This is a receipt of the page's own logic against live organs. It is not a pixel test.
// Not under test/ on purpose: it needs the network. Run: node smoke.mjs [origin] [profile]
//
// fabricated:false
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const ORIGIN = (process.argv[2] || "https://<your-console-host>").replace(/\/+$/, "");
const html = readFileSync(join(here, "public", "index.html"), "utf8");
const script = html.split("<script>")[1].split("</script>")[0];

// ── GATE leg ──────────────────────────────────────────────────────────────────
console.log(`origin     ${ORIGIN}`);
const r0 = await fetch(ORIGIN + "/", { redirect: "manual" });
const loc = r0.headers.get("location") || "";
const r1 = await fetch(ORIGIN + "/login");
const t1 = await r1.text();
const r2 = await fetch(ORIGIN + "/v1/pane/health");
const h = await (await fetch(ORIGIN + "/health")).json();
const gateOk = r0.status === 302 && /\/login$/.test(loc) && r1.status === 200 && t1.includes('id="login"') && r2.status === 401 && ["armed", "unminted"].includes(h.gate && h.gate.gate);
console.log(`gate       / → ${r0.status} ${loc || "(no location)"} · /login ${r1.status}${t1.includes('id="login"') ? " form" : " NO FORM"} · door without cookie ${r2.status} · gate ${h.gate && h.gate.gate}${h.gate && h.gate.user ? " " + h.gate.user : ""}`);
console.log(gateOk ? "GATE: PASS — the Face is shut to a stranger and open only through /login." : "GATE: FAIL -- a stranger got past the door, or the door is missing.");

const PASS = process.env.WOSP_PASSWORD;
if (!PASS) {
  console.log("\nSESSION: SKIPPED — no WOSP_PASSWORD in the environment; the boot script and DwEC legs need the operator's session. Run: WOSP_PASSWORD=… node smoke.mjs");
  process.exit(gateOk ? 0 : 1);
}

// ── SESSION leg ───────────────────────────────────────────────────────────────
const lr = await fetch(ORIGIN + "/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: process.env.WOSP_USER || "operator@smbos", password: PASS }) });
const lj = await lr.json();
if (lr.status !== 200) { console.log(`\nSESSION: FAIL -- login ${lr.status} ${lj.reason || ""}`); process.exit(1); }
const COOKIE = (lr.headers.get("set-cookie") || "").split(";")[0];
console.log(`\nsession    ${lj.user} · ${lj.role} · ${lj.ttl_s}s`);

const els = new Map();
function el(id) {
  if (!els.has(id)) {
    els.set(id, { id, textContent: "", innerHTML: "", className: "", hidden: false, href: "", value: "", checked: false, tabIndex: 0, dataset: {}, attrs: {},
      setAttribute(k, v) { this.attrs[k] = String(v); }, addEventListener() {}, focus() {} });
  }
  return els.get(id);
}
const document = { getElementById: el, querySelectorAll: () => [], querySelector: () => null };
const location = { protocol: "https:", origin: ORIGIN, host: new URL(ORIGIN).host, replace(u) { console.log(`location.replace(${u}) — the page was sent to the door`); } };
const fetchAbs = (u, init = {}) => fetch(u.startsWith("/") ? ORIGIN + u : u, { ...init, headers: { ...(init.headers || {}), cookie: COOKIE } });
const ctx = vm.createContext({ document, location, navigator: {}, fetch: fetchAbs, setTimeout, clearTimeout, console, Promise, JSON, Date, URL, Object, Error });
vm.runInContext(script, ctx, { filename: "index.html#script" });

const deadline = Date.now() + 90_000;
while (Date.now() < deadline) { if (el("probelog").textContent.includes("membrane:")) break; await new Promise(r => setTimeout(r, 300)); }
const show = (id, prop = "textContent") => console.log(`${id.padEnd(10)} ${String(el(id)[prop]).replace(/<[^>]+>/g, "").slice(0, 140)}`);
for (const id of ["door", "p-who", "p-pane", "p-ide", "p-face", "p-kern", "s-kernel", "r-door", "r-pane", "r-ide", "r-closer", "r-face", "r-top"]) show(id);
console.log("--- probelog ---"); console.log(el("probelog").textContent);
const log = el("probelog").textContent;
const ok = log.includes("membrane:") && /pane\s+200/.test(log) && /ide\s+200/.test(log) && el("s-kernel").textContent === "A=LAG" && /operator@smbos/.test(el("p-who").textContent);
console.log(ok ? "\nSMOKE: PASS — the page read live receipts through its door as operator@smbos and the Kernel is A=LAG." : "\nSMOKE: FAIL -- the page did not read live receipts.");

const profile = process.argv[3] || "tanoak";
let dwecOk = false;
try {
  const r = await fetch(ORIGIN + "/v1/dwec/run", { method: "POST", headers: { "content-type": "application/json", cookie: COOKIE }, body: JSON.stringify({ profile }) });
  const j = await r.json();
  console.log(`\n--- DwEC ${profile} ---`);
  console.log(`CLOSER  ${Object.entries(j.CLOSER || {}).map(([k, v]) => k[0] + (v ? "✓" : "✗")).join(" ")}   ${j.green ? "GREEN" : "RED " + (j.red || []).join(",")}`);
  console.log(`digest  expected ${String(j.expected_digest).slice(0, 16)}  reported ${String(j.reported_digest).slice(0, 16)}`);
  console.log(`record  ${j.stages && j.stages.record && j.stages.record.ok ? j.stages.record.workspace + " · " + String(j.stages.record.ledger_digest).slice(0, 16) : "NO_SIGNAL"}`);
  console.log(`power3  ${j.powerof3 ? (j.powerof3.admitted ? "ADMITTED" : "REFUSED") + " — " + j.powerof3.reason : "—"}`);
  console.log(`dispose A=${j.A}   ${j.ms} ms`);
  dwecOk = j.green === true && j.A === "LAG";
} catch (e) { console.log(`\n--- DwEC --- NO_SIGNAL ${e.message}`); }
console.log(dwecOk ? "DWEC: GREEN — four stages closed at the edge and were recorded." : "DWEC: RED -- a letter is red or the run did not return.");
process.exit(gateOk && ok && dwecOk ? 0 : 1);
