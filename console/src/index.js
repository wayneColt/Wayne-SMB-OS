/**
 * wosp-console — the door for the WOSP Face, and the DwEC runner at the edge.
 *
 * Serves the static console (public/index.html) and opens exactly the doors the console
 * calls, same-origin, so the browser never crosses an origin:
 *
 *   /v1/pane/*  →  wayne-aios-control-pane      (service binding CONTROL_PANE)
 *   /v1/ide/*   →  wayne-cdn-container-sandbox  (service binding DEV_IDE)
 *
 * and composes one workflow from those doors plus the state organ:
 *
 *   /v1/dwec        contract
 *   /v1/dwec/run    DwEC — Development with Embedded Completion — run at the edge:
 *                   Plan (SOTR + catalog from the pane) → Engineer (the container compiles
 *                   the instance) → Compose (pane + sandbox + metal) → Close (CLOSER computed
 *                   HERE, including a recomputation of the instance digest, so the container's
 *                   own 6/6 is checked, not trusted) → Record (wayne-main-state, append-only
 *                   ledger) → dispose (POST configure → A=LAG). Propose only.
 *   /v1/dwec/runs   the last runs from the ledger
 *
 * Why a door at all. The pane and the IDE send no CORS headers and have no OPTIONS route.
 * Measured 2026-09-04: from file:// every probe on the console read NO_SIGNAL while both
 * organs were 200 by curl. Bindings are the composition primitive (wayne_main/wrangler.jsonc):
 * public hostnames do not route Worker-to-Worker; a binding does.
 *
 * Proposes only. Every upstream is propose-only; nothing here can reach an accept path, and
 * no route is opened that the console does not call. The allowlist below IS the contract —
 * tools/console_parity.py holds the HTML to it, and test/ holds it to itself.
 *
 * fabricated:false
 */

import * as gate from "./gate.js";
import * as apex from "./apex.js";
export { gate, apex };
export const APEX_KEY = "apex:state";          // KV: the three instruments, written only by a root session
export const APEX_WORKSPACE = "apex:wosp";     // STATE mirror the gate and metal read (dial + switchboard + chronometer)
export const LAMPS_WORKSPACE = "apex:lamps";   // STATE: workers trip lamps here; the operator resets them
export const WOSP_PROFILES = new Set(["kssp", "tanoak", "verdict"]);

/** Upstream organs by binding name. The service names must match wrangler.jsonc. */
export const UPSTREAM = Object.freeze({
  CONTROL_PANE: "wayne-aios-control-pane",
  DEV_IDE: "wayne-cdn-container-sandbox",
  STATE: "wayne-main-state",
  RCQA: "rc-qa-gate",              // SMBOS · the Store A call-QA ladder (sys-firewall) — read-only: health + stats
  EPIDERMIS: "epidermis",          // the chat surface's organ — read-only: /health only (the `chat` circuit's card)
});

/** Wayne.com surface circuits → the health card that proves the organ exists this epoch.
 *  Read ONLY for circuits that are ON (an OFF circuit costs nothing and claims nothing), through
 *  bindings — never a public fetch to a workers.dev peer (error 1042). A card that cannot be read
 *  trips the lamp: an armed circuit that cannot prove itself is a trip, not a pass. Lamps are readouts:
 *  these are derived at read time and are never persisted, so a hand cannot "reset" a dead card. */
export const SURFACE_CARDS = Object.freeze({
  comms:     ["RCQA",         "/health",            (j) => !!(j && j.subscription && j.subscription.ok), "rc-qa subscription ok"],
  shell:     ["CONTROL_PANE", "/health",            (j) => !!(j && j.deployed),                          "control pane deployed"],
  container: ["DEV_IDE",      "/health",            (j) => !!(j && j.deployed),                          "container sandbox deployed"],
  chat:      ["EPIDERMIS",    "/health",            (j) => !!(j && j.ok),                                "epidermis ok"],
  canvas:    null,   // no organ and no card yet — an armed canvas cannot prove it exists
  task:      ["STATE",        "/state/dwec:wosp",   (j) => !!(j && j.state && Object.keys(j.state).length), "DwEC ledger present"],
});
export async function surfaceLamps(env, st, now = () => new Date().toISOString()) {
  const armed = st.switchboard.circuits.filter((c) => c.toggle === "ON" && c.id in SURFACE_CARDS);
  const out = {};
  await Promise.all(armed.map(async (c) => {
    const spec = SURFACE_CARDS[c.id];
    if (!spec) { out[c.id] = { by: "health-card", why: "no organ and no card — an armed circuit that cannot prove it exists", at: now() }; return; }
    const [binding, path, okFn, expects] = spec;
    const b = env[binding];
    if (!b) { out[c.id] = { by: "health-card", why: `binding ${binding} absent`, at: now() }; return; }
    try {
      const r = await b.fetch("https://internal" + path, { signal: AbortSignal.timeout(4000) });
      const j = r.status === 200 ? await readJson(r) : null;
      if (!okFn(j)) out[c.id] = { by: "health-card", why: `${UPSTREAM[binding] || binding}${path} did not read "${expects}" (HTTP ${r.status})`, at: now() };
    } catch (e) { out[c.id] = { by: "health-card", why: `${UPSTREAM[binding] || binding}${path} unreachable (${(e && e.name) || "error"})`, at: now() }; }
  }));
  return out;
}

