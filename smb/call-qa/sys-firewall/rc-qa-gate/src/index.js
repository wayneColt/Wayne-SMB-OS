/**
 * rc-qa-gate — sys-firewall. The queue consumer that owns everything the model must not:
 * credentials, the call log, the retry ladder, redaction, D1, the alert POLICY and SMS.
 * disp-qube (rc-qa-infer) is reached only by service binding and returns observations.
 *
 * Retry ladder: an empty recording set is the NORMAL case right after hangup (media lags),
 * so the message is retried with a 120 s delay up to MAX_RECORDING_ATTEMPTS, then the call is
 * closed as no_recording. RingCentral keeps nothing under 30 s, so short calls end here honestly.
 *
 * SMS is a dual-gated write: SMS_LIVE="1" OR the apex switchboard arms ringcentral + write_ops +
 * prod with the dial at ASSISTED or above. Otherwise the alert is DRAFTED into D1, never sent.
 * fabricated:false
 */
import { rcToken } from "./token.js";
import { resolveSession, fetchMedia, extensionName, RetryableError, TokenDied } from "./calllog.js";
import { validateObservations, totalScore, evaluateGate, suppressed, alertText, callOutcome, staffOf, isScheduled, isLost, LOST_WHYS, parseStoreMap, storeOf, isSharedLine } from "./policy.js";
import { redact } from "./redact.js";
import { sendSms } from "./sms.js";
import { ensureSubscription } from "./subscription.js";
import { dial as apexDial, switchboard as apexSwitchboard, allows, mayWrite } from "../../../../../console/src/apex.js";

