/**
 * wosp-mint — the sacrificial worker. One POST /mint writes the operator record, a fresh
 * session-signing key and the minted marker into WOSP_AUTH; every later POST is 410. The
 * password never arrives here: the glass sends only {salt, hash, iterations} it derived
 * itself (PBKDF2-SHA-256, 100k). After the mint, delete this worker. fabricated:false
 */
const OPERATOR = "operator@smbos";
const ITER = 100000;
const LOGIN_URL = "https://<your-console-host>/login";
const BURN = "wrangler delete --name wosp-mint --force";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type", "cache-control": "no-store", "x-wosp-door": "wosp-mint" };
const json = (b, s = 200) => new Response(JSON.stringify(b, null, 2), { status: s, headers: { "content-type": "application/json; charset=utf-8", ...CORS } });
const hex = (u) => [...u].map((b) => b.toString(16).padStart(2, "0")).join("");
const B64U = /^[A-Za-z0-9_-]+$/;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const m = request.method.toUpperCase();
    const kv = env.WOSP_AUTH;
    if (m === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (path === "/health" && m === "GET") {
      const minted = kv ? await kv.get("auth:minted", "json") : null;
      return json({ service: "wosp-mint", sacrificial: true, bound: !!kv, minted: !!minted, minted_at: minted ? minted.at : null, user: minted ? minted.user : null, login: LOGIN_URL, burn: BURN, fabricated: false });
    }
    if (path === "/mint" && m === "POST") {
      if (!kv) return json({ membrane: "NO_SIGNAL", reason: "binding WOSP_AUTH absent" }, 503);
      if (await kv.get("auth:minted", "json")) return json({ membrane: "NO_SIGNAL", reason: "already minted — this worker is spent; burn it", burn: BURN }, 410);
      let b; try { b = await request.json(); } catch (_) { return json({ membrane: "NO_SIGNAL", reason: "body is not JSON" }, 400); }
      const bad = [];
      if (String(b.username || "").toLowerCase() !== OPERATOR) bad.push(`username must be ${OPERATOR}`);
      if (b.iterations !== ITER) bad.push(`iterations must be ${ITER}`);
      if (typeof b.salt !== "string" || !B64U.test(b.salt) || b.salt.length < 22) bad.push("salt must be base64url of >=16 bytes");
      if (typeof b.hash !== "string" || !B64U.test(b.hash) || b.hash.length !== 43) bad.push("hash must be base64url of 32 bytes");
      if (b.role !== "root") bad.push("role must be root");
      if (bad.length) return json({ membrane: "NO_SIGNAL", reason: bad.join("; ") }, 400);
      const at = new Date().toISOString();
      const key = hex(crypto.getRandomValues(new Uint8Array(32)));
      await kv.put(`user:${OPERATOR}`, JSON.stringify({ username: OPERATOR, aliases: ["admin"], role: "root", kdf: "PBKDF2-SHA-256", iterations: ITER, salt: b.salt, hash: b.hash, minted_at: at, minted_by: "wosp-mint", generated_on: b.generated_on || "glass" }));
      await kv.put("auth:session_key", key);
      await kv.put("auth:minted", JSON.stringify({ at, user: OPERATOR, by: "wosp-mint" }));
      return json({ minted: true, user: OPERATOR, aliases: ["admin"], role: "root on the Face (the Kernel still disposes)", at, login: LOGIN_URL, next: `burn this worker: ${BURN}`, fabricated: false });
    }
    if (env.ASSETS && m === "GET") return env.ASSETS.fetch(request);
    return json({ membrane: "NO_SIGNAL", reason: `no route ${m} ${path}` }, 404);
  },
};
