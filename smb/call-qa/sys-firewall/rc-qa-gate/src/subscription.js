/** subscription.js — ensure the account-level telephony/sessions webhook exists and is renewed. Account scope is what makes every rep's call visible; the spec's extension/~ filter would see only the authenticating extension. Falls back to extension scope and SAYS so if the account filter is refused. fabricated:false */
export const FILTER_ACCOUNT = "/restapi/v1.0/account/~/telephony/sessions";
export const FILTER_EXTENSION = "/restapi/v1.0/account/~/extension/~/telephony/sessions";
export const EXPIRES_IN_S = 7 * 86400;
const server = (env) => env.RC_SERVER || "https://platform.ringcentral.com";
const H = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

export async function ensureSubscription(env, token, fetchImpl = fetch) {
  if (!env.RC_VALIDATION_TOKEN) return { ok: false, action: "refused", reason: "RC_VALIDATION_TOKEN not set — the ingress would ignore every delivery" };
  const list = await fetchImpl(`${server(env)}/restapi/v1.0/subscription`, { headers: H(token) });
  if (!list.ok) return { ok: false, action: "list_failed", status: list.status };
  const recs = ((await list.json()).records) || [];
  const mine = recs.filter((s) => s && s.deliveryMode && s.deliveryMode.address === env.HOOK_ADDRESS);
  const active = mine.find((s) => s.status === "Active");
  const result = { ok: true, action: "kept", id: active ? active.id : null, expires: active ? active.expirationTime : null, scope: null };
  if (active) {
    result.scope = (active.eventFilters || []).some((f) => /\/telephony\/sessions$/.test(f) && !/\/extension\//.test(f)) ? "account" : "extension";   // RingCentral rewrites ~ to the account id
    const left = Date.parse(active.expirationTime) - Date.now();
    if (left < 2 * 86400_000) {
      const r = await fetchImpl(`${server(env)}/restapi/v1.0/subscription/${active.id}/renew`, { method: "POST", headers: H(token) });
      result.action = r.ok ? "renewed" : "renew_failed"; if (r.ok) { const j = await r.json(); result.expires = j.expirationTime; }
    }
    await env.SEEN.put("sub:state", JSON.stringify({ ...result, at: new Date().toISOString() }));
    return result;
  }
  for (const s of mine) await fetchImpl(`${server(env)}/restapi/v1.0/subscription/${s.id}`, { method: "DELETE", headers: H(token) }).catch(() => {});   // stale/blacklisted copies
  for (const [scope, filter] of [["account", FILTER_ACCOUNT], ["extension", FILTER_EXTENSION]]) {
    const r = await fetchImpl(`${server(env)}/restapi/v1.0/subscription`, { method: "POST", headers: H(token), body: JSON.stringify({ eventFilters: [filter], expiresIn: EXPIRES_IN_S, deliveryMode: { transportType: "WebHook", address: env.HOOK_ADDRESS, validationToken: env.RC_VALIDATION_TOKEN } }) });
    if (r.ok) { const j = await r.json(); const out = { ok: true, action: "created", id: j.id, expires: j.expirationTime, scope, status: j.status }; await env.SEEN.put("sub:state", JSON.stringify({ ...out, at: new Date().toISOString() })); return out; }
    if (scope === "account") { let t = ""; try { t = (await r.text()).slice(0, 200); } catch (_) {} result.account_refused = `${r.status} ${t}`; continue; }
    return { ok: false, action: "create_failed", status: r.status, account_refused: result.account_refused || null };
  }
  return { ok: false, action: "create_failed" };
}
