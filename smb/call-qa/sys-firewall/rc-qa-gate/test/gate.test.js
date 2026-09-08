// The consumer must prove its ladder and its gates from the refusing side: no call-log row → retry,
// no recording → retry then no_recording, bad observations → retry, SMS drafted when nothing arms it,
// sent only when the plane arms it, suppressed at the cap. fabricated:false
import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { processJob, smsArmed, MAX_RECORDING_ATTEMPTS, RETRY_DELAY_S, stats, MAX_GRADE_ATTEMPTS } from "../src/index.js";
import { legsOf, extOf } from "../src/calllog.js";

const okJson = (b, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
function fakeDb() {
  const rows = { calls: new Map(), grades: [], alerts: [] }; const sql = [];
  const exec = (q, args) => {
    sql.push(q.split("\n")[0].slice(0, 60));
    if (/^INSERT INTO calls/.test(q) || /^INSERT OR REPLACE INTO calls/.test(q)) { rows.calls.set(args[0], { status: /'no_recording'/.test(q) ? "no_recording" : (/'failed'/.test(q) ? "failed" : args[13]), transcript: args[12], attempts: args[14], error: args[15] }); return {}; }
    if (/^INSERT (OR REPLACE )?INTO grades/.test(q)) { rows.grades = rows.grades.filter((g) => g.sid !== args[0]); rows.grades.push({ sid: args[0], scores: args.slice(1, 5), total: args[5], outcome: args[6], qualified: args[7], intake: args[8], service: args[9] }); return {}; }
    if (/^INSERT INTO alerts/.test(q)) { rows.alerts.push({ sid: args[0], code: args[1], reason: args[2], to: args[3], text: args[4], status: args[5] }); return {}; }
    return {};
  };
  return { rows, sql, DB: { prepare(q) { let args = []; return { bind(...a) { args = a; return this; }, async run() { return exec(q, args); }, async first() { if (/COUNT\(\*\) AS n FROM alerts WHERE status='sent'/.test(q)) return { n: rows.alerts.filter((a) => a.status === "sent").length }; if (/SELECT status, transcript FROM calls/.test(q)) { const r = rows.calls.get(args[0]); return r && r.transcript ? { status: r.status, transcript: r.transcript } : null; } if (/SELECT status FROM calls WHERE/.test(q)) { const r = rows.calls.get(args[0]); return r ? { status: r.status } : null; } return null; }, async all() { return { results: [] }; } }; } } };
}
function env(over = {}) {
  const kv = new Map(); const db = fakeDb(); const inferCalls = [];
  const e = {
    SEEN: { async get(k, type) { const v = kv.has(k) ? kv.get(k) : null; return type === "json" && v !== null ? JSON.parse(v) : v; }, async put(k, v) { kv.set(k, String(v)); }, async delete(k) { kv.delete(k); } },
    DB: db.DB, RC_CLIENT_ID: "id", RC_CLIENT_SECRET: "sec", RC_JWT: "jwt", RC_SERVER: "https://rc.test", STORE_CODE: "STOREA", SHOP_MANAGER_PHONE: "+15550100001", RC_SMS_FROM: "+14695550100", SMS_LIVE: "0", APEX_STATE_URL: "https://state.test/state/apex:wosp",
    INFER: { async fetch(u, init) { inferCalls.push(String(u)); if (String(u).endsWith("/transcribe")) return okJson({ text: "Thanks for calling the shop Store A, this is Rep." }); return okJson(over.grade || { observations: { greeting_score: 4, discovery_score: 4, action_score: 4, empathy_score: 4, qualified: true, intake_outcome: "Scheduled", service_type: "brakes", hostility_flag: false, strengths: "s", coaching_note: "c" }, model: "llm", rubric_version: "client-rubric-example+wayne-smb-v1" }); } },
    ...over,
  };
  return { e, kv, db, inferCalls };
}
const record = (sid, withRecording = true, duration = 120) => ({ telephonySessionId: sid, startTime: "2026-09-05T20:00:00Z", duration, direction: "Inbound", extension: { id: "7", extensionNumber: "114" }, from: { phoneNumber: "+1254000" }, to: { phoneNumber: "+1254111" }, ...(withRecording ? { recording: { id: "r1", contentUri: "https://media.test/r1", type: "Automatic" } } : {}) });
/** a fetch that answers RingCentral for the token, the call log, the extension, media, sms, and the apex state */
function rcFetch({ records = [], apex = null, sms = { ok: true } } = {}) {
  const calls = [];
  return { calls, fetch: async (u, init = {}) => { const s = String(u); calls.push({ u: s, m: init.method || "GET" });
    if (s.endsWith("/restapi/oauth/token")) return okJson({ access_token: "tok", expires_in: 3600 });
    if (s.includes("/call-log?")) { assert.match(s, /telephonySessionId=/, "direct lookup, not a window scan"); return okJson({ records }); }
    if (s.includes("/extension/7")) return okJson({ name: "Joey Dudik" });
    if (s.startsWith("https://media.test/")) { assert.equal(init.headers.Authorization, "Bearer tok", "bearer header, never a query param"); return new Response(new Uint8Array([1, 2, 3])); }
    if (s.endsWith("/extension/~/sms")) return sms.ok ? okJson({ id: "m1" }) : okJson({ message: "InvalidPhoneNumber" }, 400);
    if (s.includes("apex:wosp")) return apex ? okJson({ state: apex }) : new Response("nope", { status: 404 });
    return new Response("?", { status: 500 }); } };
}
const armedApex = { dial: { position: 65 }, switchboard: { circuits: [{ id: "ringcentral", toggle: "ON" }, { id: "write_ops", toggle: "ON" }, { id: "prod", toggle: "ON" }] } };

test("legsOf: dedupes by recording id across records and legs, sorts by startTime, ignores other sessions", () => {
  const recs = [ { telephonySessionId: "s", startTime: "2026-09-05T20:05:00Z", recording: { id: "b", contentUri: "u/b" }, legs: [{ startTime: "2026-09-05T20:05:00Z", recording: { id: "b", contentUri: "u/b" } }] }, { telephonySessionId: "s", startTime: "2026-09-05T20:00:00Z", recording: { id: "a", contentUri: "u/a" } }, { telephonySessionId: "other", startTime: "2026-09-05T19:00:00Z", recording: { id: "z", contentUri: "u/z" } } ];
  const { legs, meta } = legsOf(recs, "s"); assert.deepEqual(legs.map((l) => l.recordingId), ["a", "b"]); assert.equal(meta.telephonySessionId, "s");
  assert.deepEqual(legsOf([], "s"), { legs: [], meta: null });
  // attribution fallbacks: on a leg, then on the internal party (queue-routed inbound)
  assert.deepEqual(extOf({ legs: [{ extension: { id: "9", extensionNumber: "114" } }] }), { id: "9", extensionNumber: "114" });
  assert.deepEqual(extOf({ to: { extensionId: "5", extensionNumber: "122", name: "Store A SalesDesk" } }), { id: "5", extensionNumber: "122", name: "Store A SalesDesk" });
  assert.equal(extOf({ to: { phoneNumber: "+1" } }), null);
  assert.equal(legsOf([{ telephonySessionId: "q", startTime: "2026-09-05T20:00:00Z", legs: [{ extension: { id: "9" } }] }], "q").meta.extension.id, "9");
});

test("ladder: not in the call log → retry until the max, then no_recording; recording absent → retry, then no_recording naming the 30 s rule", async () => {
  const { e, db } = env(); const { fetch } = rcFetch({ records: [] });
  await assert.rejects(() => processJob(e, { telephonySessionId: "s1", sessionEndIso: "2026-09-05T20:10:00Z" }, 1, fetch), /not in the call log yet/);
  const out = await processJob(e, { telephonySessionId: "s1", sessionEndIso: "2026-09-05T20:10:00Z" }, MAX_RECORDING_ATTEMPTS, fetch); assert.equal(out.status, "no_recording"); assert.equal(db.rows.calls.get("s1").status, "no_recording");
  const { e: e2, db: db2 } = env(); const { fetch: f2 } = rcFetch({ records: [record("s2", false, 20)] });
  await assert.rejects(() => processJob(e2, { telephonySessionId: "s2", sessionEndIso: "2026-09-05T20:10:00Z" }, 2, f2), /no recording yet/); assert.equal(db2.rows.calls.get("s2").status, "queued");
  const o2 = await processJob(e2, { telephonySessionId: "s2", sessionEndIso: "2026-09-05T20:10:00Z" }, MAX_RECORDING_ATTEMPTS, f2); assert.equal(o2.status, "no_recording"); assert.match(db2.rows.calls.get("s2").error, /under 30 s/);
});

test("happy path: token cached, media by bearer header, transcript redacted into calls, four subscores + code-computed total into grades, rep name from the extension, no alert at 16/20", async () => {
  const { e, db, kv, inferCalls } = env(); const { fetch, calls } = rcFetch({ records: [record("s3")] });
  const out = await processJob(e, { telephonySessionId: "s3", sessionEndIso: "2026-09-05T20:10:00Z" }, 1, fetch);
  assert.equal(out.status, "graded"); assert.equal(out.total, 16); assert.equal(out.alert, null); assert.equal(out.rep, "Joey Dudik");
  assert.equal(kv.get("rc:access_token"), "tok"); assert.equal(calls.filter((c) => c.u.endsWith("/oauth/token")).length, 1);
  assert.deepEqual(inferCalls, ["https://internal/transcribe", "https://internal/grade"]);
  assert.deepEqual(db.rows.grades[0].scores, [4, 4, 4, 4]); assert.equal(db.rows.grades[0].total, 16); assert.equal(db.rows.grades[0].outcome, "booked"); assert.equal(db.rows.grades[0].intake, "Scheduled"); assert.equal(db.rows.grades[0].qualified, 1); assert.equal(db.rows.calls.get("s3").status, "graded"); assert.match(db.rows.calls.get("s3").transcript, /the shop/);
  assert.equal(db.rows.alerts.length, 0);
});

test("CONTROL — observations the model got wrong (a 6, a volunteered total) are rejected and retried, never written", async () => {
  const { e, db } = env({ grade: { observations: { greeting_score: 6, discovery_score: 4, action_score: 4, empathy_score: 4, qualified: true, intake_outcome: "Scheduled", service_type: "x", hostility_flag: false, strengths: "", coaching_note: "c" }, model: "llm", rubric_version: "client-rubric-example+wayne-smb-v1" } });
  const { fetch } = rcFetch({ records: [record("s4")] });
  await assert.rejects(() => processJob(e, { telephonySessionId: "s4", sessionEndIso: "2026-09-05T20:10:00Z" }, 1, fetch), /observations rejected/); assert.equal(db.rows.grades.length, 0);
});

test("alerts: low score is DRAFTED when nothing arms SMS; SENT when the apex plane arms ringcentral+write_ops+prod at ASSISTED; suppressed at the cap; lost lead needs > 3 min", async () => {
  const low = { observations: { greeting_score: 2, discovery_score: 3, action_score: 2, empathy_score: 3, qualified: false, intake_outcome: "Not Qualified", service_type: "unknown", hostility_flag: false, strengths: "", coaching_note: "Ask the shop name first." }, model: "llm", rubric_version: "client-rubric-example+wayne-smb-v1" };
  const { e, db } = env({ grade: low }); const { fetch, calls } = rcFetch({ records: [record("s5")], apex: null });
  const out = await processJob(e, { telephonySessionId: "s5", sessionEndIso: "2026-09-05T20:10:00Z" }, 1, fetch);
  assert.deepEqual([out.alert.code, out.alert.status], ["LOW_SCORE", "drafted"]); assert.equal(calls.some((c) => c.u.endsWith("/sms")), false, "no SMS left the building");
  assert.equal(db.rows.alerts[0].status, "drafted"); assert.match(db.rows.alerts[0].text, /Score: 10\/20/);
  // the plane arms it
  const { e: e2, db: db2 } = env({ grade: low }); const { fetch: f2, calls: c2 } = rcFetch({ records: [record("s6")], apex: armedApex });
  const o2 = await processJob(e2, { telephonySessionId: "s6", sessionEndIso: "2026-09-05T20:10:00Z" }, 1, f2);
  assert.equal(o2.alert.status, "sent"); assert.match(o2.alert.by, /apex dial 65 ASSISTED/); assert.equal(c2.some((c) => c.u.endsWith("/sms") && c.m === "POST"), true); assert.equal(db2.rows.alerts[0].status, "sent");
  // CONTROL: the plane at SHADOW (50) does not arm a prod write even with every toggle on
  const { e: e3 } = env({ grade: low }); const { fetch: f3, calls: c3 } = rcFetch({ records: [record("s7")], apex: { ...armedApex, dial: { position: 50 } } });
  const o3 = await processJob(e3, { telephonySessionId: "s7", sessionEndIso: "2026-09-05T20:10:00Z" }, 1, f3); assert.equal(o3.alert.status, "drafted"); assert.match(o3.alert.by, /PROD_BELOW_ASSISTED/); assert.equal(c3.some((c) => c.u.endsWith("/sms")), false);
  // suppressed at the cap
  const { e: e4, db: db4 } = env({ grade: low, SMS_LIVE: "1" }); for (let i = 0; i < 4; i++) db4.rows.alerts.push({ status: "sent" });
  const { fetch: f4, calls: c4 } = rcFetch({ records: [record("s8")] });
  const o4 = await processJob(e4, { telephonySessionId: "s8", sessionEndIso: "2026-09-05T20:10:00Z" }, 1, f4); assert.equal(o4.alert.status, "suppressed"); assert.equal(c4.some((c) => c.u.endsWith("/sms")), false);
  // lost lead: 3:00 exactly does not trigger, 3:01 does
  const lost = { observations: { ...low.observations, greeting_score: 4, discovery_score: 4, action_score: 4, empathy_score: 4, qualified: true, intake_outcome: "Will Call Back", service_type: "diagnostic" }, model: "llm", rubric_version: "client-rubric-example+wayne-smb-v1" };
  const { e: e5 } = env({ grade: lost }); const { fetch: f5 } = rcFetch({ records: [record("s9", true, 180)] }); assert.equal((await processJob(e5, { telephonySessionId: "s9", sessionEndIso: "2026-09-05T20:10:00Z" }, 1, f5)).alert, null);
  const { e: e6 } = env({ grade: lost }); const { fetch: f6 } = rcFetch({ records: [record("s10", true, 181)] }); assert.equal((await processJob(e6, { telephonySessionId: "s10", sessionEndIso: "2026-09-05T20:10:00Z" }, 1, f6)).alert.code, "LOST_LEAD");
});

test("smsArmed fails closed: no apex state, dark ringcentral circuit, dial cliff; SMS_LIVE=1 arms directly", async () => {
  const { e } = env(); const { fetch } = rcFetch({ apex: null });
  assert.equal((await smsArmed(e, fetch)).armed, false);
  const { fetch: f2 } = rcFetch({ apex: { ...armedApex, switchboard: { circuits: [{ id: "write_ops", toggle: "ON" }, { id: "prod", toggle: "ON" }] } } }); assert.match((await smsArmed(e, f2)).by, /ringcentral circuit dark/);
  const { fetch: f3 } = rcFetch({ apex: { ...armedApex, dial: { position: 40 } } }); assert.match((await smsArmed(e, f3)).by, /DIAL_CLIFF/);
  assert.deepEqual(await smsArmed({ ...e, SMS_LIVE: "1" }, fetch), { armed: true, by: "SMS_LIVE" });
});

test("queue handler: retryable → retry with the ladder delay; non-retryable → failed row + ack; admin routes need the token", async () => {
  const { e } = env(); const acks = [], retries = [];
  const msg = (body, attempts = 1) => ({ body, attempts, ack() { acks.push(body); }, retry(o) { retries.push(o); } });
  const eThrow = { ...e, SEEN: { async get() { throw new Error("kv down"); }, async put() {}, async delete() {} } };
  await worker.queue({ messages: [msg({ telephonySessionId: "q1" })] }, eThrow); assert.equal(acks.length, 1, "a non-retryable error acks after recording failed"); assert.equal(retries.length, 0);
  const eRetry = { ...e, INFER: { async fetch() { return okJson({ membrane: "NO_SIGNAL", reason: "JSON Mode couldn't be met" }, 502); } } };
  globalThis.fetch = rcFetch({ records: [record("q2")] }).fetch;
  await worker.queue({ messages: [msg({ telephonySessionId: "q2", sessionEndIso: "2026-09-05T20:10:00Z" })] }, eRetry); assert.deepEqual(retries, [{ delaySeconds: RETRY_DELAY_S }]);
  const r = await worker.fetch(new Request("https://gate.test/admin/replay/abc", { method: "POST" }), { ...e, ADMIN_TOKEN: "adm" }); assert.equal(r.status, 401);
  const sent = []; const r2 = await worker.fetch(new Request("https://gate.test/admin/replay/abc", { method: "POST", headers: { "X-Admin-Token": "adm" } }), { ...e, ADMIN_TOKEN: "adm", QA_QUEUE: { async send(b, o) { sent.push({ b, o }); } } }); assert.equal(r2.status, 200); assert.equal(sent[0].b.telephonySessionId, "abc");
});

test("throttle discipline: the shared bucket refuses a sixth call-log slot in a minute WITHOUT touching RingCentral; a 429 backs off ≥ 7 min; retry delay follows the error", async () => {
  const { takeCallLogSlot, RetryableError, THROTTLE_BACKOFF_S } = await import("../src/calllog.js");
  const { e } = env();
  for (let i = 0; i < 5; i++) await takeCallLogSlot(e);
  await assert.rejects(() => takeCallLogSlot(e), (err) => err.retryable && err.delaySeconds >= 90 && /budget spent/.test(err.message));
  const { e: e2 } = env(); const calls = [];
  const f = async (u, init = {}) => { calls.push(String(u)); if (String(u).endsWith("/oauth/token")) return okJson({ access_token: "tok", expires_in: 3600 }); if (String(u).includes("/call-log?")) return new Response("{}", { status: 429 }); return new Response("?", { status: 500 }); };
  await assert.rejects(() => processJob(e2, { telephonySessionId: "t1", sessionEndIso: "2026-09-05T20:10:00Z" }, 1, f), (err) => err.retryable && err.delaySeconds >= THROTTLE_BACKOFF_S && /throttled/.test(err.message));
  const retries = []; const msg = { body: { telephonySessionId: "t2", sessionEndIso: "2026-09-05T20:10:00Z" }, attempts: 1, ack() {}, retry(o) { retries.push(o); } };
  globalThis.fetch = f; await worker.queue({ messages: [msg] }, env().e); assert.ok(retries[0].delaySeconds >= THROTTLE_BACKOFF_S, "the queue retry carries the error's delay");
});

test("prefetched legs: a replay that carries its legs never calls the call log, and grades from media alone", async () => {
  const { e, db } = env(); const calls = [];
  const f = async (u, init = {}) => { calls.push(String(u)); if (String(u).endsWith("/oauth/token")) return okJson({ access_token: "tok", expires_in: 3600 }); if (String(u).includes("/extension/7")) return okJson({ name: "Joey Dudik" }); if (String(u).startsWith("https://media.test/")) return new Response(new Uint8Array([1, 2, 3])); return new Response("?", { status: 500 }); };
  const job = { telephonySessionId: "p1", sessionEndIso: "2026-09-05T20:10:00Z", prefetched: { legs: [{ recordingId: "r9", contentUri: "https://media.test/r9", startTime: "2026-09-05T20:00:00Z" }], meta: { startTime: "2026-09-05T20:00:00Z", duration: 120, direction: "Inbound", extension: { id: "7", extensionNumber: "114" }, from: { phoneNumber: "+1" }, to: { phoneNumber: "+2" } } } };
  const out = await processJob(e, job, 1, f);
  assert.equal(out.status, "graded"); assert.equal(calls.some((u) => u.includes("/call-log")), false, "no Heavy-group call"); assert.equal(db.rows.grades.length, 1); assert.equal(out.rep, "Joey Dudik");
});

test("a token that dies under the media fetch is re-minted once and the job finishes; a second death pauses the job instead of failing it", async () => {
  const { e, kv, db } = env(); const calls = []; let mediaHits = 0;
  const f = async (u, init = {}) => { const s = String(u); calls.push({ u: s, auth: (init.headers || {}).Authorization });
    if (s.endsWith("/oauth/token")) return okJson({ access_token: "tok" + calls.filter((c) => c.u.endsWith("/oauth/token")).length, expires_in: 3600 });
    if (s.includes("/call-log?")) return okJson({ records: [record("d1")] });
    if (s.includes("/extension/7")) return okJson({ name: "Joey Dudik" });
    if (s.startsWith("https://media.test/")) { mediaHits++; return mediaHits === 1 ? new Response("", { status: 401 }) : new Response(new Uint8Array([1, 2, 3])); }
    return new Response("?", { status: 500 }); };
  const out = await processJob(e, { telephonySessionId: "d1", sessionEndIso: "2026-09-05T20:10:00Z" }, 1, f);
  assert.equal(out.status, "graded"); assert.equal(mediaHits, 2);
  const mints = calls.filter((c) => c.u.endsWith("/oauth/token")).length; assert.equal(mints, 2, "one cached mint, one fresh mint after the 401");
  assert.equal(calls.filter((c) => c.u.startsWith("https://media.test/"))[1].auth, "Bearer tok2", "the retry carries the fresh token");
  assert.equal(kv.get("rc:access_token"), "tok2");
  const { e: e2 } = env(); const f2 = async (u, init = {}) => { const s = String(u); if (s.endsWith("/oauth/token")) return okJson({ access_token: "t", expires_in: 3600 }); if (s.includes("/call-log?")) return okJson({ records: [record("d2")] }); if (s.startsWith("https://media.test/")) return new Response("", { status: 401 }); return okJson({ name: "x" }); };
  await assert.rejects(() => processJob(e2, { telephonySessionId: "d2", sessionEndIso: "2026-09-05T20:10:00Z" }, 1, f2), (err) => err.retryable && err.delaySeconds >= 300 && /twice/.test(err.message));
});

test("the auth endpoint has its own bucket: a fourth mint in a minute waits instead of hitting RingCentral; a 429 there is retryable", async () => {
  const { rcToken } = await import("../src/token.js"); const { e } = env(); let mints = 0;
  const f = async (u) => { if (String(u).endsWith("/oauth/token")) { mints++; return okJson({ access_token: "t" + mints, expires_in: 3600 }); } return new Response("?", { status: 500 }); };
  for (let i = 0; i < 3; i++) await rcToken(e, f, true);
  await assert.rejects(() => rcToken(e, f, true), (err) => err.retryable && /auth budget/.test(err.message)); assert.equal(mints, 3);
  const { e: e2 } = env(); const f429 = async () => new Response("", { status: 429 });
  await assert.rejects(() => rcToken(e2, f429, true), (err) => err.retryable && /auth throttled/.test(err.message));
});

test("store attribution is measured, never defaulted: dialed number → store; extension majority → store; nothing → UNKNOWN; shared lines fold into Unassigned", async () => {
  const { storeOf, parseStoreMap, staffOf, isSharedLine } = await import("../src/policy.js");
  const map = parseStoreMap(JSON.stringify({ store_of_number: { "+15550100004": "STOREA", "+15550100005": "STOREB" }, extension_store: { "9": "STOREA" }, shared_extensions: { "5": "CBA - Store A Main" } }));
  assert.equal(storeOf(map, { direction: "Inbound", to_number: "+15550100004", from_number: "+1999" }), "STOREA");
  assert.equal(storeOf(map, { direction: "Outbound", from_number: "+15550100005", to_number: "+1999" }), "STOREB");
  assert.equal(storeOf(map, { direction: "Inbound", to_number: "+1000", from_number: "+1999", extension_id: "9" }), "STOREA", "falls to the extension's measured store");
  assert.equal(storeOf(map, { direction: "Inbound", to_number: "+1000", from_number: "+1999", extension_id: "77" }), "UNKNOWN");
  assert.equal(staffOf("CBA - Store A Main", isSharedLine(map, "5")), "Unassigned"); assert.equal(staffOf("Joey Dudik", isSharedLine(map, "9")), "Joey Dudik");
  assert.deepEqual(parseStoreMap("not json"), { numbers: {}, extensions: {}, shared: {} });
});

test("attribution from the inventory overrides a Simple-view meta that names no agent: rep, extension and store come from attr:<sid>", async () => {
  const { e, db, kv } = env({ STORE_MAP: JSON.stringify({ store_of_number: {}, extension_store: {}, shared_extensions: { "5": "CBA - Store A Main" } }) });
  kv.set("attr:a1", JSON.stringify({ extension_id: "9", extension_number: "110", rep_name: "Alex Rivera", store_code: "STOREA", shared: false }));
  const f = async (u, init = {}) => { const s = String(u); if (s.endsWith("/oauth/token")) return okJson({ access_token: "tok", expires_in: 3600 }); if (s.startsWith("https://media.test/")) return new Response(new Uint8Array([1, 2, 3])); return new Response("?", { status: 500 }); };
  const job = { telephonySessionId: "a1", sessionEndIso: "2026-09-05T20:10:00Z", prefetched: { legs: [{ recordingId: "r1", contentUri: "https://media.test/r1", startTime: "2026-09-05T20:00:00Z" }], meta: { startTime: "2026-09-05T20:00:00Z", duration: 120, direction: "Inbound", from: { phoneNumber: "+1" }, to: { phoneNumber: "+2" } } } };
  const out = await processJob(e, job, 1, f);
  assert.equal(out.status, "graded"); assert.equal(out.rep, "Alex Rivera");
  const sql = db.sql.find((q) => /^INSERT INTO calls/.test(q)); assert.ok(sql);
});

test("stats: the client's sections count inbound calls only — an outbound 'Scheduled' is coaching, not a closed lead; direction-unknown rows are reported, never folded in", async () => {
  const row = (dir, q, io, rep = "Rep A", start = "2026-09-01T15:00:00Z") => ({ rep_name: rep, extension_id: "7", extension_number: "114", store_code: "STOREA", direction: dir, duration_sec: 200, start_time: start,
    greeting_score: 4, discovery_score: 3, action_score: 3, empathy_score: 4, total_score: 14, qualified: q, intake_outcome: io, service_type: "brakes", hostility_flag: 0 });
  const ROWS = [row("Inbound", 1, "Scheduled"), row("Inbound", 1, "Will Call Back"), row("Inbound", 0, "Not Qualified"), row("Outbound", 1, "Scheduled"), row(null, 1, "Scheduled")];
  const PROG = [{ status: "graded", n: 5 }]; const ANSWERED = [{ store_code: "STOREA", direction: "Inbound", n: 9 }, { store_code: "STOREA", direction: "Outbound", n: 4 }, { store_code: "STOREB", direction: "Inbound", n: 50 }];
  const progQ = []; const DB = { prepare(q) { return { bind(...a) { if (/COUNT\(\*\) AS n FROM calls/.test(q)) progQ.push({ q, a }); return this; }, async all() { return { results: /FROM grades g JOIN calls/.test(q) ? ROWS : (/GROUP BY store_code, direction/.test(q) ? ANSWERED : PROG) }; } }; } };
  const s = await stats({ DB, STORE_MAP: JSON.stringify({ store_of_number: {}, extension_store: {}, shared_extensions: [] }) }, 90, "STOREA");
  const o = s.opportunity_summary;
  assert.equal(o.total_inbound_calls_answered, 9, "answered = inbound sessions the ladder saw for this store, not the graded count");
  assert.equal(o.calls_graded, 3, "graded = inbound scored rows"); assert.equal(o.outbound_calls_graded, 1); assert.equal(o.direction_unknown, 1);
  assert.equal(o.qualified_leads, 2, "the outbound and unknown 'Scheduled' rows are not leads"); assert.equal(o.scheduled_on_the_call, 1); assert.equal(o.close_rate_pct, 50);
  assert.deepEqual(s.excluded_by_direction, { Outbound: 1, unknown: 1 }); assert.equal(s.kpi_base, "inbound calls only");
  assert.equal(s.staff_intake_coaching.length, 1); assert.equal(s.staff_intake_coaching[0].qualified_leads_handled, 2);
  assert.equal(s.coaching_rubric.weekly.length, 1); assert.equal(s.coaching_rubric.weekly[0].n, 3, "the weekly trend is inbound-only too");
  assert.ok(progQ.some((x) => /WHERE store_code = \?/.test(x.q) && x.a[0] === "STOREA"), "progress is per store when a store is asked for — Store A reads FINAL on its own ledger");
});

test("a retry after a rejected grade reuses the stored transcript (no second media fetch, no second whisper) and, after MAX_GRADE_ATTEMPTS, lands as failed with the reason — never an endless retry", async () => {
  const badGrade = { observations: { greeting_score: 5, discovery_score: 4, action_score: 5, empathy_score: 5, qualified: "yes", intake_outcome: "Scheduled", service_type: "brakes", hostility_flag: false, coaching_note: "x" } };
  const { e, db, inferCalls } = env({ grade: badGrade }); let media = 0;
  const f = async (u) => { const s = String(u); if (s.endsWith("/oauth/token")) return okJson({ access_token: "tok", expires_in: 3600 }); if (s.includes("/extension/7")) return okJson({ name: "Joey Dudik" }); if (s.startsWith("https://media.test/")) { media++; return new Response(new Uint8Array([1, 2, 3]), { status: 200 }); } return okJson({ records: [] }); };
  const job = { telephonySessionId: "g1", sessionEndIso: "2026-09-05T20:10:00Z", prefetched: { legs: [{ recordingId: "r1", contentUri: "https://media.test/r1", startTime: "2026-09-05T20:00:00Z" }], meta: { startTime: "2026-09-05T20:00:00Z", duration: 120, direction: "Inbound", extension: { id: "7", extensionNumber: "114" }, from: { phoneNumber: "+1254000" }, to: { phoneNumber: "+15550100004" } } } };
  await assert.rejects(processJob(e, job, 1, f), /observations rejected/);
  assert.equal(media, 1); assert.equal(inferCalls.filter((u) => u.endsWith("/transcribe")).length, 1);
  assert.equal(db.rows.calls.get("g1").status, "transcribed");
  await assert.rejects(processJob(e, job, 2, f), /observations rejected/);
  assert.equal(media, 1, "the stored transcript is reused: no second media fetch"); assert.equal(inferCalls.filter((u) => u.endsWith("/transcribe")).length, 1, "no second whisper pass");
  const out = await processJob(e, job, MAX_GRADE_ATTEMPTS, f);
  assert.equal(out.status, "failed"); assert.match(out.reason, /observations rejected: qualified must be boolean — after 6 attempts/);
  assert.equal(db.rows.calls.get("g1").status, "failed");
  // an empty coaching note on a stable transcript grades on the next pass
  e.INFER = { async fetch(u) { inferCalls.push(String(u)); return okJson({ observations: { ...badGrade.observations, qualified: true, coaching_note: "" } }); } };
  const ok = await processJob(e, { ...job, telephonySessionId: "g2" }, 1, f);
  assert.equal(ok.status, "graded");
});

test("a recording RingCentral no longer holds (media 404) lands as no_recording with the reason — a typed absence, not a failure, never a retry", async () => {
  const { e, db, inferCalls } = env();
  const f = async (u) => { const s = String(u); if (s.endsWith("/oauth/token")) return okJson({ access_token: "tok", expires_in: 3600 }); if (s.includes("/extension/7")) return okJson({ name: "Joey Dudik" }); if (s.startsWith("https://media.test/")) return new Response("gone", { status: 404 }); return okJson({ records: [] }); };
  const job = { telephonySessionId: "old1", sessionEndIso: "2026-06-10T20:10:00Z", prefetched: { legs: [{ recordingId: "r0", contentUri: "https://media.test/r0", startTime: "2026-06-10T20:00:00Z" }], meta: { startTime: "2026-06-10T20:00:00Z", duration: 200, direction: "Inbound", extension: { id: "7", extensionNumber: "114" }, from: { phoneNumber: "+1254000" }, to: { phoneNumber: "+15550100004" } } } };
  const out = await processJob(e, job, 1, f);
  assert.equal(out.status, "no_recording"); assert.equal(db.rows.calls.get("old1").status, "no_recording");
  assert.equal(inferCalls.length, 0, "nothing reaches disp-qube for a recording that does not exist");
});

test("a duplicate replay of a graded session is acked as graded — no media fetch, no whisper, no second grade row", async () => {
  const { e, db, inferCalls } = env(); let media = 0;
  const f = async (u) => { const s = String(u); if (s.endsWith("/oauth/token")) return okJson({ access_token: "tok", expires_in: 3600 }); if (s.includes("/extension/7")) return okJson({ name: "Joey Dudik" }); if (s.startsWith("https://media.test/")) { media++; return new Response(new Uint8Array([1, 2, 3]), { status: 200 }); } return okJson({ records: [] }); };
  const job = { telephonySessionId: "dup1", sessionEndIso: "2026-07-05T20:10:00Z", prefetched: { legs: [{ recordingId: "r1", contentUri: "https://media.test/r1", startTime: "2026-07-05T20:00:00Z" }], meta: { startTime: "2026-07-05T20:00:00Z", duration: 120, direction: "Inbound", extension: { id: "7", extensionNumber: "114" }, from: { phoneNumber: "+1254000" }, to: { phoneNumber: "+15550100004" } } } };
  assert.equal((await processJob(e, job, 1, f)).status, "graded"); assert.equal(media, 1); assert.equal(db.rows.grades.length, 1);
  const again = await processJob(e, job, 1, f);
  assert.equal(again.status, "graded"); assert.equal(again.duplicate, true); assert.equal(media, 1, "no second media fetch"); assert.equal(db.rows.grades.length, 1, "no second grade row"); assert.equal(inferCalls.filter((u) => u.endsWith("/grade")).length, 1);
});

test("/feed is the instant-feedback organ: internal-only (edge host → 403 NO_SIGNAL), latest graded calls with notes and minutes-to-note through the binding host", async () => {
  const ROW = { sid: "f1", start_time: "2026-09-07T15:00:00Z", rep_name: "Jordan Lee", direction: "Inbound", duration_sec: 180, graded_at: "2026-09-07 15:06:10", total_score: 17, greeting_score: 5, discovery_score: 4, action_score: 4, empathy_score: 4, qualified: 1, intake_outcome: "Scheduled", service_type: "brakes", hostility_flag: 0, strengths: "clear", coaching_note: "confirm by text", alert: null };
  const seen = []; const DB = { prepare(q) { return { bind(...a) { seen.push(a); return this; }, async all() { return { results: /FROM grades g JOIN calls c/.test(q) ? [ROW] : [] }; } }; } };
  const e = { DB, STORE_CODE: "STOREA" };
  const edge = await worker.fetch(new Request("https://rc-qa-gate.example.workers.dev/feed?store=STOREA"), e);
  assert.equal(edge.status, 403); assert.equal((await edge.json()).membrane, "NO_SIGNAL");
  const r = await worker.fetch(new Request("https://internal/feed?store=STOREA&hours=24"), e);
  assert.equal(r.status, 200); const j = await r.json();
  assert.equal(j.n, 1); assert.equal(j.calls[0].rep_name, "Jordan Lee"); assert.equal(j.calls[0].qualified, true); assert.equal(j.calls[0].minutes_to_note, 3, "note landed three minutes after the call ended");
  assert.deepEqual(seen[0].slice(0, 2), ["STOREA", "-24 hours"]); assert.equal(j.fabricated, false);
});

test("stats window: from/to bound the CALLS by start_time on every query (rows, answered, progress) and are echoed; a malformed window is ignored", async () => {
  const seenQ = []; const DB = { prepare(q) { seenQ.push(q); return { bind() { return this; }, async all() { return { results: [] }; } }; } };
  const e = { DB, STORE_MAP: JSON.stringify({ store_of_number: {}, extension_store: {}, shared_extensions: [] }) };
  const s = await stats(e, 365, "STOREA", { from: "2026-08-13", to: "2026-09-05" });
  assert.deepEqual(s.window, { from: "2026-08-13", to: "2026-09-05" });
  const bounded = seenQ.filter((q) => /c\.start_time >= '2026-08-13' AND c\.start_time < '2026-09-05'/.test(q));
  assert.equal(bounded.length, 3, "rows, answered and progress are all bounded by the window");
  const r = await worker.fetch(new Request("https://internal/stats?days=365&store=STOREA&from=2026-08-13&to=not-a-date"), e);
  assert.equal((await r.json()).window, null, "a malformed window is ignored, never half-applied");
  const r2 = await worker.fetch(new Request("https://internal/stats?days=365&store=STOREA&from=2026-08-13&to=2026-09-05"), e);
  assert.deepEqual((await r2.json()).window, { from: "2026-08-13", to: "2026-09-05" });
});
