/** calllog.js — session → recorded legs. Verified 2026-09-05 on the Store A account: the company call log accepts telephonySessionId as a filter, so this is a direct lookup, not a 30-minute window scan. Legs sort by startTime; media lags hangup, so an empty result is the normal case the retry ladder handles. fabricated:false */
export class RetryableError extends Error { constructor(m, delaySeconds = 120) { super(m); this.retryable = true; this.delaySeconds = delaySeconds; } }
export const CALLLOG_PER_MINUTE = 5;      // RingCentral heavy group: 10/min per app+user, measured 2026-09-06 on BOTH the call log AND media.ringcentral.com; the comm tile spends ~4/min of it, so this Worker takes 5 for call-log + media together
export const THROTTLE_BACKOFF_S = 420;    // a 429 means the whole minute is spent; come back well after it, with jitter so retries do not re-form a herd
const jitter = (s) => s + Math.floor(Math.random() * s * 0.5);
/** shared token bucket: one KV counter per UTC minute; over the budget → retry later WITHOUT touching RingCentral */
export async function takeCallLogSlot(env) {
  const k = `rl:calllog:${Math.floor(Date.now() / 60000)}`;
  const n = Number((await env.SEEN.get(k)) || 0);
  if (n >= CALLLOG_PER_MINUTE) throw new RetryableError(`call-log budget spent this minute (${n}/${CALLLOG_PER_MINUTE})`, jitter(90));
  await env.SEEN.put(k, String(n + 1), { expirationTtl: 120 });
}
const server = (env) => env.RC_SERVER || "https://platform.ringcentral.com";

export function legsOf(records, sid) {
  const mine = records.filter((r) => r && r.telephonySessionId === sid);
  const seen = new Set(); const legs = [];
  for (const r of mine) {
    const cands = [r, ...(Array.isArray(r.legs) ? r.legs : [])];
    for (const c of cands) { const rec = c && c.recording; if (rec && rec.id && rec.contentUri && !seen.has(rec.id)) { seen.add(rec.id); legs.push({ recordingId: String(rec.id), contentUri: rec.contentUri, startTime: c.startTime || r.startTime }); } }
  }
  legs.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime));
  const meta = mine[0] ? { ...mine[0], extension: mine.map(extOf).find(Boolean) || null } : null;
  return { legs, meta };
}

/** the extension that handled the call: on the record, else on a leg, else the internal party of to/from (queue-routed inbound calls carry it there) */
export function extOf(r) {
  if (!r) return null;
  const has = (e) => e && (e.id || e.extensionNumber);
  if (has(r.extension)) return r.extension;
  for (const l of (Array.isArray(r.legs) ? r.legs : [])) if (has(l.extension)) return l.extension;
  for (const side of [r.to, r.from]) if (side && (side.extensionId || side.extensionNumber)) return { id: side.extensionId, extensionNumber: side.extensionNumber, name: side.name };
  return null;
}

export async function resolveSession(env, token, sid, endIso, fetchImpl = fetch) {
  await takeCallLogSlot(env);
  const dateFrom = new Date(Date.parse(endIso) - 6 * 3600_000).toISOString();   // a long call starts well before its end
  const u = `${server(env)}/restapi/v1.0/account/~/call-log?telephonySessionId=${encodeURIComponent(sid)}&view=Detailed&recordingType=All&perPage=100&dateFrom=${encodeURIComponent(dateFrom)}`;
  const res = await fetchImpl(u, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 429) throw new RetryableError("call-log throttled", jitter(THROTTLE_BACKOFF_S));
  if (res.status === 401) { await env.SEEN.delete("rc:access_token"); throw new RetryableError("call-log 401: token dropped, retry", 60); }
  if (!res.ok) throw new Error(`call-log ${res.status}`);
  const j = await res.json();
  return legsOf(Array.isArray(j.records) ? j.records : [], sid);
}

export class TokenDied extends Error { constructor(m) { super(m); this.tokenDied = true; } }
export async function fetchMedia(env, token, contentUri, fetchImpl = fetch) {
  await takeCallLogSlot(env);   // media is the same heavy group as the call log
  const res = await fetchImpl(contentUri, { headers: { Authorization: `Bearer ${token}` } });   // header, never ?access_token= (it leaks into logs)
  if (res.status === 429) throw new RetryableError(`media throttled (${res.headers.get("X-Rate-Limit-Group") || "?"})`, jitter(THROTTLE_BACKOFF_S));
  if (res.status === 401) { await env.SEEN.delete("rc:access_token"); throw new TokenDied("media 401: the token died; re-mint"); }
  if (!res.ok) throw new Error(`media ${res.status}`);
  return res.arrayBuffer();
}

/** rep attribution from the call-log extension record; cached a day in KV */
export async function extensionName(env, token, extId, fetchImpl = fetch) {
  if (!extId) return null;
  const k = `ext:${extId}`; const c = await env.SEEN.get(k); if (c) return c;
  try {
    const res = await fetchImpl(`${server(env)}/restapi/v1.0/account/~/extension/${encodeURIComponent(extId)}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null; const j = await res.json(); const name = j && j.name ? String(j.name) : null;
    if (name) await env.SEEN.put(k, name, { expirationTtl: 86400 }); return name;
  } catch (_) { return null; }
}
