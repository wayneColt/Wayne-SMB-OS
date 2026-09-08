// DwEC at the edge — tests. Stdlib only (node:test). The point of these is that the CLOSER
// computed by the Worker can go RED: a wrong digest, a missing knob, a dead IDE, and a missing
// ledger each turn one letter red, and the run says which. A CLOSER that cannot fail is not a
// test.
// fabricated:false
import { test } from "node:test";
import assert from "node:assert/strict";
import { minted, COOKIE } from "./_auth.js";
import worker, { COMPOSED, DWEC_WORKSPACE, DWEC_METAL_WORKSPACE, DESK_WORKSPACE, instanceSrc, pyRepr, pyStr, runDwec, sha256hex } from "../src/index.js";

const ok = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });

const KNOBS = { tanoak: { location_code: "store-001", audience: "the client", period: "current" },
                kssp: { agency_id: "ks-staffing", segment: "default", instance_label: "WOSP" },
                verdict: { pane_pricing: true, pane_compliance: true, pane_dispatch: true } };

async function fakeEnv(over = {}) {
  const calls = [];
  const store = { state: {}, log: [], metal: over.metal || {} };
  const digestFor = async (p) => sha256hex(instanceSrc(p, KNOBS[p]));
  const env = {
    CONTROL_PANE: { async fetch(url, init = {}) {
      const u = String(url); calls.push({ b: "CONTROL_PANE", u, m: init.method || "GET" });
      if (u.endsWith("/health")) return ok({ service: "wayne-aios-control-pane", apex: false, kernel_accept: false });
      if (u.endsWith("/v1/sotr")) return ok({ instances: [{ id: "kssp" }, { id: "tanoak" }, { id: "verdict" }], kernel_accept: false });
      if (u.endsWith("/v1/configure") && (init.method || "GET") === "GET") return ok({ catalog: [{ profile: "kssp", knobs: ["agency_id", "segment", "instance_label"] }, { profile: "tanoak", knobs: ["location_code", "audience", "period"] }, { profile: "verdict", knobs: ["pane_pricing", "pane_compliance", "pane_dispatch"] }] });
      if (u.endsWith("/v1/configure")) return ok({ A: "LAG", reason: "Configure is propose.", fabricated: false });
      return ok({ membrane: "NO_SIGNAL" }, 404);
    } },
    DEV_IDE: { async fetch(url) {
      const u = new URL(String(url)); calls.push({ b: "DEV_IDE", u: u.toString() });
      const p = u.searchParams.get("profile");
      return ok({ kind: "wosp_wasp_loop", exitCode: 0, success: true, loop: { finished: true, product: { profile: p, knobs: KNOBS[p], digest: await digestFor(p), kernel_accept: false }, CLOSER: { Complete: true, Linked: true, Observed: true, Specified: true, Expected: true, Recorded: true } } });
    } },
    STATE: { async fetch(url, init = {}) {
      const u = String(url); calls.push({ b: "STATE", u, m: init.method || "GET" });
      if (u.endsWith(`/state/${DWEC_WORKSPACE}`) && (init.method || "GET") === "GET") return ok({ state: store.state, digest: "d0", empty: !Object.keys(store.state).length });
      if (u.endsWith(`/state/${DWEC_WORKSPACE}`) && init.method === "PUT") { Object.assign(store.state, JSON.parse(init.body)); store.log.push({ at: new Date().toISOString(), keys: Object.keys(store.state), digest: "d1" }); return ok({ ok: true, digest: "d1", keys: Object.keys(store.state) }); }
      if (u.endsWith(`/log/${DWEC_WORKSPACE}`)) return ok({ log: store.log });
      if (u.endsWith(`/state/${DWEC_METAL_WORKSPACE}`)) return ok({ state: store.metal, digest: "m0", empty: !Object.keys(store.metal).length });
      if (u.endsWith(`/state/${DESK_WORKSPACE}`)) return ok({ state: over.desk || {}, digest: "k0", empty: !over.desk });
      return ok({ membrane: "NO_SIGNAL" }, 404);
    } },
    ASSETS: { async fetch() { return new Response("asset"); } },
    WOSP_AUTH: minted(),
    ...over,
  };
  return { env, calls, store, digestFor };
}

