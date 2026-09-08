// wosp-console door tests. Stdlib only (node:test) — no pip, no npm install, matching the
// container's enableInternet:false discipline. Run: node --test test/
//
// The guard must prove it can FAIL before its PASS means anything: the "can go red" cases
// below hand auditDoors a door table with the historical-shaped defect (a door onto an
// accept path) and assert the audit catches it.
//
// fabricated:false
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { DOORS, UPSTREAM, WOSP_PROFILES, MAX_BODY, auditDoors, route } from "../src/index.js";
import { minted, COOKIE } from "./_auth.js";

const ok = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } });

/** A fake env whose bindings record what they were asked. */
function fakeEnv(overrides = {}) {
  const calls = [];
  const bind = (name, reply) => ({
    async fetch(url, init = {}) {
      calls.push({ name, url: String(url), method: init.method || "GET", body: init.body, headers: init.headers || {} });
      return typeof reply === "function" ? reply(url, init) : reply;
    },
  });
  const env = {
    CONTROL_PANE: bind("CONTROL_PANE", (url) =>
      String(url).endsWith("/health")
        ? ok({ service: "wayne-aios-control-pane", apex: false, kernel_accept: false })
        : ok({ A: "LAG", reason: "Configure is propose.", fabricated: false })),
    DEV_IDE: bind("DEV_IDE", (url) =>
      String(url).endsWith("/health")
        ? ok({ service: "wayne-cdn-container-sandbox", apex: false, wosp: "/v1/wosp/loop" })
        : ok({ kind: "wosp_wasp_loop", loop: { finished: true } })),
    ASSETS: { async fetch() { return new Response("asset", { status: 200 }); } },
    WOSP_AUTH: minted(),
    ...overrides,
  };
  return { env, calls };
}

// every door request carries the operator's session; the gate itself is tested in gate.test.js
const req = (path, init = {}) => new Request("https://wosp-console.test" + path, { ...init, headers: { ...(init.headers || {}), cookie: COOKIE } });

test("the door table is sound (audit passes on the real table)", () => {
  assert.deepEqual(auditDoors(DOORS), []);
});

test("CONTROL — guard can go red: a door onto an accept path is caught", () => {
  const bad = { ...DOORS, "POST /v1/pane/propose": ["CONTROL_PANE", "/v1/propose"] };
  const v = auditDoors(bad);
  assert.equal(v.length >= 1, true, "audit must flag the propose door");
  assert.match(v.join("\n"), /propose/);
});

test("CONTROL — guard can go red: a pane door bound to the IDE is caught", () => {
  const bad = { ...DOORS, "GET /v1/pane/thirds": ["DEV_IDE", "/v1/thirds"] };
  assert.match(auditDoors(bad).join("\n"), /must bind CONTROL_PANE/);
});

test("CONTROL — guard can go red: a second POST door is caught", () => {
  const bad = { ...DOORS, "POST /v1/ide/wosp/loop": ["DEV_IDE", "/v1/wosp/loop"] };
  assert.match(auditDoors(bad).join("\n"), /only POST door/);
});

test("every door resolves, trailing slashes are ignored, methods are exact", () => {
  for (const key of Object.keys(DOORS)) {
    const [m, p] = key.split(" ");
    assert.ok(route(m, p), key);
    assert.ok(route(m, p + "/"), key + "/");
    assert.equal(route(m.toLowerCase(), p).key, key);
  }
  assert.equal(route("DELETE", "/v1/pane/health"), null);
  assert.equal(route("OPTIONS", "/v1/pane/configure"), null, "same-origin needs no preflight; none is opened");
  assert.equal(route("GET", "/v1/pane/propose"), null);
  assert.equal(route("POST", "/v1/pane/propose"), null);
  assert.equal(route("GET", "/v1/pane/ceo"), null);
  assert.equal(route("GET", "/v1/pane/citl"), null);
  assert.equal(route("GET", "/v1/ide/exec"), null);
  assert.equal(route("GET", "/v1/ide/track3/constant"), null);
});

