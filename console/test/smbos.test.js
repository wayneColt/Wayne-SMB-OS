// SMBOS card — composed from rc-qa-gate through the RCQA binding, read-only, behind the gate. fabricated:false
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { COMPOSED, UPSTREAM } from "../src/index.js";
import { minted, COOKIE } from "./_auth.js";
const ok = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json; charset=utf-8" } });
const env = (over = {}) => ({ CONTROL_PANE: { async fetch() { return ok({}); } }, DEV_IDE: { async fetch() { return ok({}); } }, STATE: { async fetch() { return ok({ state: {} }); } }, ASSETS: { async fetch() { return new Response("asset"); } }, WOSP_AUTH: minted(),
  RCQA: { async fetch(u) { const s = String(u); if (s.endsWith("/health")) return ok({ subscription: { id: "5486f61c", scope: "account", expires: "2026-09-12T20:59:45Z" }, sms: { armed: false, by: "apex 404" }, alerts_24h: [{ status: "drafted", n: 7 }] }); if (s.includes("/stats?")) return ok({ store: "STOREA", progress: { graded: 100, failed: 3 }, opportunity_summary: { calls_graded: 29, qualified_leads: 17, scheduled_on_the_call: 6, close_rate_pct: 35.3, lost_or_price_shopped: 11, lost_why: { "No Next Steps": 6 }, estimated_revenue_captured: "NO_SIGNAL" }, rubric: "client-rubric-example+wayne-smb-v1", generated_at: "2026-09-06T20:00:00Z" }); return ok({}, 404); } }, ...over });
const req = (p, cookie = COOKIE) => new Request("https://wosp-console.test" + p, { headers: cookie ? { cookie } : {} });

test("GET /v1/smbos composes health + stats, is shut to strangers, and says NO_SIGNAL when the binding is absent or the gate is down", async () => {
  assert.equal(typeof COMPOSED["GET /v1/smbos"], "string"); assert.equal(UPSTREAM.RCQA, "rc-qa-gate");
  assert.equal((await worker.fetch(req("/v1/smbos", null), env())).status, 401);
  const j = await (await worker.fetch(req("/v1/smbos"), env())).json();
  assert.equal(j.store, "STOREA"); assert.equal(j.subscription.scope, "account"); assert.equal(j.sms.armed, false); assert.equal(j.ladder.graded, 100); assert.equal(j.ladder.final, false); assert.equal(j.headline.close_rate_pct, 35.3); assert.equal(j.headline.revenue, "NO_SIGNAL"); assert.equal(j.kernel_accept, false);
  const w = await (await worker.fetch(req("/v1/smbos?store=storeb"), env())).json(); assert.equal(w.store, "STOREB");
  assert.equal((await worker.fetch(req("/v1/smbos"), env({ RCQA: undefined }))).status, 503);
  assert.equal((await worker.fetch(req("/v1/smbos"), env({ RCQA: { async fetch() { return ok({}, 500); } } }))).status, 503);
});

test("GET /v1/smbos/feed: shut to a stranger; through the RCQA binding it relays the instant-feedback list", async () => {
  const e = env({ RCQA: { async fetch(u) { const s = String(u); if (s.includes("/feed")) return ok({ store: "STOREA", hours: 24, n: 1, calls: [{ rep_name: "Jordan Lee", intake_outcome: "Scheduled", total_score: 17, coaching_note: "confirm by text", minutes_to_note: 3 }], fabricated: false }); return ok({}); } } });
  assert.equal((await worker.fetch(req("/v1/smbos/feed", {}, null), e)).status, 401);
  const r = await worker.fetch(req("/v1/smbos/feed?store=STOREA"), e); assert.equal(r.status, 200);
  const j = await r.json(); assert.equal(j.n, 1); assert.equal(j.calls[0].rep_name, "Jordan Lee"); assert.equal(j.organ, "rc-qa-gate"); assert.equal(j.fabricated, false);
});