/** The proxy allowlist. "METHOD /console/path" → [binding, upstream path]. Nothing else is opened. */
export const DOORS = Object.freeze({
  "GET /v1/pane/health":     ["CONTROL_PANE", "/health"],
  "GET /v1/pane/sotr":       ["CONTROL_PANE", "/v1/sotr"],
  "GET /v1/pane/configure":  ["CONTROL_PANE", "/v1/configure"],
  "POST /v1/pane/configure": ["CONTROL_PANE", "/v1/configure"],
  "GET /v1/ide/health":      ["DEV_IDE", "/health"],
  "GET /v1/ide/wosp/loop":   ["DEV_IDE", "/v1/wosp/loop"],
});

/** Composed routes: handled here, built only from DOORS-class calls plus the state organ. */
export const COMPOSED = Object.freeze({
  "GET /v1/dwec":      "contract",
  "POST /v1/dwec/run": "Plan → Engineer → Compose → Close → Record → dispose (A=LAG)",
  "GET /v1/dwec/runs": "last runs from the wayne-main-state ledger",
  "GET /v1/desk":      "the operator's desk as WayneIQ metal attested it to the state organ (tray, WATCH headline, local organs)",
  // the gate — composed here, never proxied; the cookie opens the Face's doors, nothing more
  "POST /v1/auth/login":  "login → HMAC session cookie (12 h, HttpOnly, Strict); credentials checked against the minted record in WOSP_AUTH",
  "POST /v1/auth/logout": "clears the session cookie",
  "GET /v1/auth/whoami":  "the session's claims {user, role, exp} or 401",
  // the apex plane — three instruments, writable by a root session only; the Oracle and workers READ the STATE mirror
  "GET /v1/apex":              "the three instruments with their derived readouts (detent, budget, confidence, mask, lamps, armed state)",
  "PUT /v1/apex/dial":         "wetware: set the Silver Precision Dial {position 0..100}",
  "PUT /v1/apex/chronometer":  "wetware: pull or seat a pin {tick, out, inscription, epoch} or {gears}",
  "PUT /v1/apex/switchboard":  "wetware: set a toggle {id, toggle} or reset a lamp {id, reset:true}",
  // SMBOS — the Store A pipeline as the operator sees it: subscription, SMS gate, ladder progress, the the client headline
  "GET /v1/smbos":              "rc-qa-gate /health + /stats?store=<STOREA|STOREB> composed into one card; read-only",
  "GET /v1/smbos/feed": "the instant-feedback organ: latest graded Store A calls with coaching notes, through the RCQA binding (internal-only on the gate)",
});

export const DWEC_WORKSPACE = "dwec:wosp";          // namespaced like the IDE's ide:<workspace>
export const DWEC_METAL_WORKSPACE = "dwec:metal";   // written by the WaynePC bridge drain, read here
export const METAL_FRESH_S = 24 * 3600;
export const DESK_WORKSPACE = "desk:wayneiq";        // written by wayneiq-desk-attest.timer on WayneIQ, read here
export const DESK_FRESH_S = 25 * 60;                 // two missed 10-minute beats means the attestor is down, not the desk quiet

/** Upstream paths that are, or lead to, an accept or a deploy. A door to any of these is a defect. */
export const FORBIDDEN_UPSTREAM = /(propose|accept|deploy|publish|citl|ceo|exec\b|rollback|secret)/i;

export const MAX_BODY = 16 * 1024;

/** Audit a door table. Returns a list of violations; empty means the table is sound. */
export function auditDoors(doors, upstream = UPSTREAM) {
  const out = [];
  for (const [key, val] of Object.entries(doors)) {
    const m = /^(GET|POST) (\/v1\/(pane|ide)\/[a-z0-9/_-]+)$/.exec(key);
    if (!m) { out.push(`${key}: key must be "GET|POST /v1/(pane|ide)/..."`); continue; }
    if (!Array.isArray(val) || val.length !== 2) { out.push(`${key}: value must be [binding, upstreamPath]`); continue; }
    const [binding, path] = val;
    if (!(binding in upstream)) out.push(`${key}: unknown binding ${binding}`);
    if (typeof path !== "string" || !path.startsWith("/")) out.push(`${key}: upstream path must start with /`);
    else if (FORBIDDEN_UPSTREAM.test(path)) out.push(`${key}: upstream ${path} is an accept/deploy path`);
    if (m[3] === "pane" && binding !== "CONTROL_PANE") out.push(`${key}: /v1/pane must bind CONTROL_PANE`);
    if (m[3] === "ide" && binding !== "DEV_IDE") out.push(`${key}: /v1/ide must bind DEV_IDE`);
    if (m[1] === "POST" && path !== "/v1/configure") out.push(`${key}: the only POST door is configure`);
  }
  return out;
}

/** Resolve a request to a door, or null. Trailing slashes are ignored; methods are exact. */
export function route(method, pathname) {
  const path = String(pathname).replace(/\/+$/, "") || "/";
  const key = `${String(method).toUpperCase()} ${path}`;
  const hit = DOORS[key];
  if (!hit) return null;
  return { key, binding: hit[0], upstream: hit[1], service: UPSTREAM[hit[0]] };
}

const BASE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "x-wosp-door": "wosp-console",
  "x-content-type-options": "nosniff",
});

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body, null, 1), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...BASE_HEADERS, ...extra },
  });
}