test("profile allowlist is exactly the three shipped instances", () => {
  assert.deepEqual([...WOSP_PROFILES].sort(), ["kssp", "tanoak", "verdict"]);
});

test("GET /health is the card: service, doors, upstream receipts, kernel_accept:false, fabricated:false last", async () => {
  const { env } = fakeEnv();
  const r = await worker.fetch(req("/health"), env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-wosp-door"), "wosp-console");
  assert.equal(r.headers.get("cache-control"), "no-store");
  const j = await r.json();
  assert.equal(j.service, "wosp-console");
  assert.equal(j.apex, false);
  assert.equal(j.kernel_accept, false);
  assert.equal(j.proposes_only, true);
  assert.deepEqual(j.doors, Object.keys(DOORS));
  assert.equal(j.upstream.pane.reports, "wayne-aios-control-pane");
  assert.equal(j.upstream.ide.wosp, "/v1/wosp/loop");
  assert.equal(Object.keys(j).at(-1), "fabricated");
  assert.equal(j.fabricated, false);
});

test("a door forwards to the binding with a synthetic internal host and re-wraps the response", async () => {
  const { env, calls } = fakeEnv();
  const r = await worker.fetch(req("/v1/pane/configure", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile: "tanoak", knobs: { audience: "the client" } }),
  }), env);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-wosp-upstream"), UPSTREAM.CONTROL_PANE);
  assert.equal(r.headers.get("x-wosp-door"), "wosp-console");
  const j = await r.json();
  assert.equal(j.A, "LAG");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "CONTROL_PANE");
  assert.equal(calls[0].url, "https://internal/v1/configure");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["content-type"], "application/json");
  assert.match(calls[0].body, /"profile":"tanoak"/);
});

test("the loop door carries the query string and enforces the profile allowlist itself", async () => {
  const { env, calls } = fakeEnv();
  let r = await worker.fetch(req("/v1/ide/wosp/loop?profile=verdict"), env);
  assert.equal(r.status, 200);
  assert.equal(calls[0].url, "https://internal/v1/wosp/loop?profile=verdict");
  r = await worker.fetch(req("/v1/ide/wosp/loop?profile=__nope__"), env);
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.equal(j.membrane, "NO_SIGNAL");
  assert.equal(calls.length, 1, "a refused profile never reaches the IDE");
});

test("an unlisted /v1 path is NO_SIGNAL 404 and never touches a binding", async () => {
  const { env, calls } = fakeEnv();
  for (const [m, p] of [["POST", "/v1/pane/propose"], ["GET", "/v1/pane/ceo"], ["GET", "/v1/ide/exec"], ["OPTIONS", "/v1/pane/configure"]]) {
    const r = await worker.fetch(req(p, { method: m }), env);
    assert.equal(r.status, 404, `${m} ${p}`);
    const j = await r.json();
    assert.equal(j.membrane, "NO_SIGNAL");
    assert.equal(j.fabricated, false);
  }
  assert.equal(calls.length, 0);
});

test("a missing binding is NO_SIGNAL 503 naming the organ", async () => {
  const { env } = fakeEnv({ DEV_IDE: undefined });
  const r = await worker.fetch(req("/v1/ide/health"), env);
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.equal(j.organ, UPSTREAM.DEV_IDE);
});

test("a binding that throws is NO_SIGNAL 503, not a crash", async () => {
  const { env } = fakeEnv({ CONTROL_PANE: { async fetch() { throw new Error("upstream down"); } } });
  const r = await worker.fetch(req("/v1/pane/health"), env);
  assert.equal(r.status, 503);
  const j = await r.json();
  assert.match(j.reason, /upstream down/);
});

test("an oversized POST is refused before the binding is called", async () => {
  const { env, calls } = fakeEnv();
  const r = await worker.fetch(req("/v1/pane/configure", {
    method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(MAX_BODY + 1),
  }), env);
  assert.equal(r.status, 413);
  assert.equal(calls.length, 0);
});

test("paths outside /health and /v1 fall through to the asset layer", async () => {
  const { env } = fakeEnv();
  const r = await worker.fetch(req("/index.html"), env);
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "asset");
});
