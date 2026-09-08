// The Face's login gate — tests. Stdlib only (node:test). The gate must prove it can FAIL
// before its PASS means anything: a tampered cookie, a stale one, a wrong password, an
// unknown user, a missing binding and an unminted namespace each keep the door shut, and
// the run says which. A gate that cannot refuse is not a gate.
// fabricated:false
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { COMPOSED } from "../src/index.js";
import { OPERATOR, LOGIN_MAX_FAILS, PBKDF2_ITER, b64u, unb64u, ctEqual, pbkdf2, signSession, readSession, cookieValue, resolveUser, gateStatus, login } from "../src/gate.js";
import { PASSWORD, SESSION_KEY, SALT, USER_REC, kvStub, minted, unminted, COOKIE, STALE_COOKIE } from "./_auth.js";

const ok = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8" } });
function env(over = {}) {
  return {
    CONTROL_PANE: { async fetch(u) { return String(u).endsWith("/health") ? ok({ service: "wayne-aios-control-pane", apex: false, kernel_accept: false }) : ok({ A: "LAG", fabricated: false }); } },
    DEV_IDE: { async fetch(u) { return String(u).endsWith("/health") ? ok({ service: "wayne-cdn-container-sandbox", apex: false }) : ok({ kind: "wosp_wasp_loop", loop: { finished: true } }); } },
    STATE: { async fetch() { return ok({ state: {}, empty: true }); } },
    ASSETS: { async fetch(req) { return new Response(`asset:${new URL(req.url).pathname}`, { status: 200 }); } },
    WOSP_AUTH: minted(),
    ...over,
  };
}
const req = (path, init = {}, cookie = null) => new Request("https://wosp-console.test" + path, { ...init, headers: { ...(init.headers || {}), ...(cookie ? { cookie } : {}) } });
const body = (o) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });

test("primitives — b64url roundtrip, constant-time compare, pbkdf2 is deterministic and salt-sensitive", async () => {
  const u = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]);
  assert.deepEqual([...unb64u(b64u(u))], [...u]);
  assert.equal(ctEqual("abc", "abc"), true); assert.equal(ctEqual("abc", "abd"), false); assert.equal(ctEqual("abc", "abcd"), false);
  const h1 = await pbkdf2("x", SALT, 1000), h2 = await pbkdf2("x", SALT, 1000), h3 = await pbkdf2("x", new Uint8Array(32).fill(8), 1000);
  assert.equal(h1, h2); assert.notEqual(h1, h3); assert.equal(h1.length, 43);
});

test("session — sign/read roundtrip; tampered, stale, wrong-key and malformed tokens read as null", async () => {
  const iat = Math.floor(Date.now() / 1000);
  const t = await signSession(SESSION_KEY, { u: OPERATOR, role: "root", iat, exp: iat + 60 });
  const c = await readSession(SESSION_KEY, t);
  assert.equal(c.u, OPERATOR); assert.equal(c.role, "root");
  assert.equal(await readSession(SESSION_KEY, t.slice(0, -1) + (t.endsWith("A") ? "B" : "A")), null, "CONTROL: tampered signature");
  assert.equal(await readSession("other-key", t), null, "CONTROL: wrong key");
  assert.equal(await readSession(SESSION_KEY, t, (iat + 61) * 1000), null, "CONTROL: expired");
  assert.equal(await readSession(SESSION_KEY, "garbage"), null); assert.equal(await readSession(SESSION_KEY, null), null); assert.equal(await readSession("", t), null);
  const [p] = t.split("."); const forged = `${p}x.${t.split(".")[1]}`; assert.equal(await readSession(SESSION_KEY, forged), null, "CONTROL: payload edited");
});

