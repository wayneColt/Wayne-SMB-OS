/**
 * rc-qa-ingress — sys-net. Verify → echo/ack → dedupe → enqueue → 200. Everything else is the
 * queue consumer's job (rc-qa-gate). Always 200 to RingCentral once the handshake is past:
 * a 4xx/5xx counts against subscription health and gets it deactivated.
 *
 * Two RingCentral facts shape the handler: the creation handshake arrives with a
 * Validation-Token header and no event body, and must be echoed. MEASURED 2026-09-08: real
 * deliveries (User-Agent RingCentral-WebHook) carry NO Validation-Token at all, whatever the
 * docs say about deliveryMode.validationToken — 1,100 deliveries were rejected on that
 * assumption and the live path never queued a call. A delivery is therefore verified by its
 * subscriptionId against the subscription the gate records in the shared KV (sub:state); a
 * delivery that does carry a token must still match the secret. The echo branch fires only
 * when there is no event in the body — an echo-first handler would swallow every event.
 * fabricated:false
 */
export const EVENT_FILTER_ACCOUNT = "/restapi/v1.0/account/~/telephony/sessions";
export const DELAY_S = 90;          // head start on recording availability (media lags hangup)
export const SEEN_TTL_S = 86400;    // Disconnected fires per party; one job per session per day
const json = (b, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const bump = (env, k) => env.SEEN.get(`stat:${k}`).then((v) => env.SEEN.put(`stat:${k}`, String(Number(v || 0) + 1))).catch(() => {});

export function isDisconnected(evt) {
  const parties = (evt && evt.body && Array.isArray(evt.body.parties)) ? evt.body.parties : [];
  return parties.some((p) => p && p.status && p.status.code === "Disconnected");
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/health" && request.method === "GET") {
      const stats = {}; for (const k of ["received", "handshake", "bad_token", "sub_verified", "ignored", "dup", "queued"]) stats[k] = Number((await env.SEEN.get(`stat:${k}`)) || 0);
      let last_reject = null; try { last_reject = JSON.parse((await env.SEEN.get("stat:last_reject")) || "null"); } catch (_) {}
      return json({ service: "rc-qa-ingress", layer: "sys-net", routed: true, armed: !!env.RC_VALIDATION_TOKEN, event_filter: EVENT_FILTER_ACCOUNT, delay_s: DELAY_S, stats, last_reject, fabricated: false });
    }
    if (path !== "/hook") return json({ membrane: "NO_SIGNAL", reason: `no route ${request.method} ${path}` }, 404);

    const vt = request.headers.get("Validation-Token");
    // RingCentral echoes the developer token on DELIVERIES as Verification-Token (deliveryMode.verificationToken); Validation-Token is the creation handshake. Accept either on a delivery.
    const dt = request.headers.get("Verification-Token") || vt;
    const text = request.method === "POST" ? await request.text() : "";
    let evt = null; try { evt = text ? JSON.parse(text) : null; } catch (_) { evt = null; }
    const isEvent = !!(evt && evt.body && typeof evt.body.telephonySessionId === "string");

    // 1. Subscription-creation handshake: a Validation-Token and an EMPTY body. Echo it, nothing else. (A token with any body is a delivery, verified below.)
    if (vt && !text.trim()) { ctx && ctx.waitUntil ? ctx.waitUntil(bump(env, "handshake")) : await bump(env, "handshake"); return new Response(null, { status: 200, headers: { "Validation-Token": vt } }); }
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
    await bump(env, "received");

    // 2. Verify the developer-specified token on every delivery. Fail closed, but never 4xx to RingCentral.
    // 2a. RingCentral sends no token on deliveries: verify the notification's subscriptionId against the gate's record.
    let subOk = false;
    if (!dt && isEvent && evt.subscriptionId) {
      try { const st = JSON.parse((await env.SEEN.get("sub:state")) || "null"); subOk = !!(st && st.id && st.id === evt.subscriptionId && /\/telephony\/sessions$/.test(String(evt.event || ""))); } catch (_) { subOk = false; }
      if (subOk) await bump(env, "sub_verified");
    }
    if (!subOk && (!env.RC_VALIDATION_TOKEN || dt !== env.RC_VALIDATION_TOKEN)) {
      // diagnostic, no secret content: which header RingCentral sent, its length, and whether it matched
      const diag = { at: new Date().toISOString(), has_validation: !!vt, has_verification: !!request.headers.get("Verification-Token"), header_len: (dt || "").length, secret_len: (env.RC_VALIDATION_TOKEN || "").length, equal: dt === env.RC_VALIDATION_TOKEN, event: isEvent, sid: isEvent ? String(evt.body.telephonySessionId).slice(0, 12) : null, ua: (request.headers.get("User-Agent") || "").slice(0, 40) };
      await bump(env, "bad_token"); await env.SEEN.put("stat:last_reject", JSON.stringify(diag)).catch(() => {});
      console.warn("rc-qa-ingress: delivery without a matching Validation-Token — ignored", JSON.stringify(diag));
      return new Response("ignored", { status: 200 });
    }
    if (!isEvent || !isDisconnected(evt)) { await bump(env, "ignored"); return new Response("ignored", { status: 200 }); }

    // 3. Idempotency: Disconnected fires per party.
    const sid = evt.body.telephonySessionId;
    const key = `seen:${sid}`;
    if (await env.SEEN.get(key)) { await bump(env, "dup"); return new Response("dup", { status: 200 }); }
    await env.SEEN.put(key, "1", { expirationTtl: SEEN_TTL_S });

    // 4. Defer: the recording is not addressable at hangup.
    await env.QA_QUEUE.send({ telephonySessionId: sid, sessionEndIso: new Date().toISOString(), eventTime: evt.timestamp || null }, { delaySeconds: DELAY_S });
    await bump(env, "queued");
    return new Response("queued", { status: 200 });
  },
};
