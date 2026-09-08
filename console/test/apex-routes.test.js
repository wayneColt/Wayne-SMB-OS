// The apex routes must prove: a stranger cannot read them, a non-root session cannot write them,
// out-of-range values are refused, every write mirrors to STATE apex:wosp (what the gate and
// metal read), lamps tripped by workers show as TRIPPED and a reset clears them. fabricated:false
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { COMPOSED, APEX_WORKSPACE, LAMPS_WORKSPACE, loadApex, apexView, surfaceLamps, SURFACE_CARDS } from "../src/index.js";
import { signSession, SESSION_TTL_S, SESSION_COOKIE } from "../src/gate.js";
import { minted, COOKIE, SESSION_KEY } from "./_auth.js";
import { OPERATOR } from "../src/gate.js";

const ok = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
function env(over = {}) {
  const state = { [APEX_WORKSPACE]: {}, [LAMPS_WORKSPACE]: over.lamps || {} }; const puts = [];
  return { puts, state, env: {
    CONTROL_PANE: { async fetch() { return ok({ apex: false }); } }, DEV_IDE: { async fetch() { return ok({}); } }, ASSETS: { async fetch() { return new Response("asset"); } },
    STATE: { async fetch(url, init = {}) { const ws = String(url).split("/state/")[1]; if (init.method === "PUT") { const b = JSON.parse(init.body); puts.push({ ws, b }); for (const [k, v] of Object.entries(b)) { if (v === null) delete state[ws][k]; else state[ws][k] = v; } return ok({ ok: true, digest: "d", keys: Object.keys(state[ws]) }); } return ok({ state: state[ws] || {}, empty: !state[ws] }); } },
    WOSP_AUTH: minted(), ...over.env } };
}
const req = (path, init = {}, cookie = COOKIE) => new Request("https://wosp-console.test" + path, { ...init, headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}) } });
const put = (path, body, cookie = COOKIE) => req(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }, cookie);

test("GET /v1/apex: shut to a stranger; a root session sees the cold default (dial 0 MONITOR, every toggle OFF, no pins)", async () => {
  const { env: e } = env();
  assert.equal((await worker.fetch(req("/v1/apex", {}, null), e)).status, 401);
  const v = await (await worker.fetch(req("/v1/apex"), e)).json();
  assert.equal(v.dial.position, 0); assert.equal(v.dial.detent, "MONITOR"); assert.equal(v.dial.write, false); assert.equal(v.chronometer.pins.length, 96); assert.equal(v.chronometer.pins_out, 0); assert.equal(v.chronometer.gears, true);
  assert.deepEqual(v.mask, []); assert.equal(v.switchboard.circuits.length, 16); assert.equal(v.kernel_accept, false); assert.equal(v.armed, "CUSTOM");
  for (const k of ["GET /v1/apex", "PUT /v1/apex/dial", "PUT /v1/apex/chronometer", "PUT /v1/apex/switchboard"]) assert.equal(typeof COMPOSED[k], "string", k);
});

test("dial: set 65 → ASSISTED with the derived readouts, mirrored to STATE apex:wosp; 101 refused; a non-root session is 403", async () => {
  const { env: e, puts, state } = env();
  const r = await worker.fetch(put("/v1/apex/dial", { position: 65 }), e); assert.equal(r.status, 200); const v = await r.json();
  assert.equal(v.dial.detent, "ASSISTED"); assert.ok(Math.abs(v.dial.confidence - 0.7365) < 1e-3); assert.equal(v.dial.write, true); assert.equal(v.dial.prod_write, true); assert.equal(v.by, OPERATOR); assert.equal(v.mirrored, true);
  assert.equal(puts[0].ws, APEX_WORKSPACE); assert.equal(state[APEX_WORKSPACE].dial.position, 65); assert.equal(state[APEX_WORKSPACE].switchboard.circuits.length, 16);
  assert.equal((await worker.fetch(put("/v1/apex/dial", { position: 101 }), e)).status, 400);
  assert.equal((await (await worker.fetch(req("/v1/apex"), e)).json()).dial.position, 65, "the refused write did not move the dial");
  const iat = Math.floor(Date.now() / 1000); const viewer = `${SESSION_COOKIE}=${await signSession(SESSION_KEY, { u: "viewer@wayne", role: "viewer", iat, exp: iat + SESSION_TTL_S })}`;
  assert.equal((await worker.fetch(put("/v1/apex/dial", { position: 10 }, viewer), e)).status, 403);
  assert.equal((await worker.fetch(put("/v1/apex/dial", { position: 10 }, null), e)).status, 401);
});

test("chronometer: a pin pulled with an inscription strobes next; off-grid and blank inscriptions refused; gears off stops strobes", async () => {
  const { env: e } = env();
  const v = await (await worker.fetch(put("/v1/apex/chronometer", { tick: 120, out: true, inscription: "audit comm signals & repo", epoch: 60 }), e)).json();
  assert.equal(v.chronometer.pins_out, 1); assert.equal(v.chronometer.next.tick, 120); assert.equal(v.chronometer.next.inscription, "audit comm signals & repo"); assert.equal(v.armed, "ARMED SLEEP");
  assert.equal((await worker.fetch(put("/v1/apex/chronometer", { tick: 7, out: true, inscription: "x" }), e)).status, 400);
  assert.equal((await worker.fetch(put("/v1/apex/chronometer", { tick: 240, out: true, inscription: "  " }), e)).status, 400);
  const g = await (await worker.fetch(put("/v1/apex/chronometer", { gears: false }), e)).json(); assert.equal(g.chronometer.gears, false); assert.equal(g.chronometer.next, null); assert.equal(g.chronometer.pins_out, 1, "pins stay on the rim when the gears disengage");
});