export const MAX_RECORDING_ATTEMPTS = 5;     // ×120 s ≈ 10 min after the 90 s head start
export const MAX_GRADE_ATTEMPTS = 6;         // the transcript is stored and stable: a rejection that survives six grades is the model's answer, not weather
export const RETRY_DELAY_S = 120;
const json = (b, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const now = () => new Date().toISOString();

/** SMS dual gate: a var for the operator's direct flip, or the three-instrument plane. Fails closed on any doubt. */
export async function smsArmed(env, fetchImpl = fetch) {
  if (env.SMS_LIVE === "1") return { armed: true, by: "SMS_LIVE" };
  if (!env.APEX_STATE_URL) return { armed: false, by: "no apex" };
  try {
    const r = await fetchImpl(env.APEX_STATE_URL, { headers: { "user-agent": "rc-qa-gate/1.0" } });
    if (!r.ok) return { armed: false, by: `apex ${r.status}` };
    const st = ((await r.json()) || {}).state || {};
    const d = apexDial(Number((st.dial && st.dial.position) || 0));
    const sb = apexSwitchboard(st.switchboard || {});
    if (!allows(sb, "ringcentral")) return { armed: false, by: "apex: ringcentral circuit dark" };
    const stop = mayWrite(d, sb, "prod");
    return stop ? { armed: false, by: `apex: ${stop.stop}` } : { armed: true, by: `apex dial ${d.position} ${d.detent}` };
  } catch (e) { return { armed: false, by: `apex NO_SIGNAL ${String((e && e.message) || e).slice(0, 80)}` }; }
}

async function sentLastHour(env) {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM alerts WHERE status='sent' AND sent_at > datetime('now','-60 minutes')").first();
  return Number((r && r.n) || 0);
}

/** One job, start to finish. Throws RetryableError to ask the queue for another pass. */
export async function processJob(env, job, attempts, fetchImpl = fetch) {
  const sid = String(job.telephonySessionId || "");
  if (!sid) return { sid, status: "failed", reason: "no telephonySessionId" };
  const token = await rcToken(env, fetchImpl);
  // a bulk replay carries the legs it already knows (from one call-log page per 250 sessions), so the ladder spends no Heavy-group call per job
  const pre = job.prefetched && Array.isArray(job.prefetched.legs) && job.prefetched.meta ? job.prefetched : null;
  const { legs, meta } = pre ? { legs: pre.legs.filter((l) => l && l.contentUri).map((l) => ({ recordingId: String(l.recordingId || l.id || ""), contentUri: l.contentUri, startTime: l.startTime || pre.meta.startTime })), meta: pre.meta } : await resolveSession(env, token, sid, job.sessionEndIso || now(), fetchImpl);
  if (!meta) {
    if (attempts < MAX_RECORDING_ATTEMPTS) throw new RetryableError(`session ${sid} not in the call log yet (attempt ${attempts})`);
    await env.DB.prepare("INSERT OR REPLACE INTO calls (telephony_session_id, store_code, start_time, duration_sec, status, attempts, last_error, updated_at) VALUES (?, ?, ?, 0, 'no_recording', ?, 'not in call log', ?)").bind(sid, env.STORE_CODE || "STOREA", job.sessionEndIso || now(), attempts, now()).run();
    return { sid, status: "no_recording", reason: "not in call log" };
  }
  let ext = meta.extension || {};
  let rep = (await extensionName(env, token, ext.id, fetchImpl)) || (ext.name ? String(ext.name) : null);
  const smap = parseStoreMap(env.STORE_MAP);
  // attribution written by the inventory (Detailed view: the agent leg) for sessions whose replay meta came from the Simple view, which names no agent on inbound calls
  const attr = await env.SEEN.get(`attr:${sid}`, "json").catch(() => null);
  if (attr && attr.extension_id && (!ext.id || isSharedLine(smap, ext.id) || !meta.extension)) { ext = { id: attr.extension_id, extensionNumber: attr.extension_number, name: attr.rep_name }; rep = attr.rep_name || rep; }
  const call = { telephony_session_id: sid, store_code: "UNKNOWN", extension_id: ext.id ? String(ext.id) : null, extension_number: ext.extensionNumber ? String(ext.extensionNumber) : null, rep_name: rep,
    direction: meta.direction || null, from_number: meta.from && meta.from.phoneNumber || null, to_number: meta.to && meta.to.phoneNumber || null, start_time: meta.startTime || job.sessionEndIso || now(), meta_start: meta.startTime || null, duration_sec: Number(meta.duration || 0), leg_count: Math.max(1, legs.length) };
  call.store_code = storeOf(smap, call);   // measured from the shop-side number, never defaulted to a store
  if (call.store_code === "UNKNOWN" && attr && attr.store_code) call.store_code = attr.store_code;
  const upsert = (status, extra = {}) => env.DB.prepare(`INSERT INTO calls (telephony_session_id, store_code, extension_id, extension_number, rep_name, direction, from_number, to_number, start_time, duration_sec, leg_count, recording_ids, transcript, status, attempts, last_error, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(telephony_session_id) DO UPDATE SET direction=COALESCE(excluded.direction, calls.direction), from_number=COALESCE(excluded.from_number, calls.from_number), to_number=COALESCE(excluded.to_number, calls.to_number), start_time=COALESCE(?18, calls.start_time), rep_name=excluded.rep_name, store_code=excluded.store_code, extension_id=excluded.extension_id, extension_number=excluded.extension_number, duration_sec=excluded.duration_sec, leg_count=excluded.leg_count, recording_ids=excluded.recording_ids, transcript=COALESCE(excluded.transcript, calls.transcript), status=excluded.status, attempts=excluded.attempts, last_error=excluded.last_error, updated_at=excluded.updated_at`)
    .bind(call.telephony_session_id, call.store_code, call.extension_id, call.extension_number, call.rep_name, call.direction, call.from_number, call.to_number, call.start_time, call.duration_sec, call.leg_count, JSON.stringify(legs.map((l) => l.recordingId)), extra.transcript || null, status, attempts, extra.error || null, now(), call.meta_start).run();
  // store_code and rep_name are re-derived on every pass (the map can improve after a row was written)

  if (!legs.length) {
    if (attempts < MAX_RECORDING_ATTEMPTS) { await upsert("queued"); throw new RetryableError(`no recording yet for ${sid} (attempt ${attempts}, duration ${call.duration_sec}s)`); }
    await upsert("no_recording", { error: call.duration_sec < 30 ? "under 30 s — RingCentral retains nothing that short" : "no recording after the ladder" });
    return { sid, status: "no_recording", duration_sec: call.duration_sec };
  }
  // idempotency: a session already graded (a duplicate replay, a wave boundary) is acked as graded — never re-fetched, never graded twice
  const already = await env.DB.prepare("SELECT status FROM calls WHERE telephony_session_id = ?").bind(sid).first().catch(() => null);
  if (already && already.status === "graded") return { sid, status: "graded", duplicate: true };
  // a retry after a failed grade must not re-download and re-transcribe: the transcript is already in the row
  // (each re-run cost a heavy-group media slot and a whisper pass — seven stuck rows once ate most of the 5/min budget)
  const prior = await env.DB.prepare("SELECT status, transcript FROM calls WHERE telephony_session_id = ?").bind(sid).first().catch(() => null);
  const reuse = !!(prior && prior.status === "transcribed" && prior.transcript);
  // transcribe every leg in startTime order; disp-qube gets bytes, never a credential
  const texts = []; let tok = token;
  for (const leg of (reuse ? [] : legs)) {
    let audio;
    try { audio = await fetchMedia(env, tok, leg.contentUri, fetchImpl); }
    catch (e) {
      // a recording RingCentral no longer holds (retention, ~90 days) is a typed absence, not a failure and never a retry
      if (e && /^media (404|410)$/.test(String(e.message || ""))) { await upsert("no_recording", { error: `recording no longer retained (${e.message})` }); return { sid, status: "no_recording", reason: "recording no longer retained" }; }
      if (!(e && e.tokenDied)) throw e;
      tok = await rcToken(env, fetchImpl, true);   // the token died under us (another client on the same app kept minting); once, fresh
      try { audio = await fetchMedia(env, tok, leg.contentUri, fetchImpl); }
      catch (e2) { if (e2 && e2.tokenDied) throw new RetryableError("media 401 twice on fresh tokens — pausing", 300); throw e2; }
    }
    const r = await env.INFER.fetch("https://internal/transcribe", { method: "POST", headers: { "content-type": "audio/mpeg", "content-length": String(audio.byteLength) }, body: audio });
    const j = await r.json().catch(() => ({}));
    if (r.status !== 200) throw new RetryableError(`transcribe ${r.status}: ${j.reason || "?"}`);
    texts.push(String(j.text || ""));
  }
  const transcript = reuse ? prior.transcript : redact(texts.join("\n"));
  await upsert("transcribed", { transcript });
  const gr = await env.INFER.fetch("https://internal/grade", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcript }) });
  const gj = await gr.json().catch(() => ({}));
  if (gr.status !== 200) {
    if (attempts >= MAX_GRADE_ATTEMPTS) { const error = `grade ${gr.status}: ${gj.reason || "?"} — after ${attempts} attempts`; await upsert("failed", { transcript, error }); return { sid, status: "failed", reason: error }; }
    throw new RetryableError(`grade ${gr.status}: ${gj.reason || "?"}`);
  }
  const g = gj.observations;
  const bad = validateObservations(g);
  if (bad.length) {
    // a schema miss on a stable transcript is a terminal finding, recorded with its reason — never an endless retry
    if (attempts >= MAX_GRADE_ATTEMPTS) { const error = `observations rejected: ${bad.join("; ")} — after ${attempts} attempts`; await upsert("failed", { transcript, error }); return { sid, status: "failed", reason: error }; }
    throw new RetryableError(`observations rejected: ${bad.join("; ")}`);
  }
  const total = totalScore(g);
  const outcome = callOutcome(g);
  await env.DB.prepare("INSERT OR REPLACE INTO grades (telephony_session_id, greeting_score, discovery_score, action_score, empathy_score, total_score, call_outcome, qualified, intake_outcome, service_type, hostility_flag, strengths, coaching_note, model, rubric_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(sid, g.greeting_score, g.discovery_score, g.action_score, g.empathy_score, total, outcome, g.qualified ? 1 : 0, g.intake_outcome, String(g.service_type || "unknown").slice(0, 80), g.hostility_flag ? 1 : 0, g.strengths || null, g.coaching_note, gj.model || "?", gj.rubric_version || "?").run();
  const trigger = evaluateGate(g, call);
  let alert = null;
  if (trigger) {
    const text = alertText(call, g, trigger);
    const cap = suppressed(await sentLastHour(env));
    const arm = cap ? { armed: false, by: "anti-fatigue cap" } : await smsArmed(env, fetchImpl);
    let status = cap ? "suppressed" : "drafted", error = null;
    if (arm.armed && env.SHOP_MANAGER_PHONE) { const s = await sendSms(env, token, env.SHOP_MANAGER_PHONE, text, fetchImpl); status = s.ok ? "sent" : "failed"; error = s.error; }
    await env.DB.prepare("INSERT INTO alerts (telephony_session_id, trigger_code, reason, channel, to_number, text, status) VALUES (?, ?, ?, 'rc_sms', ?, ?, ?)").bind(sid, trigger.code, `${trigger.reason}${error ? ` · ${error}` : ""} · gate:${arm.by}`, env.SHOP_MANAGER_PHONE || null, text, status).run();
    alert = { code: trigger.code, status, by: arm.by };
  }
  await upsert("graded", { transcript });
  return { sid, status: "graded", total, outcome, intake_outcome: g.intake_outcome, qualified: !!g.qualified, alert, legs: legs.length, rep };
}

