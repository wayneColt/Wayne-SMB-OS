// The ingress must prove it can refuse: wrong token, wrong path, non-disconnect, duplicate. fabricated:false
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { isDisconnected, DELAY_S } from "../src/index.js";

function env(over = {}) {
  const kv = new Map(); const sent = [];
  return { env: { SEEN: { async get(k) { return kv.has(k) ? kv.get(k) : null; }, async put(k, v) { kv.set(k, String(v)); } }, QA_QUEUE: { async send(body, opts) { sent.push({ body, opts }); } }, RC_VALIDATION_TOKEN: "tok-1", ...over }, kv, sent };
}
const evt = (sid, code = "Disconnected") => JSON.stringify({ uuid: "u", timestamp: "2026-09-05T20:00:00Z", event: "/restapi/v1.0/account/1/telephony/sessions", body: { telephonySessionId: sid, parties: [{ id: "p1", status: { code } }, { id: "p2", status: { code: "Answered" } }] } });
const post = (body, headers = {}, path = "/hook") => new Request("https://rc-qa.test" + path, { method: "POST", headers, body });

test("handshake: Validation-Token with no event body is echoed 200 and nothing is enqueued", async () => {
  const { env: e, sent } = env();
  const r = await worker.fetch(post("", { "Validation-Token": "abc" }), e, {});
  assert.equal(r.status, 200); assert.equal(r.headers.get("Validation-Token"), "abc"); assert.equal(sent.length, 0);
  const r2 = await worker.fetch(new Request("https://rc-qa.test/hook", { headers: { "Validation-Token": "xyz" } }), e, {});
  assert.equal(r2.headers.get("Validation-Token"), "xyz");
});

test("a Disconnected event with the right token is queued once with the 90 s delay; the second delivery is a dup", async () => {
  const { env: e, sent } = env();
  const r = await worker.fetch(post(evt("s-1"), { "Validation-Token": "tok-1" }), e, {});
  assert.equal(r.status, 200); assert.equal(await r.text(), "queued");
  assert.equal(sent.length, 1); assert.equal(sent[0].body.telephonySessionId, "s-1"); assert.equal(sent[0].opts.delaySeconds, DELAY_S);
  const r2 = await worker.fetch(post(evt("s-1"), { "Validation-Token": "tok-1" }), e, {});
  assert.equal(await r2.text(), "dup"); assert.equal(sent.length, 1);
});

test("CONTROL — wrong or missing token: 200 (never 4xx to RingCentral) and NOT enqueued; an event body with a token is not mistaken for a handshake", async () => {
  const { env: e, sent } = env();
  assert.equal(await (await worker.fetch(post(evt("s-2"), { "Validation-Token": "wrong" }), e, {})).text(), "ignored");
  assert.equal(await (await worker.fetch(post(evt("s-2")), e, {})).text(), "ignored");
  assert.equal(sent.length, 0);
  const r = await worker.fetch(post(evt("s-2"), { "Validation-Token": "wrong" }), e, {});
  assert.equal(r.headers.get("Validation-Token"), null, "an event is never echoed as a handshake");
});

test("CONTROL — unarmed ingress (no RC_VALIDATION_TOKEN) ignores every event; health says armed:false", async () => {
  const { env: e, sent } = env({ RC_VALIDATION_TOKEN: undefined });
  assert.equal(await (await worker.fetch(post(evt("s-3"), { "Validation-Token": "anything" }), e, {})).text(), "ignored"); assert.equal(sent.length, 0);
  const h = await (await worker.fetch(new Request("https://rc-qa.test/health"), e, {})).json(); assert.equal(h.armed, false); assert.equal(h.stats.bad_token, 1);
});

test("non-disconnect events, malformed bodies, other paths and GET on the hook are refused without enqueue", async () => {
  const { env: e, sent } = env();
  assert.equal(await (await worker.fetch(post(evt("s-4", "Answered"), { "Validation-Token": "tok-1" }), e, {})).text(), "ignored");
  assert.equal(await (await worker.fetch(post("not json", { "Validation-Token": "tok-1" }), e, {})).text(), "ignored");
  assert.equal((await worker.fetch(post(evt("s-4"), { "Validation-Token": "tok-1" }, "/other"), e, {})).status, 404);
  assert.equal((await worker.fetch(new Request("https://rc-qa.test/hook"), e, {})).status, 405);
  assert.equal(sent.length, 0);
  assert.equal(isDisconnected({ body: { parties: [] } }), false); assert.equal(isDisconnected(null), false);
});

// MEASURED 2026-09-08: RingCentral deliveries carry no Validation-Token. A delivery is verified by its subscriptionId
// against the gate's sub:state record in the shared KV; a wrong or unknown id is refused, and a token, when present, must still match.
test("delivery without a token is queued when its subscriptionId matches the gate's sub:state; refused otherwise", async () => {
  const { env: e, sent } = env();
  await e.SEEN.put("sub:state", JSON.stringify({ ok: true, action: "kept", id: "sub-live", scope: "account" }));
  const withSub = (sid, subscriptionId) => JSON.stringify({ uuid: "u", timestamp: "2026-09-08T17:40:00Z", event: "/restapi/v1.0/account/1/telephony/sessions", subscriptionId, body: { telephonySessionId: sid, parties: [{ id: "p1", status: { code: "Disconnected" } }] } });
  assert.equal(await (await worker.fetch(post(withSub("s-5", "sub-live")), e, {})).text(), "queued");
  assert.equal(sent.length, 1); assert.equal(sent[0].body.telephonySessionId, "s-5");
  assert.equal(await (await worker.fetch(post(withSub("s-6", "sub-stale")), e, {})).text(), "ignored");
  assert.equal(await (await worker.fetch(post(withSub("s-7", "sub-live"), { "Validation-Token": "wrong" }), e, {})).text(), "ignored", "a token that is present must still match");
  assert.equal(sent.length, 1);
  const h = await (await worker.fetch(new Request("https://rc-qa.test/health"), e, {})).json();
  assert.equal(h.stats.sub_verified, 1); assert.equal(h.stats.bad_token, 2); assert.equal(h.last_reject.sid, "s-7");
});