test("switchboard: toggles arm circuits; a worker-tripped lamp shows TRIPPED while the circuit stays live; reset clears it in STATE; unknown circuit refused", async () => {
  const { env: e, state } = env({ lamps: { gmail: { tripped_at: "2026-09-05T20:00:00Z", by: "comm-signal", reason: "rate limit" } } });
  let v = await (await worker.fetch(put("/v1/apex/switchboard", { id: "gmail", toggle: "ON" }), e)).json();
  const gm = v.switchboard.circuits.find((c) => c.id === "gmail"); assert.equal(gm.toggle, "ON"); assert.equal(gm.lamp, "TRIPPED"); assert.equal(gm.tripped.by, "comm-signal"); assert.deepEqual(v.mask, ["gmail"]); assert.deepEqual(v.tripped, ["gmail"]);
  v = await (await worker.fetch(put("/v1/apex/switchboard", { id: "gmail", reset: true }), e)).json();
  assert.equal(v.switchboard.circuits.find((c) => c.id === "gmail").lamp, "OK"); assert.equal(LAMPS_WORKSPACE in state && "gmail" in state[LAMPS_WORKSPACE], false, "the reset removed the lamp record");
  assert.equal((await worker.fetch(put("/v1/apex/switchboard", { id: "nope", toggle: "ON" }), e)).status, 400);
  v = await (await worker.fetch(put("/v1/apex/switchboard", { id: "prod", toggle: "ON" }), e)).json(); assert.equal(v.switchboard.circuits.find((c) => c.id === "prod").guarded, true);
});

test("the view reads armed states off the instruments: dial 65 + pins + gmail/github ON, off-epoch = ARMED SLEEP", async () => {
  const st = await loadApex({ async get() { return { dial: { position: 65 }, chronometer: null, switchboard: { circuits: [{ id: "github", toggle: "ON" }, { id: "cdn", toggle: "ON" }] } }; } });
  const { setPin } = await import("../src/apex.js");
  st.chronometer = setPin(st.chronometer, 120, true, "sweep", 240);
  assert.equal(apexView(st, {}, 60).armed, "ARMED SLEEP");
  assert.equal(apexView(st, {}, 130).armed, "GUARDED EPOCH", "inside the epoch of a pulled pin it is strobing");
});

test("surface lamps: an armed surface reads its card through a binding; a dead card trips; OFF circuits are never probed; canvas cannot prove itself; a worker's trip outranks a card", async () => {
  let ideCalls = 0;
  const { env: e } = env({ env: { DEV_IDE: { async fetch() { ideCalls++; return ok({ deployed: true }); } } } });
  // cold board: nothing armed → no card is read
  let v = await (await worker.fetch(req("/v1/apex"), e)).json();
  assert.equal(ideCalls, 0, "OFF circuits cost nothing"); assert.deepEqual(v.tripped, []);
  // arm container → its card is read and reads deployed → lamp OK
  v = await (await worker.fetch(put("/v1/apex/switchboard", { id: "container", toggle: "ON" }), e)).json();
  assert.equal(v.switchboard.circuits.find((c) => c.id === "container").lamp, "OK"); assert.equal(ideCalls, 1);
  // the card goes dark → the lamp trips by health-card and names the organ; the toggle does not move
  e.DEV_IDE = { async fetch() { ideCalls++; return ok({ deployed: false }); } };
  v = await (await worker.fetch(req("/v1/apex"), e)).json();
  const c = v.switchboard.circuits.find((x) => x.id === "container");
  assert.equal(c.toggle, "ON"); assert.equal(c.lamp, "TRIPPED"); assert.equal(c.tripped.by, "health-card"); assert.match(c.tripped.why, /wayne-cdn-container-sandbox\/health/);
  assert.deepEqual(v.tripped, ["container"]); assert.deepEqual(v.mask, ["container"], "a tripped lamp does not close the circuit");
  // an unreachable card is a trip, not a crash
  e.DEV_IDE = { async fetch() { throw new TypeError("fetch failed"); } };
  v = await (await worker.fetch(req("/v1/apex"), e)).json();
  assert.match(v.switchboard.circuits.find((x) => x.id === "container").tripped.why, /unreachable/);
  // canvas has no organ: arming it trips immediately with the reason
  v = await (await worker.fetch(put("/v1/apex/switchboard", { id: "canvas", toggle: "ON" }), e)).json();
  assert.match(v.switchboard.circuits.find((x) => x.id === "canvas").tripped.why, /no organ/);
  // a worker's trip outranks the card
  const st = await loadApex(e.WOSP_AUTH);
  const cards = await surfaceLamps({ DEV_IDE: { async fetch() { return ok({ deployed: true }); } } }, st, () => "T");
  assert.equal(cards.container, undefined, "a live card leaves the lamp alone");
  const view = apexView(st, { ...cards, container: { by: "comm-signal", at: "T" } }, 0);
  assert.equal(view.switchboard.circuits.find((x) => x.id === "container").tripped.by, "comm-signal");
  assert.equal(Object.keys(SURFACE_CARDS).length, 6);
});