export const noSignal = (reason, status = 404, more = {}) =>
  json({ membrane: "NO_SIGNAL", reason, ...more, fabricated: false }, status);

/* ── python repr, byte-faithful for the instance source ─────────────────────────────── */

export function pyStr(s) {
  const hasS = s.includes("'"), hasD = s.includes('"');
  const q = hasS && !hasD ? '"' : "'";
  let out = "";
  for (const ch of s) {
    if (ch === "\\") out += "\\\\";
    else if (ch === q) out += "\\" + q;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\r") out += "\\r";
    else out += ch;
  }
  return q + out + q;
}

export function pyRepr(v) {
  if (v === true) return "True";
  if (v === false) return "False";
  if (v === null || v === undefined) return "None";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(v);
  if (typeof v === "string") return pyStr(v);
  if (Array.isArray(v)) return "[" + v.map(pyRepr).join(", ") + "]";
  if (typeof v === "object") return "{" + Object.entries(v).map(([k, x]) => pyStr(k) + ": " + pyRepr(x)).join(", ") + "}";
  return String(v);
}

/** The instance source exactly as wosp/loop.py and the container emit it (whitespace is load-bearing). */
export function instanceSrc(profile, knobs) {
  return `PROFILE = ${pyStr(profile)}\nKNOBS = ${pyRepr(knobs)}\ndef instance():\n    return {'profile': PROFILE, 'knobs': KNOBS, 'organ': 'WOSP'}\n`;
}

export async function sha256hex(s) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const sameSet = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && [...a].sort().join(" ") === [...b].sort().join(" ");

async function readJson(r) {
  const t = await r.text();
  try { return JSON.parse(t); } catch (_) { return null; }
}

/** Read text and JSON both: the bytes are what PowerOf3 hashes; the JSON is what the stages use. */
async function readBoth(r) {
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (_) { /* not json */ }
  return { t, j };
}

/* ── DwEC ───────────────────────────────────────────────────────────────────────────── */

export function dwecContract() {
  return {
    name: "DwEC",
    expansion: "Development with Embedded Completion",
    where: "wosp-console, at the edge, from service bindings only",
    steps: {
      plan: "GET pane /v1/sotr (instance list) + GET pane /v1/configure (knob catalog for the profile)",
      engineer: "GET ide /v1/wosp/loop?profile — the container compiles the instance and reports its digest",
      compose: "pane health + sandbox product + metal: the WaynePC DwEC bridge drain's attestation read from the state organ (dwec:metal) — the edge never reaches the LAN",
      close: "CLOSER computed here: Complete · Linked · Observed · Specified · Expected (digest recomputed from the byte-faithful source) · Recorded",
      record: `PUT wayne-main-state /state/${DWEC_WORKSPACE} — the Durable Object logs every write, append-only`,
      dispose: "POST pane /v1/configure with the composed knobs → A=LAG until the Kernel accepts",
    },
    powerof3: "three legs, each with a stated bound, the sha256 (16 hex) of the bytes it read recomputed here, and a model name — pane (catalog), sandbox (compiled instance), edge (this Worker recomputing the digest). Admitted only when every leg is hashed, ≥2 distinct models agree, and the edge hash matches the sandbox's. No LLM is consulted; the loop is deterministic (staged_epidermis/AIOS/powerof3.py semantics).",
    closer_definitions: "re-derived for the edge from wosp/loop.py:95-117 so each letter is a measurement of a different organ: Complete (compiled, finished, catalog and pane present) · Linked (compiled knob names == pane catalog) · Observed (pane and sandbox answered 200 through bindings this run) · Specified (profile in the SOTR instance list and the allowlist, and the product names it) · Expected (sha256 of the byte-faithful instance source == the digest the sandbox reported) · Recorded (the state organ acknowledged the write with a digest)",
    can_go_red: "test/dwec.test.js plants a wrong digest, a missing knob, a dead IDE, a missing SOTR row, and a missing ledger; each turns a letter red",
    profiles: [...WOSP_PROFILES],
    proposes_only: true,
    kernel_accept: false,
    fabricated: false,
  };
}