const req = (path, init = {}) => new Request("https://wosp-console.test" + path, { ...init, headers: { ...(init.headers || {}), cookie: COOKIE } });

test("python repr is byte-faithful for the knob shapes the loop uses", () => {
  assert.equal(pyStr("tanoak"), "'tanoak'");
  assert.equal(pyRepr(KNOBS.tanoak), "{'location_code': 'store-001', 'audience': 'the client', 'period': 'current'}");
  assert.equal(pyRepr(KNOBS.verdict), "{'pane_pricing': True, 'pane_compliance': True, 'pane_dispatch': True}");
  assert.equal(pyStr("it's"), '"it\'s"');
  assert.equal(instanceSrc("kssp", KNOBS.kssp), "PROFILE = 'kssp'\nKNOBS = {'agency_id': 'ks-staffing', 'segment': 'default', 'instance_label': 'WOSP'}\ndef instance():\n    return {'profile': PROFILE, 'knobs': KNOBS, 'organ': 'WOSP'}\n");
});

test("the recomputed digest matches the recorded fixture digest", async () => {
  // RECEIPT_FIRST_STING.json and the live container both report this for the default knobs.
  assert.equal(await sha256hex(instanceSrc("tanoak", KNOBS.tanoak)), "6b10c2cd66318bbac6d956d46056841d6e56828a0e2585f397569ae2bbe8e434");
});

test("a whole run closes green, records to the ledger, and disposes A=LAG", async () => {
  const { env, calls, store } = await fakeEnv();
  const run = await runDwec(env, "tanoak");
  assert.equal(run.green, true, JSON.stringify(run.red));
  assert.deepEqual(run.red, []);
  assert.equal(run.A, "LAG");
  assert.equal(run.kernel_accept, false);
  assert.equal(run.expected_digest, run.reported_digest);
  assert.equal(run.stages.record.ok, true);
  assert.equal(store.state.last_run.profile, "tanoak");
  assert.equal(store.state.runs.length, 1);
  assert.ok(calls.some((c) => c.b === "STATE" && c.m === "PUT"), "the ledger was written");
  assert.equal(run.powerof3.admitted, true, run.powerof3.reason);
  assert.equal(run.powerof3.legs.length, 4);
  assert.ok(run.powerof3.legs.filter((l) => l.verdict !== "NO_SIGNAL").every((l) => /^[0-9a-f]{16}$/.test(l.hash)), "every VERIFIED leg carries a 16-hex hash");
  assert.equal(run.powerof3.legs[3].verdict, "NO_SIGNAL", "no attestation in this fixture → metal NO_SIGNAL with its bound");
  assert.equal(run.powerof3.legs[2].hash, run.expected_digest.slice(0, 16));
  assert.equal(run.fabricated, false);
});

test("CONTROL — Expected goes red when the container reports a digest that is not sha256 of its own source", async () => {
  const { env } = await fakeEnv({ DEV_IDE: { async fetch(url) { const p = new URL(String(url)).searchParams.get("profile"); return ok({ exitCode: 0, loop: { finished: true, product: { profile: p, knobs: KNOBS[p], digest: "abd2b553bc12add4c61ba3e54b0248700591391c425714d5e0e4a0c47aa06f53" }, CLOSER: {} } }); } } });
  const run = await runDwec(env, "tanoak");
  assert.equal(run.CLOSER.Expected, false);
  assert.deepEqual(run.red, ["Expected"]);
  assert.equal(run.green, false);
  assert.equal(run.powerof3.admitted, false, "the edge leg dissents, so PowerOf3 refuses");
  assert.match(run.powerof3.reason, /edge=REFUTED/);
  assert.equal(run.stages.record.ok, true, "a red run is still recorded — a fix that hides drift makes the defect permanent");
});

test("CONTROL — Linked goes red when the compiled knobs do not match the pane's catalog", async () => {
  const base = await fakeEnv();
  const pane = base.env.CONTROL_PANE;
  const env = { ...base.env, CONTROL_PANE: { async fetch(url, init) {
    const u = String(url);
    if (u.endsWith("/v1/configure") && (!init || (init.method || "GET") === "GET")) return ok({ catalog: [{ profile: "tanoak", knobs: ["location_code", "audience"] }] });
    return pane.fetch(url, init);
  } } };
  const run = await runDwec(env, "tanoak");
  assert.equal(run.CLOSER.Linked, false);
  assert.ok(run.red.includes("Linked"));
});