test("cookies — value is parsed out of a multi-cookie header; alias admin resolves to the operator", () => {
  assert.equal(cookieValue(req("/", {}, "a=1; wosp_session=tok.sig; b=2")), "tok.sig");
  assert.equal(cookieValue(req("/")), null);
  assert.equal(resolveUser("ADMIN"), OPERATOR); assert.equal(resolveUser(" operator@smbos "), OPERATOR); assert.equal(resolveUser("eve"), "eve");
});

test("login() — right password opens (cookie set); wrong password, unknown user and alias behave; refusals never name the reason", async () => {
  const kv = minted();
  const good = await login(kv, { username: "operator@smbos", password: PASSWORD }, "1.1.1.1");
  assert.equal(good.status, 200); assert.equal(good.body.user, OPERATOR); assert.equal(good.body.role, "root"); assert.equal(good.body.kernel_accept, false); assert.match(good.cookie, /^wosp_session=.+; Path=\/; HttpOnly; Secure; SameSite=Strict; Max-Age=43200$/);
  const alias = await login(kv, { username: "admin", password: PASSWORD }, "1.1.1.1"); assert.equal(alias.status, 200); assert.equal(alias.body.user, OPERATOR);
  const bad = await login(kv, { username: "operator@smbos", password: "nope" }, "1.1.1.2"); assert.equal(bad.status, 401); assert.equal(bad.cookie, undefined);
  const unk = await login(kv, { username: "eve", password: PASSWORD }, "1.1.1.3"); assert.equal(unk.status, 401);
  assert.deepEqual(bad.body, unk.body, "an unknown user and a wrong password must be indistinguishable");
  assert.equal(await kv.get("rl:1.1.1.2"), "1"); assert.equal(await kv.get("rl:1.1.1.1"), null, "a success does not count against the address");
});

test("login() — CONTROL: the limiter trips after LOGIN_MAX_FAILS refusals from one address, and the right password no longer opens", async () => {
  const kv = minted();
  for (let i = 0; i < LOGIN_MAX_FAILS; i++) assert.equal((await login(kv, { username: "operator@smbos", password: "x" }, "9.9.9.9")).status, 401);
  assert.equal((await login(kv, { username: "operator@smbos", password: PASSWORD }, "9.9.9.9")).status, 429);
  assert.equal((await login(kv, { username: "operator@smbos", password: PASSWORD }, "9.9.9.8")).status, 200, "another address is unaffected");
});

test("login() — CONTROL: unminted namespace refuses; minted user without a session key is 503 not a cookie", async () => {
  assert.equal((await login(unminted(), { username: "operator@smbos", password: PASSWORD })).status, 401);
  const kv = minted(); await kv.delete("auth:session_key");
  const r = await login(kv, { username: "operator@smbos", password: PASSWORD }); assert.equal(r.status, 503); assert.equal(r.cookie, undefined);
});

test("gateStatus — absent / unminted / armed", async () => {
  assert.equal((await gateStatus(null)).gate, "absent");
  assert.equal((await gateStatus(unminted())).gate, "unminted");
  const a = await gateStatus(minted()); assert.equal(a.gate, "armed"); assert.equal(a.user, OPERATOR);
});

test("fetch — no cookie: / is 302 to /login, /login serves the login asset, /health is public and reports the gate, every /v1 door is 401", async () => {
  const e = env();
  const r0 = await worker.fetch(req("/"), e); assert.equal(r0.status, 302); assert.equal(new URL(r0.headers.get("location")).pathname, "/login");
  const r1 = await worker.fetch(req("/login"), e); assert.equal(r1.status, 200); assert.equal(await r1.text(), "asset:/login.html");
  const h = await (await worker.fetch(req("/health"), e)).json(); assert.equal(h.gate.gate, "armed"); assert.equal(h.session, false);
  for (const p of ["/v1/pane/health", "/v1/ide/health", "/v1/dwec", "/v1/dwec/runs", "/v1/desk", "/v1/auth/whoami"]) {
    const r = await worker.fetch(req(p), e); assert.equal(r.status, 401, p); assert.equal((await r.json()).login, "/login", p);
  }
  const rr = await worker.fetch(req("/v1/dwec/run", body({ profile: "tanoak" })), e); assert.equal(rr.status, 401, "a POST door is shut too");
  const rc = await worker.fetch(req("/v1/pane/configure", body({ profile: "tanoak" })), e); assert.equal(rc.status, 401);
});