export async function runDwec(env, profile) {
  const t0 = Date.now();
  const ts = new Date().toISOString();
  const run = { kind: "wosp_dwec_run", profile, ts, stages: {}, CLOSER: null, red: [], green: false, powerof3: null, A: null, kernel_accept: false, fabricated: false };
  const pane = env.CONTROL_PANE, ide = env.DEV_IDE;

  // PLAN — the SOTR names the instances; the catalog names the knobs.
  const plan = { step: "PLAN", http: {}, instances: null, knob_names: null };
  if (pane) {
    try { const r = await pane.fetch("https://internal/v1/sotr"); plan.http.sotr = r.status; const { t, j } = await readBoth(r); plan._bytes = (plan._bytes || "") + t; plan.instances = j && Array.isArray(j.instances) ? j.instances.map((i) => i.id) : null; }
    catch (e) { plan.http.sotr = "NO_SIGNAL"; plan.sotr_error = String((e && e.message) || e); }
    try { const r = await pane.fetch("https://internal/v1/configure"); plan.http.catalog = r.status; const { t, j } = await readBoth(r); plan._bytes = (plan._bytes || "") + "\n" + t; const row = j && Array.isArray(j.catalog) ? j.catalog.find((c) => c.profile === profile) : null; plan.knob_names = row ? row.knobs : null; }
    catch (e) { plan.http.catalog = "NO_SIGNAL"; plan.catalog_error = String((e && e.message) || e); }
  } else plan.error = "binding CONTROL_PANE absent";
  run.stages.plan = plan;

  // ENGINEER — the container compiles the instance (py_compile is the engineer).
  const eng = { step: "ENGINEER", http: null, exitCode: null, finished: null, product: null, container_CLOSER: null };
  if (ide) {
    try {
      const r = await ide.fetch(`https://internal/v1/wosp/loop?profile=${encodeURIComponent(profile)}`);
      eng.http = r.status; const { t, j } = await readBoth(r); eng._bytes = t;
      if (j) { eng.exitCode = j.exitCode; eng.finished = j.loop ? j.loop.finished : null; eng.product = j.loop ? j.loop.product : null; eng.container_CLOSER = j.loop ? j.loop.CLOSER : null; }
    } catch (e) { eng.http = "NO_SIGNAL"; eng.error = String((e && e.message) || e); }
  } else eng.error = "binding DEV_IDE absent";
  run.stages.engineer = eng;

  // COMPOSE — pane + sandbox + metal.
  const comp = { step: "COMPOSE", pane: null, sandbox: null, metal: null };
  if (pane) {
    try { const r = await pane.fetch("https://internal/health"); const j = await readJson(r); comp.pane = { http: r.status, service: j && j.service, apex: j && j.apex, kernel_accept: j && j.kernel_accept }; }
    catch (e) { comp.pane = { membrane: "NO_SIGNAL", reason: String((e && e.message) || e) }; }
  } else comp.pane = { membrane: "NO_SIGNAL", reason: "binding CONTROL_PANE absent" };
  comp.sandbox = eng.http === 200 ? { http: 200, ide: UPSTREAM.DEV_IDE, digest: eng.product && eng.product.digest } : { membrane: "NO_SIGNAL", http: eng.http };
  // metal — the edge cannot reach the LAN by design. WaynePC's DwEC bridge drain runs the
  // pinned loop on its own substrate, asks the nine bridge agents for evidence, and writes an
  // attestation to the state organ (workspace dwec:metal, key = profile). We read it; we never
  // reach for it.
  let metalBytes = null;
  comp.metal = { membrane: "NO_SIGNAL", reason: "no attestation on dwec:metal for this profile; the WaynePC drain has not run, or STATE is unbound" };
  if (env.STATE) {
    try {
      const g = await env.STATE.fetch(`https://internal/state/${DWEC_METAL_WORKSPACE}`);
      const { t, j } = await readBoth(g);
      const att = j && j.state ? j.state[profile] : null;
      if (att && typeof att === "object") {
        metalBytes = JSON.stringify(att);
        const ageS = att.attested_at ? Math.round((Date.now() - Date.parse(att.attested_at)) / 1000) : null;
        comp.metal = { seat: att.seat || "metal", attested_at: att.attested_at || null, age_s: ageS, digest: att.digest || null, loop_sha256: att.loop_sha256 || null,
          bridge: att.bridge ? { port: att.bridge.port, agents: att.bridge.agents, loaded: att.bridge.loaded, tasks: (att.bridge.tasks || []).length, completed: (att.bridge.tasks || []).filter((x) => x.status === "COMPLETED").length } : null,
          fresh: ageS !== null && ageS < METAL_FRESH_S };
      }
    } catch (e) { comp.metal = { membrane: "NO_SIGNAL", reason: String((e && e.message) || e) }; }
  }
  run.stages.compose = comp;

  // CLOSE — computed here. The container's own 6/6 is a claim; these letters are measurements.
  const expected = eng.product && eng.product.knobs && typeof eng.product.profile === "string" ? await sha256hex(instanceSrc(eng.product.profile, eng.product.knobs)) : null;
  const C = {
    Complete:  !!(eng.product && eng.exitCode === 0 && eng.finished === true && plan.knob_names && comp.pane && comp.pane.http === 200),
    Linked:    !!(eng.product && plan.knob_names && sameSet(Object.keys(eng.product.knobs || {}), plan.knob_names)),
    Observed:  !!(comp.pane && comp.pane.http === 200 && eng.http === 200),
    Specified: !!(plan.instances && plan.instances.includes(profile) && WOSP_PROFILES.has(profile) && eng.product && eng.product.profile === profile),
    Expected:  !!(expected && eng.product && expected === eng.product.digest),
    Recorded:  false,
  };
  run.expected_digest = expected;
  run.reported_digest = eng.product ? eng.product.digest : null;

  // dispose — propose the composed knobs; the Kernel answers.
  if (pane) {
    try {
      const r = await pane.fetch("https://internal/v1/configure", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile, knobs: eng.product ? eng.product.knobs : {} }) });
      const j = await readJson(r); run.A = j && typeof j.A === "string" ? j.A.toUpperCase() : "NO_SIGNAL"; run.dispose = j;
    } catch (e) { run.A = "NO_SIGNAL"; run.dispose = { membrane: "NO_SIGNAL", reason: String((e && e.message) || e) }; }
  } else run.A = "NO_SIGNAL";

  // RECORD — wayne-main-state; the Durable Object logs each write.
  const rec = { step: "RECORD", workspace: DWEC_WORKSPACE, ok: false };
  const id = `${ts.replace(/[-:.TZ]/g, "").slice(0, 14)}-${profile}`;
  const summary = { id, ts, profile, A: run.A, CLOSER: null, digest: run.reported_digest, expected, green: false };
  if (env.STATE) {
    try {
      let prev = [];
      try { const g = await env.STATE.fetch(`https://internal/state/${DWEC_WORKSPACE}`); const gj = await readJson(g); prev = gj && gj.state && Array.isArray(gj.state.runs) ? gj.state.runs : []; } catch (_) { /* first run */ }
      const provisional = { ...C, Recorded: true };
      summary.CLOSER = provisional; summary.green = Object.values(provisional).every(Boolean);
      const w = await env.STATE.fetch(`https://internal/state/${DWEC_WORKSPACE}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ last_run: summary, runs: [summary, ...prev].slice(0, 20) }) });
      const wj = await readJson(w); rec.ok = !!(wj && wj.ok); rec.ledger_digest = wj && wj.digest; rec.id = id; rec.http = w.status;
    } catch (e) { rec.error = String((e && e.message) || e); }
  } else rec.error = "binding STATE absent";
  C.Recorded = rec.ok;
  run.stages.record = rec;

  run.CLOSER = C;
  run.red = Object.entries(C).filter(([, v]) => !v).map(([k]) => k);
  run.green = run.red.length === 0;
  // PowerOf3 — three legs, each bound + hashed (sha256 of the bytes read, 16 hex, recomputed here) + a model.
  const legs = [
    { leg: "pane", bound: "GET /v1/sotr + GET /v1/configure through service binding CONTROL_PANE", model: UPSTREAM.CONTROL_PANE,
      hash: plan._bytes ? (await sha256hex(plan._bytes)).slice(0, 16) : null, verdict: plan.knob_names && plan.instances ? "VERIFIED" : "NO_SIGNAL" },
    { leg: "sandbox", bound: `GET /v1/wosp/loop?profile=${profile} through service binding DEV_IDE`, model: UPSTREAM.DEV_IDE,
      hash: eng._bytes ? (await sha256hex(eng._bytes)).slice(0, 16) : null, verdict: eng.product ? "VERIFIED" : "NO_SIGNAL" },
    { leg: "edge", bound: "sha256 over the byte-faithful instance source, recomputed in this Worker", model: "wosp-console",
      hash: expected ? expected.slice(0, 16) : null, verdict: expected ? (C.Expected ? "VERIFIED" : "REFUTED") : "NO_SIGNAL" },
    { leg: "metal", bound: `GET state /state/${DWEC_METAL_WORKSPACE}[${profile}] — the WaynePC bridge drain's attestation (pinned loop on its own substrate + nine agents' evidence), fresh < ${METAL_FRESH_S}s`,
      model: comp.metal && comp.metal.seat ? `platform-dwec-bridge@${comp.metal.seat}` : "platform-dwec-bridge",
      hash: metalBytes ? (await sha256hex(metalBytes)).slice(0, 16) : null,
      verdict: !comp.metal || comp.metal.membrane ? "NO_SIGNAL" : !comp.metal.fresh ? "NO_SIGNAL" : (comp.metal.digest && run.reported_digest && comp.metal.digest === run.reported_digest) ? "VERIFIED" : comp.metal.digest ? "REFUTED" : "NO_SIGNAL" },
  ];
  if (legs[3].verdict === "NO_SIGNAL" && comp.metal && !comp.metal.membrane && !comp.metal.fresh) legs[3].why = `attestation is ${comp.metal.age_s}s old; stale beyond ${METAL_FRESH_S}s`;
  delete plan._bytes; delete eng._bytes;
  const models = new Set(legs.filter((l) => l.verdict === "VERIFIED").map((l) => l.model));
  // a NO_SIGNAL leg may cite no bytes when its bound explains the zero (powerof3.py); a VERIFIED or REFUTED leg must be hashed
  const allHashed = legs.every((l) => l.verdict === "NO_SIGNAL" ? !!l.bound : !!l.hash);
  const agree = legs.every((l) => l.verdict !== "REFUTED");
  run.powerof3 = {
    legs, models: [...models], all_hashed: allHashed,
    admitted: allHashed && models.size >= 2 && agree,
    reason: !allHashed ? "a leg carries no hash: a claim without bytes is unfalsifiable" : !agree ? `a leg dissents: ${legs.filter((l) => l.verdict === "REFUTED").map((l) => l.leg + "=" + l.verdict).join(", ")}` : models.size < 2 ? "fewer than two distinct models agree" : models.size >= 4 ? "four substrates (pane, sandbox, edge, metal) read the same instance and its hash matches" : `${models.size} organs agree and the hash matches${legs[3].verdict === "NO_SIGNAL" ? "; metal leg NO_SIGNAL (" + (legs[3].why || "no fresh attestation") + ")" : ""}`,
    note: "no LLM is consulted; the loop is deterministic, so the models are organs, not chat models",
  };
  run.ms = Date.now() - t0;
  return run;
}

/* ── the card ───────────────────────────────────────────────────────────────────────── */

async function probeUpstream(env, binding) {
  const service = UPSTREAM[binding];
  const f = env[binding];
  if (!f) return { service, membrane: "NO_SIGNAL", reason: `binding ${binding} absent` };
  try {
    const r = await f.fetch("https://internal/health");
    const t = await r.text();
    let j = null;
    try { j = JSON.parse(t); } catch (_) { /* not json */ }
    if (!j) return { service, http: r.status, body: t.slice(0, 120) };
    return { service, http: r.status, reports: j.service, apex: j.apex, kernel_accept: j.kernel_accept, ...(j.wosp ? { wosp: j.wosp } : {}), ...(j.healthy !== undefined ? { healthy: j.healthy } : {}) };
  } catch (e) {
    return { service, membrane: "NO_SIGNAL", reason: String((e && e.message) || e) };
  }
}

export async function card(env, url) {
  const [pane, ide, state] = await Promise.all([probeUpstream(env, "CONTROL_PANE"), probeUpstream(env, "DEV_IDE"), probeUpstream(env, "STATE")]);
  return {
    service: "wosp-console",
    organ: "wosp-face",
    represents: "WOSP · WayneOSPlatform · the operator's Face · DwEC at the edge",
    deployed: true,
    surface: url.host.endsWith(".workers.dev") ? "workers.dev" : url.host,
    apex: false,
    doors: Object.keys(DOORS),
    composed: Object.keys(COMPOSED),
    upstream: { pane, ide, state },
    proposes_only: true,
    kernel_accept: false,
    fabricated: false,
  };
}

/* ── fetch ──────────────────────────────────────────────────────────────────────────── */

// ───── the apex plane ─────
export async function loadApex(kv) {
  const st = (await kv.get(APEX_KEY, "json")) || {};
  return { chronometer: apex.chronometer(st.chronometer), dial: apex.dial(Number((st.dial && st.dial.position) || 0)), switchboard: apex.switchboard(st.switchboard), updated_at: st.updated_at || null, by: st.by || null };
}
export async function saveApex(env, kv, st, by) {
  const rec = { chronometer: st.chronometer, dial: { position: st.dial.position }, switchboard: st.switchboard, updated_at: new Date().toISOString(), by };
  await kv.put(APEX_KEY, JSON.stringify(rec));
  let mirrored = false;
  if (env.STATE) { try { const r = await env.STATE.fetch(`https://internal/state/${APEX_WORKSPACE}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(rec) }); mirrored = r.status === 200; } catch (_) { mirrored = false; } }
  return { ...rec, mirrored };
}
export async function readLamps(env) {
  if (!env.STATE) return {};
  try { const j = await readJson(await env.STATE.fetch(`https://internal/state/${LAMPS_WORKSPACE}`)); return (j && j.state) || {}; } catch (_) { return {}; }
}
export function apexView(st, lamps, nowMin) {
  const sb = { circuits: st.switchboard.circuits.map((c) => (lamps[c.id] && c.toggle === "ON") ? { ...c, lamp: "TRIPPED", tripped: lamps[c.id] } : c) };
  const out = apex.pinsOut(st.chronometer);
  const strobing = st.chronometer.gears && out.some((p) => ((nowMin - p.tick + apex.RING_MINUTES) % apex.RING_MINUTES) < p.epoch);
  const ns = apex.nextStrobe(st.chronometer, nowMin);
  return { chronometer: { gears: st.chronometer.gears, pins: st.chronometer.pins, pins_out: out.length, next: ns ? { tick: ns.pin.tick, wait_min: ns.wait, inscription: ns.pin.inscription, epoch: ns.pin.epoch } : null, strobing },
    dial: st.dial, switchboard: sb, mask: apex.mask(sb), tripped: apex.tripped(sb), armed: apex.armedState(st.chronometer, st.dial, sb, strobing), updated_at: st.updated_at, by: st.by, kernel_accept: false, fabricated: false };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method.toUpperCase();

    const kv = env[gate.KV_BINDING];
    if (path === "/health" && method === "GET") {
      const [c, g, sess0] = await Promise.all([card(env, url), gate.gateStatus(kv), gate.session(request, kv)]);
      const { fabricated: _f, ...rest } = c;   // fabricated:false stays the last key of the card
      return json({ ...rest, gate: g, session: !!sess0, fabricated: false });
    }

    // ── the gate ───────────────────────────────────────────────────────────────
    if (path === "/v1/auth/login" && method === "POST") {
      if (!kv) return noSignal(`binding ${gate.KV_BINDING} absent — the Face is sealed`, 503);
      const declared = Number(request.headers.get("content-length") || 0);
      if (declared > MAX_BODY) return noSignal(`body ${declared}B exceeds ${MAX_BODY}B`, 413);
      const t = await request.text();
      if (t.length > MAX_BODY) return noSignal(`body exceeds ${MAX_BODY}B`, 413);
      let b = null; try { b = t ? JSON.parse(t) : {}; } catch (_) { return noSignal("body is not JSON", 400); }
      const r = await gate.login(kv, b, request.headers.get("cf-connecting-ip") || "0");
      return json(r.body, r.status, r.cookie ? { "set-cookie": r.cookie } : {});
    }
    if (path === "/v1/auth/logout" && method === "POST") return json({ ok: true, signed_out: true, fabricated: false }, 200, { "set-cookie": gate.clearCookie() });
    if (!kv) return noSignal(`binding ${gate.KV_BINDING} absent — the Face is sealed until it is bound`, 503);
    const sess = await gate.session(request, kv);
    if (path === "/v1/auth/whoami" && method === "GET") return sess ? json({ user: sess.u, role: sess.role, iat: sess.iat, exp: sess.exp, kernel_accept: false, fabricated: false }) : noSignal("login required", 401, { login: "/login" });
    if (path === "/login" || path === "/login.html") {
      if (sess) return Response.redirect(url.origin + "/", 302);
      return env.ASSETS ? env.ASSETS.fetch(new Request(url.origin + "/login.html", { method: "GET", headers: request.headers })) : noSignal("no assets", 503);
    }
    if (!sess) {
      if (path.startsWith("/v1/")) return noSignal("login required", 401, { login: "/login" });
      return Response.redirect(url.origin + "/login", 302);
    }
    // ── past the gate ───────────────────────────────────────────────────────────
    if (path === "/v1/smbos" && method === "GET") {
      if (!env.RCQA) return noSignal("binding RCQA absent", 503, { organ: UPSTREAM.RCQA });
      const store = (url.searchParams.get("store") || "STOREA").toUpperCase().replace(/[^A-Z0-9]/g, "") || "STOREA";
      try {
        const [h, st] = await Promise.all([env.RCQA.fetch("https://internal/health"), env.RCQA.fetch(`https://internal/stats?days=90&store=${store}`)]);
        const hj = await readJson(h), sj = await readJson(st);
        if (h.status !== 200 || !hj) return noSignal(`rc-qa-gate health ${h.status}`, 503, { organ: UPSTREAM.RCQA });
        const o = (sj && sj.opportunity_summary) || {}; const pr = (sj && sj.progress) || {};
        return json({ organ: UPSTREAM.RCQA, store, subscription: hj.subscription || null, sms: hj.sms || null, ladder: { graded: pr.graded || 0, queued: (pr.queued || 0) + (pr.transcribed || 0), failed: pr.failed || 0, no_recording: pr.no_recording || 0, final: !(pr.queued || pr.transcribed || pr.failed) },
          headline: { calls_graded: o.calls_graded, qualified: o.qualified_leads, scheduled: o.scheduled_on_the_call, close_rate_pct: o.close_rate_pct, lost: o.lost_or_price_shopped, lost_why: o.lost_why || {}, revenue: o.estimated_revenue_captured || "NO_SIGNAL" },
          alerts_24h: hj.alerts_24h || [], rubric: (sj && sj.rubric) || null, generated_at: (sj && sj.generated_at) || null, kernel_accept: false, fabricated: false });
      } catch (e) { return noSignal(String((e && e.message) || e), 503, { organ: UPSTREAM.RCQA }); }
    }
    if (path === "/v1/smbos/feed" && method === "GET") {
      if (!env.RCQA) return noSignal("binding RCQA absent", 503, { organ: UPSTREAM.RCQA });
      const store = (url.searchParams.get("store") || "STOREA").toUpperCase().replace(/[^A-Z0-9]/g, "") || "STOREA";
      const hours = Math.min(168, Math.max(1, Number(url.searchParams.get("hours") || 24)));
      try {
        const r = await env.RCQA.fetch(`https://internal/feed?store=${store}&hours=${hours}&limit=40`);
        const j = await readJson(r);
        if (r.status !== 200 || !j) return noSignal(`rc-qa-gate feed ${r.status}`, 503, { organ: UPSTREAM.RCQA });
        return json({ organ: UPSTREAM.RCQA, ...j, kernel_accept: false, fabricated: false });
      } catch (e) { return noSignal(String((e && e.message) || e), 503, { organ: UPSTREAM.RCQA }); }
    }
    if (path === "/v1/apex" && method === "GET") {
      const [st, lamps] = await Promise.all([loadApex(kv), readLamps(env)]);
      const cards = await surfaceLamps(env, st);           // armed surface circuits only; OFF costs nothing
      const d = new Date(); return json(apexView(st, { ...cards, ...lamps }, d.getUTCHours() * 60 + d.getUTCMinutes()));   // a worker's trip outranks a card
    }
    if (path.startsWith("/v1/apex/") && method === "PUT") {
      if (sess.role !== "root") return noSignal("the instruments take a root session", 403);
      const declared = Number(request.headers.get("content-length") || 0);
      if (declared > MAX_BODY) return noSignal(`body ${declared}B exceeds ${MAX_BODY}B`, 413);
      let b; try { b = JSON.parse((await request.text()) || "{}"); } catch (_) { return noSignal("body is not JSON", 400); }
      const st = await loadApex(kv);
      try {
        if (path === "/v1/apex/dial") st.dial = apex.dial(b.position);
        else if (path === "/v1/apex/chronometer") { if (typeof b.gears === "boolean") st.chronometer = { ...st.chronometer, gears: b.gears }; else st.chronometer = apex.setPin(st.chronometer, Number(b.tick), !!b.out, b.inscription, b.epoch === undefined ? apex.DEFAULT_EPOCH : Number(b.epoch)); }
        else if (path === "/v1/apex/switchboard") {
          if (b.reset) { st.switchboard = apex.reset(st.switchboard, String(b.id)); if (env.STATE) { try { await env.STATE.fetch(`https://internal/state/${LAMPS_WORKSPACE}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ [String(b.id)]: null }) }); } catch (_) {} } }
          else st.switchboard = apex.setToggle(st.switchboard, String(b.id), String(b.toggle).toUpperCase() === "ON");
        } else return noSignal(`no instrument at ${path}`, 404);
      } catch (e) { return noSignal(String((e && e.message) || e), 400); }
      const saved = await saveApex(env, kv, st, sess.u);
      const [lamps, cards] = await Promise.all([readLamps(env), surfaceLamps(env, st)]); const d = new Date();   // arming a surface reads its card at once
      return json({ ...apexView({ ...st, updated_at: saved.updated_at, by: saved.by }, { ...cards, ...lamps }, d.getUTCHours() * 60 + d.getUTCMinutes()), mirrored: saved.mirrored });
    }


    // composed routes — before the proxy doors
    if (path === "/v1/dwec" && method === "GET") return json(dwecContract());
    if (path === "/v1/dwec/runs" && method === "GET") {
      if (!env.STATE) return noSignal("binding STATE absent", 503, { organ: UPSTREAM.STATE });
      try {
        const [g, l, m] = await Promise.all([env.STATE.fetch(`https://internal/state/${DWEC_WORKSPACE}`), env.STATE.fetch(`https://internal/log/${DWEC_WORKSPACE}`), env.STATE.fetch(`https://internal/state/${DWEC_METAL_WORKSPACE}`)]);
        const gj = await readJson(g), lj = await readJson(l), mj = await readJson(m);
        return json({ workspace: DWEC_WORKSPACE, last_run: gj && gj.state ? gj.state.last_run || null : null, runs: gj && gj.state && Array.isArray(gj.state.runs) ? gj.state.runs : [], ledger: lj && Array.isArray(lj.log) ? lj.log.slice(-10) : [], metal: mj && mj.state ? mj.state : {}, fabricated: false });
      } catch (e) { return noSignal(String((e && e.message) || e), 503, { organ: UPSTREAM.STATE }); }
    }
    if (path === "/v1/desk" && method === "GET") {
      if (!env.STATE) return noSignal("binding STATE absent", 503, { organ: UPSTREAM.STATE });
      try {
        const g = await env.STATE.fetch(`https://internal/state/${DESK_WORKSPACE}`);
        const gj = await readJson(g);
        const att = gj && gj.state ? gj.state.wayneiq : null;
        if (!att || typeof att !== "object") return noSignal("no desk attestation on desk:wayneiq — wayneiq-desk-attest.timer has not run, or is down", 404, { workspace: DESK_WORKSPACE });
        const ageS = att.attested_at ? Math.round((Date.now() - Date.parse(att.attested_at)) / 1000) : null;
        return json({ workspace: DESK_WORKSPACE, seat: att.seat, attested_at: att.attested_at, age_s: ageS, fresh: ageS !== null && ageS < DESK_FRESH_S,
          desk: att.desk, watch: att.watch, local: att.local, membrane: ageS !== null && ageS < DESK_FRESH_S ? "VERIFIED" : "NO_SIGNAL", reason: ageS !== null && ageS < DESK_FRESH_S ? null : `attestation is ${ageS}s old; two beats missed`, fabricated: false });
      } catch (e) { return noSignal(String((e && e.message) || e), 503, { organ: UPSTREAM.STATE }); }
    }

    if (path === "/v1/dwec/run" && method === "POST") {
      const declared = Number(request.headers.get("content-length") || 0);
      if (declared > MAX_BODY) return noSignal(`body ${declared}B exceeds ${MAX_BODY}B`, 413);
      const t = await request.text();
      if (t.length > MAX_BODY) return noSignal(`body exceeds ${MAX_BODY}B`, 413);
      let b = null; try { b = t ? JSON.parse(t) : {}; } catch (_) { return noSignal("body is not JSON", 400); }
      const profile = String((b && b.profile) || url.searchParams.get("profile") || "tanoak").toLowerCase();
      if (!WOSP_PROFILES.has(profile)) return noSignal(`profile not in allowlist ${[...WOSP_PROFILES].join("|")}`, 400);
      return json(await runDwec(env, profile));
    }

    if (path.startsWith("/v1/")) {
      const hit = route(method, path);
      if (!hit) return noSignal(`no door ${method} ${path}`, 404, { doors: Object.keys(DOORS), composed: Object.keys(COMPOSED) });
      const f = env[hit.binding];
      if (!f) return noSignal(`binding ${hit.binding} absent`, 503, { organ: hit.service });

      // The profile allowlist is enforced at the door as well as upstream.
      if (hit.upstream === "/v1/wosp/loop") {
        const p = (url.searchParams.get("profile") || "tanoak").toLowerCase();
        if (!WOSP_PROFILES.has(p)) {
          return noSignal(`profile not in allowlist ${[...WOSP_PROFILES].join("|")}`, 400);
        }
      }

      const init = { method, headers: {} };
      if (method === "POST") {
        const declared = Number(request.headers.get("content-length") || 0);
        if (declared > MAX_BODY) return noSignal(`body ${declared}B exceeds ${MAX_BODY}B`, 413);
        const body = await request.text();
        if (body.length > MAX_BODY) return noSignal(`body exceeds ${MAX_BODY}B`, 413);
        init.body = body;
        init.headers["content-type"] = request.headers.get("content-type") || "application/json";
      }

      try {
        const r = await f.fetch("https://internal" + hit.upstream + url.search, init);
        return new Response(r.body, {
          status: r.status,
          headers: {
            "content-type": r.headers.get("content-type") || "application/json; charset=utf-8",
            ...BASE_HEADERS,
            "x-wosp-upstream": hit.service,
          },
        });
      } catch (e) {
        return noSignal(String((e && e.message) || e), 503, { organ: hit.service });
      }
    }

    if (env.ASSETS) return env.ASSETS.fetch(request);
    return noSignal(`no route ${method} ${path}`);
  },
};