test("CONTROL — Observed and Complete go red when the IDE is dead; the run still disposes and records", async () => {
  const { env } = await fakeEnv({ DEV_IDE: { async fetch() { throw new Error("container down"); } } });
  const run = await runDwec(env, "verdict");
  assert.equal(run.CLOSER.Observed, false);
  assert.equal(run.CLOSER.Complete, false);
  assert.equal(run.CLOSER.Expected, false);
  assert.equal(run.A, "LAG");
  assert.equal(run.stages.record.ok, true);
  assert.equal(run.green, false);
});

test("CONTROL — Recorded goes red when the ledger binding is absent, and only Recorded", async () => {
  const { env } = await fakeEnv({ STATE: undefined });
  const run = await runDwec(env, "kssp");
  assert.equal(run.CLOSER.Recorded, false);
  assert.deepEqual(run.red, ["Recorded"]);
});

test("CONTROL — Specified goes red when the SOTR does not list the profile", async () => {
  const base = await fakeEnv();
  const pane = base.env.CONTROL_PANE;
  const env = { ...base.env, CONTROL_PANE: { async fetch(url, init) { if (String(url).endsWith("/v1/sotr")) return ok({ instances: [{ id: "tanoak" }] }); return pane.fetch(url, init); } } };
  const run = await runDwec(env, "kssp");
  assert.equal(run.CLOSER.Specified, false);
});