/** the client's three sections, computed in code from the grades table. Revenue is NO_SIGNAL: the Value column is not in the transcript stream. */
export async function stats(env, days = 90, store = null, window = null) {
  // window = { from, to } (ISO dates) bounds the CALLS by start_time — a presentation window that does not move as backfills land
  const smap = parseStoreMap(env.STORE_MAP);
  const clean = (v) => String(v).replace(/[^0-9TZ:.-]/g, "");
  const win = window && window.from && window.to ? ` AND c.start_time >= '${clean(window.from)}' AND c.start_time < '${clean(window.to)}'` : "";
  const all = ((await env.DB.prepare(`SELECT c.rep_name, c.extension_id, c.extension_number, c.store_code, c.direction, c.duration_sec, c.start_time, g.greeting_score, g.discovery_score, g.action_score, g.empathy_score, g.total_score, g.qualified, g.intake_outcome, g.service_type, g.hostility_flag
      FROM grades g JOIN calls c ON c.telephony_session_id = g.telephony_session_id WHERE g.graded_at > datetime('now', ?)${win} ORDER BY c.start_time`).bind(`-${days} days`).all()).results) || [];
  const rows = store ? all.filter((r) => r.store_code === store) : all;
  const excluded = {}; for (const r of all) if (store && r.store_code !== store) excluded[r.store_code || "UNKNOWN"] = (excluded[r.store_code || "UNKNOWN"] || 0) + 1;
  // progress is per store when a store is asked for: Store A's act must read FINAL when Store A is done, not when Store B is
  const prog = ((await (store ? env.DB.prepare(`SELECT status, COUNT(*) AS n FROM calls c WHERE store_code = ?${win} GROUP BY status`).bind(store) : env.DB.prepare(`SELECT status, COUNT(*) AS n FROM calls c WHERE 1=1${win} GROUP BY status`)).all()).results) || [];
  const progress = Object.fromEntries(prog.map((p) => [p.status, p.n]));
  const legacy = rows.filter((r) => !r.intake_outcome).length;
  const scoredAll = rows.filter((r) => r.intake_outcome);
  // the client's sections count INBOUND calls answered. An outbound follow-up graded 'Scheduled' is not a closed lead; it is coaching material.
  const scored = scoredAll.filter((r) => r.direction === "Inbound");
  const byDir = {}; for (const r of scoredAll) if (r.direction !== "Inbound") byDir[r.direction || "unknown"] = (byDir[r.direction || "unknown"] || 0) + 1;
  const answeredRows = ((await env.DB.prepare(`SELECT store_code, direction, COUNT(*) AS n FROM calls c WHERE start_time > datetime('now', ?)${win} GROUP BY store_code, direction`).bind(`-${days} days`).all()).results) || [];
  const answered = answeredRows.filter((r) => r.direction === "Inbound" && (!store || r.store_code === store)).reduce((s, r) => s + Number(r.n || 0), 0);
  const g = (r) => ({ qualified: r.qualified === 1, intake_outcome: r.intake_outcome });
  const qualified = scored.filter((r) => r.qualified === 1);
  const scheduled = qualified.filter((r) => isScheduled(g(r)));
  const lost = qualified.filter((r) => isLost(g(r)));
  const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
  const byStaff = new Map(); const via = {};
  for (const r of qualified) {
    const shared = isSharedLine(smap, r.extension_id);
    const k = staffOf(r.rep_name, shared); if (k === "Unassigned") via[r.rep_name || "(blank)"] = (via[r.rep_name || "(blank)"] || 0) + 1;
    const row = byStaff.get(k) || { staff: k, qualified_leads_handled: 0, scheduled_jobs: 0, lost: 0, close_rate: null, lost_revenue: "NO_SIGNAL", scheduled_services: {}, lost_services: {}, why: {} };
    row.qualified_leads_handled++;
    if (isScheduled(g(r))) { row.scheduled_jobs++; row.scheduled_services[r.service_type || "unknown"] = (row.scheduled_services[r.service_type || "unknown"] || 0) + 1; }
    else if (isLost(g(r))) { row.lost++; row.lost_services[r.service_type || "unknown"] = (row.lost_services[r.service_type || "unknown"] || 0) + 1; if (LOST_WHYS.includes(r.intake_outcome)) row.why[r.intake_outcome] = (row.why[r.intake_outcome] || 0) + 1; }
    byStaff.set(k, row);
  }
  const staff = [...byStaff.values()].map((r) => ({ ...r, close_rate: pct(r.scheduled_jobs, r.qualified_leads_handled) })).sort((a, b) => b.lost - a.lost || b.qualified_leads_handled - a.qualified_leads_handled);
  const avg = (k) => scored.length ? Math.round((scored.reduce((s, r) => s + Number(r[k] || 0), 0) / scored.length) * 100) / 100 : null;
  const weeks = new Map();
  for (const r of scored) { const w = String(r.start_time || "").slice(0, 10); const d = new Date(w + "T00:00:00Z"); if (isNaN(d)) continue; d.setUTCDate(d.getUTCDate() - d.getUTCDay()); const key = d.toISOString().slice(0, 10); const x = weeks.get(key) || { week: key, n: 0, greeting: 0, discovery: 0, action: 0, empathy: 0, scheduled: 0, qualified: 0 }; x.n++; x.greeting += r.greeting_score; x.discovery += r.discovery_score; x.action += r.action_score; x.empathy += r.empathy_score; if (r.qualified === 1) { x.qualified++; if (r.intake_outcome === "Scheduled") x.scheduled++; } weeks.set(key, x); }
  const weekly = [...weeks.values()].map((x) => ({ week: x.week, n: x.n, greeting: Math.round((x.greeting / x.n) * 100) / 100, discovery: Math.round((x.discovery / x.n) * 100) / 100, action: Math.round((x.action / x.n) * 100) / 100, empathy: Math.round((x.empathy / x.n) * 100) / 100, qualified: x.qualified, scheduled: x.scheduled, close_rate: pct(x.scheduled, x.qualified) }));
  const whys = {}; for (const r of lost) whys[r.intake_outcome] = (whys[r.intake_outcome] || 0) + 1;
  return {
    store: store || "ALL", window_days: days, window: window && window.from && window.to ? { from: window.from, to: window.to } : null, generated_at: new Date().toISOString(), rubric: "client-rubric-example+wayne-smb-v1",
    excluded_by_store: excluded, unassigned_via: via, progress,
    excluded_by_direction: byDir, kpi_base: "inbound calls only",
    opportunity_summary: { total_inbound_calls_answered: answered, calls_graded: scored.length, outbound_calls_graded: byDir.Outbound || 0, direction_unknown: byDir.unknown || 0, qualified_leads: qualified.length, scheduled_on_the_call: scheduled.length, close_rate_pct: pct(scheduled.length, qualified.length), lost_or_price_shopped: lost.length, lost_pct_of_qualified: pct(lost.length, qualified.length), lost_why: whys, estimated_revenue_captured: "NO_SIGNAL", estimated_revenue_walking_out: "NO_SIGNAL", revenue_reason: "the Value column is not in the transcript stream; supply a Scorpion export or a TekMetric repair-order join — never estimated" },
    staff_intake_coaching: staff,
    coaching_rubric: { avg: { greeting: avg("greeting_score"), discovery: avg("discovery_score"), action: avg("action_score"), empathy: avg("empathy_score"), total: avg("total_score") }, weekly, hostile_calls: scored.filter((r) => r.hostility_flag === 1).length },
    legacy_rows_without_intake_outcome: legacy, attribution: "generated on Wayne OS Store A", fabricated: false,
  };
}