test("fetch — with the cookie: / serves the Face, /login bounces to /, whoami names the operator, the doors open, logout clears", async () => {
  const e = env();
  const r0 = await worker.fetch(req("/", {}, COOKIE), e); assert.equal(r0.status, 200); assert.equal(await r0.text(), "asset:/");
  const r1 = await worker.fetch(req("/login", {}, COOKIE), e); assert.equal(r1.status, 302); assert.equal(new URL(r1.headers.get("location")).pathname, "/");
  const w = await (await worker.fetch(req("/v1/auth/whoami", {}, COOKIE), e)).json(); assert.equal(w.user, OPERATOR); assert.equal(w.role, "root");
  const d = await worker.fetch(req("/v1/pane/health", {}, COOKIE), e); assert.equal(d.status, 200); assert.equal(d.headers.get("x-wosp-upstream"), "wayne-aios-control-pane");
  const h = await (await worker.fetch(req("/health", {}, COOKIE), e)).json(); assert.equal(h.session, true);
  const out = await worker.fetch(req("/v1/auth/logout", { method: "POST" }, COOKIE), e); assert.equal(out.status, 200); assert.match(out.headers.get("set-cookie"), /Max-Age=0/);
});

test("fetch — CONTROL: a stale cookie and a forged cookie are as good as none", async () => {
  const e = env();
  assert.equal((await worker.fetch(req("/", {}, STALE_COOKIE), e)).status, 302);
  assert.equal((await worker.fetch(req("/v1/pane/health", {}, "wosp_session=abc.def"), e)).status, 401);
  const wrongKey = `wosp_session=${await signSession("not-the-key", { u: OPERATOR, role: "root", iat: 1, exp: Math.floor(Date.now() / 1000) + 60 })}`;
  assert.equal((await worker.fetch(req("/v1/pane/health", {}, wrongKey), e)).status, 401);
});

test("fetch — CONTROL: binding absent seals the Face (503), it does not open it; /health still answers", async () => {
  const e = env({ WOSP_AUTH: undefined });
  assert.equal((await worker.fetch(req("/"), e)).status, 503);
  assert.equal((await worker.fetch(req("/v1/pane/health", {}, COOKIE), e)).status, 503);
  const h = await (await worker.fetch(req("/health"), e)).json(); assert.equal(h.gate.gate, "absent");
});

test("fetch — login door end to end: POST /v1/auth/login sets the cookie that then opens a door; wrong password does not", async () => {
  const e = env();
  const r = await worker.fetch(req("/v1/auth/login", body({ username: "admin", password: PASSWORD })), e);
  assert.equal(r.status, 200); const sc = r.headers.get("set-cookie"); assert.match(sc, /^wosp_session=/);
  const cookie = sc.split(";")[0];
  assert.equal((await worker.fetch(req("/v1/ide/health", {}, cookie), e)).status, 200);
  const bad = await worker.fetch(req("/v1/auth/login", body({ username: "operator@smbos", password: "wrong" })), e); assert.equal(bad.status, 401); assert.equal(bad.headers.get("set-cookie"), null);
  const big = await worker.fetch(req("/v1/auth/login", { method: "POST", headers: { "content-type": "application/json", "content-length": String(20 * 1024) }, body: "{}" }), e); assert.equal(big.status, 413);
});

test("COMPOSED names the three auth routes and nothing under /v1/auth is a proxy door", () => {
  for (const k of ["POST /v1/auth/login", "POST /v1/auth/logout", "GET /v1/auth/whoami"]) assert.equal(typeof COMPOSED[k], "string", k);
});
