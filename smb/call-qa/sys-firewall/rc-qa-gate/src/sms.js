/** sms.js — RingCentral SMS from an SMS-enabled DID on the authenticating extension. Returns the result; the caller records it. fabricated:false */
/** the SMS-enabled DID on the authenticating extension, discovered once and cached a day when RC_SMS_FROM is not set */
export async function resolveSmsFrom(env, token, fetchImpl = fetch) {
  if (env.RC_SMS_FROM) return env.RC_SMS_FROM;
  const c = await env.SEEN.get("rc:sms_from"); if (c) return c;
  const res = await fetchImpl(`${env.RC_SERVER || "https://platform.ringcentral.com"}/restapi/v1.0/account/~/extension/~/phone-number`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const j = await res.json(); const n = (j.records || []).find((x) => Array.isArray(x.features) && x.features.includes("SmsSender") && x.phoneNumber);
  if (!n) return null; await env.SEEN.put("rc:sms_from", n.phoneNumber, { expirationTtl: 86400 }); return n.phoneNumber;
}
export async function sendSms(env, token, to, text, fetchImpl = fetch) {
  const from = await resolveSmsFrom(env, token, fetchImpl);
  if (!from) return { ok: false, status: 0, error: "no SMS-enabled number on the authenticating extension (set RC_SMS_FROM)" };
  const res = await fetchImpl(`${env.RC_SERVER || "https://platform.ringcentral.com"}/restapi/v1.0/account/~/extension/~/sms`, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: { phoneNumber: from }, to: [{ phoneNumber: to }], text: String(text).slice(0, 900) }),
  });
  let j = null; try { j = await res.json(); } catch (_) {}
  return { ok: res.ok, status: res.status, id: j && j.id ? String(j.id) : null, error: res.ok ? null : ((j && j.message) || `sms ${res.status}`) };
}