export default {
  async queue(batch, env) {
    for (const msg of batch.messages) {
      try {
        const out = await processJob(env, msg.body || {}, msg.attempts || 1);
        console.log("rc-qa-gate", JSON.stringify(out)); msg.ack();
      } catch (e) {
        const m = String((e && e.message) || e);
        if (e && e.retryable) { const d = Number(e.delaySeconds) || RETRY_DELAY_S; console.warn("rc-qa-gate retry:", m, `in ${d}s`); msg.retry({ delaySeconds: d }); }
        else { console.error("rc-qa-gate failed:", m); try { await env.DB.prepare("INSERT INTO calls (telephony_session_id, start_time, duration_sec, status, attempts, last_error) VALUES (?, ?, 0, 'failed', ?, ?) ON CONFLICT(telephony_session_id) DO UPDATE SET status='failed', last_error=excluded.last_error, attempts=excluded.attempts, updated_at=datetime('now')").bind(String((msg.body || {}).telephonySessionId || "?"), now(), msg.attempts || 1, m.slice(0, 300)).run(); } catch (_) {} msg.ack(); }
      }
    }
  },
  async scheduled(_ev, env) {
    try { let r = await ensureSubscription(env, await rcToken(env)); if (r && r.action === "list_failed" && r.status === 401) r = await ensureSubscription(env, await rcToken(env, fetch, true)); console.log("rc-qa-gate cron subscription", JSON.stringify(r)); }
    catch (e) { console.error("rc-qa-gate cron:", String((e && e.message) || e)); await env.SEEN.put("sub:state", JSON.stringify({ ok: false, action: "cron_error", reason: String((e && e.message) || e).slice(0, 200), at: now() })); }
  },
  async fetch(request, env) {
    const url = new URL(request.url); const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/health" && request.method === "GET") {
      const q = async (sql) => { try { return (await env.DB.prepare(sql).all()).results; } catch (e) { return { NO_SIGNAL: String(e.message || e).slice(0, 120) }; } };
      const calls = await q("SELECT status, COUNT(*) AS n FROM calls GROUP BY status");
      const grades = await q("SELECT COUNT(*) AS n, ROUND(AVG(total_score),2) AS avg_total, MAX(graded_at) AS last FROM grades");
      const alerts = await q("SELECT status, COUNT(*) AS n FROM alerts WHERE sent_at > datetime('now','-24 hours') GROUP BY status");
      const sub = JSON.parse((await env.SEEN.get("sub:state")) || "null");
      const arm = await smsArmed(env);
      return json({ service: "rc-qa-gate", layer: "sys-firewall", routed: false, store: env.STORE_CODE, subscription: sub, sms: arm, calls, grades, alerts_24h: alerts, ladder: { head_start_s: 90, retry_delay_s: RETRY_DELAY_S, max_recording_attempts: MAX_RECORDING_ATTEMPTS }, fabricated: false });
    }
    if (path === "/feed" && request.method === "GET") {
      // INSTANT FEEDBACK: the latest graded calls with their coaching notes. Notes name staff and paraphrase customers,
      // so this answers only through a service binding (the console's RCQA door, behind the operator's login) —
      // a request that arrived at the edge carries the worker's hostname, never "internal".
      if (url.hostname !== "internal") return json({ membrane: "NO_SIGNAL", reason: "feed is internal: read it through the console" }, 403);
      const store = (url.searchParams.get("store") || env.STORE_CODE || "STOREA").toUpperCase().replace(/[^A-Z0-9]/g, "");
      const hours = Math.min(168, Math.max(1, Number(url.searchParams.get("hours") || 24)));
      const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") || 40)));
      const rows = ((await env.DB.prepare(`SELECT c.telephony_session_id AS sid, c.start_time, c.rep_name, c.direction, c.duration_sec, g.graded_at, g.total_score, g.greeting_score, g.discovery_score, g.action_score, g.empathy_score,
          g.qualified, g.intake_outcome, g.service_type, g.hostility_flag, g.strengths, g.coaching_note,
          (SELECT a.trigger_code || ':' || a.status FROM alerts a WHERE a.telephony_session_id = c.telephony_session_id ORDER BY a.id DESC LIMIT 1) AS alert
        FROM grades g JOIN calls c ON c.telephony_session_id = g.telephony_session_id
        WHERE c.store_code = ? AND g.graded_at > datetime('now', ?) ORDER BY g.graded_at DESC LIMIT ?`).bind(store, `-${hours} hours`, limit).all()).results) || [];
      return json({ store, hours, n: rows.length, calls: rows.map((r) => ({ ...r, qualified: r.qualified === 1, hostility_flag: r.hostility_flag === 1, minutes_to_note: r.graded_at && r.start_time ? Math.round((new Date(r.graded_at + "Z") - new Date(r.start_time) - Number(r.duration_sec || 0) * 1000) / 60000) : null })),
        loop: "call ends → recording ready (~90 s) → transcribed → graded against the client's prompt → note here; SMS when the plane arms it", fabricated: false });
    }
    if (path === "/stats" && request.method === "GET") {
      const days = Math.min(365, Math.max(1, Number(url.searchParams.get("days") || 90)));
      const store = (url.searchParams.get("store") || "").toUpperCase().replace(/[^A-Z0-9]/g, "") || null;
      const iso = (v) => (v && /^\d{4}-\d{2}-\d{2}(T[0-9:.]+Z)?$/.test(v)) ? v : null;   // a presentation window: calls by start_time, e.g. from=2026-08-13&to=2026-09-05
      const from = iso(url.searchParams.get("from")), to = iso(url.searchParams.get("to"));
      const st = await stats(env, days, store, from && to ? { from, to } : null);
      return new Response(JSON.stringify(st, null, 2), { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } });
    }
    if (path.startsWith("/admin/")) {
      if (!env.ADMIN_TOKEN || request.headers.get("X-Admin-Token") !== env.ADMIN_TOKEN) return json({ membrane: "NO_SIGNAL", reason: "admin token" }, 401);
      if (path === "/admin/ensure-subscription" && request.method === "POST") { let r = await ensureSubscription(env, await rcToken(env)); if (r && r.action === "list_failed" && r.status === 401) r = await ensureSubscription(env, await rcToken(env, fetch, true)); return json(r); }
      const m = path.match(/^\/admin\/replay\/([A-Za-z0-9._-]+)$/);
      if (m && request.method === "POST") {
        // a bulk replay is staggered by the caller: the company call log is a Heavy-group endpoint (~10/min), so ?delay=<s> spreads the ladder instead of bursting into 429s
        const delay = Math.min(86400, Math.max(0, Math.floor(Number(url.searchParams.get("delay") || 0)) || 0));
        let body = null; try { const t = await request.text(); body = t ? JSON.parse(t) : null; } catch (_) { return json({ membrane: "NO_SIGNAL", reason: "body is not JSON" }, 400); }
        const prefetched = body && body.prefetched && Array.isArray(body.prefetched.legs) && body.prefetched.meta ? { legs: body.prefetched.legs.slice(0, 20), meta: body.prefetched.meta } : undefined;
        await env.QA_QUEUE.send({ telephonySessionId: m[1], sessionEndIso: url.searchParams.get("end") || now(), replay: true, ...(prefetched ? { prefetched } : {}) }, { delaySeconds: delay });
        return json({ queued: m[1], delay_s: delay, prefetched: !!prefetched, fabricated: false });
      }
      return json({ membrane: "NO_SIGNAL", reason: `no admin route ${request.method} ${path}` }, 404);
    }
    return json({ membrane: "NO_SIGNAL", reason: `no route ${request.method} ${path}` }, 404);
  },
};