test("routes: contract, run, runs; bad profile refused; composed routes are not proxy doors", async () => {
  const { env } = await fakeEnv();
  let r = await worker.fetch(req("/v1/dwec"), env); assert.equal(r.status, 200); const c = await r.json(); assert.equal(c.name, "DwEC"); assert.equal(c.proposes_only, true);
  r = await worker.fetch(req("/v1/dwec/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile: "verdict" }) }), env);
  assert.equal(r.status, 200); const run = await r.json(); assert.equal(run.profile, "verdict"); assert.equal(run.green, true);
  r = await worker.fetch(req("/v1/dwec/run", { method: "POST", body: JSON.stringify({ profile: "__nope__" }) }), env); assert.equal(r.status, 400);
  r = await worker.fetch(req("/v1/dwec/run", { method: "POST", body: "not json" }), env); assert.equal(r.status, 400);
  r = await worker.fetch(req("/v1/dwec/runs"), env); assert.equal(r.status, 200); const rs = await r.json(); assert.equal(rs.runs.length, 1); assert.equal(rs.last_run.profile, "verdict");
  r = await worker.fetch(req("/v1/dwec/run"), env); assert.equal(r.status, 404, "GET on run is not a door");
  assert.deepEqual(Object.keys(COMPOSED), ["GET /v1/dwec", "POST /v1/dwec/run", "GET /v1/dwec/runs", "GET /v1/desk", "POST /v1/auth/login", "POST /v1/auth/logout", "GET /v1/auth/whoami", "GET /v1/apex", "PUT /v1/apex/dial", "PUT /v1/apex/chronometer", "PUT /v1/apex/switchboard", "GET /v1/smbos", "GET /v1/smbos/feed"]);
  const h = await (await worker.fetch(req("/health"), env)).json();
  assert.deepEqual(h.composed, Object.keys(COMPOSED));
  assert.equal(h.upstream.state.service, "wayne-main-state");
});

test("metal leg — a fresh matching attestation on dwec:metal makes four substrates agree", async () => {
  const digest = await sha256hex(instanceSrc("tanoak", KNOBS.tanoak));
  const { env } = await fakeEnv({ metal: { tanoak: { profile: "tanoak", digest, seat: "WaynePC", attested_at: new Date().toISOString(), loop_sha256: "abcdef0123456789", bridge: { port: 8094, agents: 9, loaded: 9, tasks: Array.from({ length: 9 }, (_, i) => ({ agent_type: "A" + i, status: "COMPLETED" })) } } } });
  const run = await runDwec(env, "tanoak");
  const metal = run.powerof3.legs.find((l) => l.leg === "metal");
  assert.equal(metal.verdict, "VERIFIED");
  assert.match(metal.hash, /^[0-9a-f]{16}$/);
  assert.equal(run.powerof3.models.length, 4);
  assert.equal(run.powerof3.admitted, true);
  assert.match(run.powerof3.reason, /four substrates/);
  assert.equal(run.stages.compose.metal.bridge.completed, 9);
});

test("CONTROL — metal attestation with a different digest REFUTES and admission is withdrawn", async () => {
  const { env } = await fakeEnv({ metal: { tanoak: { profile: "tanoak", digest: "0000000000000000deadbeef", seat: "WaynePC", attested_at: new Date().toISOString() } } });
  const run = await runDwec(env, "tanoak");
  assert.equal(run.CLOSER.Expected, true, "the edge still matches the sandbox");
  assert.equal(run.powerof3.legs.find((l) => l.leg === "metal").verdict, "REFUTED");
  assert.equal(run.powerof3.admitted, false);
  assert.match(run.powerof3.reason, /metal=REFUTED/);
});

test("CONTROL — a stale attestation is NO_SIGNAL, not evidence; three substrates still admit and the reason says why", async () => {
  const digest = await sha256hex(instanceSrc("kssp", KNOBS.kssp));
  const { env } = await fakeEnv({ metal: { kssp: { profile: "kssp", digest, seat: "WaynePC", attested_at: new Date(Date.now() - 3 * 24 * 3600 * 1000).toISOString() } } });
  const run = await runDwec(env, "kssp");
  const metal = run.powerof3.legs.find((l) => l.leg === "metal");
  assert.equal(metal.verdict, "NO_SIGNAL");
  assert.match(metal.why, /stale/);
  assert.equal(run.powerof3.admitted, true);
  assert.match(run.powerof3.reason, /metal leg NO_SIGNAL/);
});

test("no attestation at all: metal is NO_SIGNAL with its bound, the run is still green and admitted on three", async () => {
  const { env } = await fakeEnv();
  const run = await runDwec(env, "verdict");
  assert.equal(run.stages.compose.metal.membrane, "NO_SIGNAL");
  assert.equal(run.green, true);
  assert.equal(run.powerof3.admitted, true);
  const r = await worker.fetch(req("/v1/dwec/runs"), env); const j = await r.json(); assert.deepEqual(j.metal, {});
});

test("desk: a fresh WayneIQ attestation is VERIFIED and carries the tray count and the WATCH headline", async () => {
  const { env } = await fakeEnv({ desk: { wayneiq: { seat: "WayneIQ", attested_at: new Date().toISOString(), desk: { open_n: 4, open: ["a", "b", "c", "d"], answered: 0, accept_default: 0 }, watch: { headline: "BLOCKED-ON-HUMAN", counts: { GREEN: 13, "BLOCKED-ON-HUMAN": 1 }, receipt_age_s: 60, stale: false }, local: { comm_tile: { http: 200 } }, fabricated: false } } });
  const r = await worker.fetch(req("/v1/desk"), env); assert.equal(r.status, 200); const j = await r.json();
  assert.equal(j.membrane, "VERIFIED"); assert.equal(j.desk.open_n, 4); assert.equal(j.watch.headline, "BLOCKED-ON-HUMAN"); assert.equal(j.fresh, true);
});

test("CONTROL — a desk attestation older than two beats is NO_SIGNAL with the age; none at all is 404 naming the timer", async () => {
  let { env } = await fakeEnv({ desk: { wayneiq: { seat: "WayneIQ", attested_at: new Date(Date.now() - 3600 * 1000).toISOString(), desk: { open_n: 4 }, watch: {}, fabricated: false } } });
  let j = await (await worker.fetch(req("/v1/desk"), env)).json();
  assert.equal(j.membrane, "NO_SIGNAL"); assert.match(j.reason, /two beats missed/); assert.equal(j.desk.open_n, 4, "the stale reading is still shown, labeled");
  ({ env } = await fakeEnv());
  const r = await worker.fetch(req("/v1/desk"), env); assert.equal(r.status, 404); j = await r.json(); assert.match(j.reason, /wayneiq-desk-attest/);
});
