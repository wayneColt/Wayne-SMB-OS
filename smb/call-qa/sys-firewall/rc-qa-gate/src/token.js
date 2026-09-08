/** token.js — JWT-grant broker with KV cache. A stored access token expires in ~1 h and the pipeline goes dark silently; this never stores one longer than expires_in − 300 s. fabricated:false */
import { RetryableError } from "./calllog.js";
export const AUTH_PER_MINUTE = 3;   // the token endpoint is its own limit group; the comm tile mints ~2/min on the same app
/** the cached token, or a fresh mint. `fresh=true` drops the cache first — the caller saw a 401 on a token that was minted moments ago; RingCentral evicts tokens when another client on the same app keeps minting. */
export async function rcToken(env, fetchImpl = fetch, fresh = false) {
  if (fresh) await env.SEEN.delete("rc:access_token");
  const cached = fresh ? null : await env.SEEN.get("rc:access_token");
  if (cached) return cached;
  if (!env.RC_CLIENT_ID || !env.RC_CLIENT_SECRET || !env.RC_JWT) throw new Error("rc auth: credentials not set (RC_CLIENT_ID / RC_CLIENT_SECRET / RC_JWT)");
  const bk = `rl:auth:${Math.floor(Date.now() / 60000)}`;
  const n = Number((await env.SEEN.get(bk)) || 0);
  if (n >= AUTH_PER_MINUTE) throw new RetryableError(`auth budget spent this minute (${n}/${AUTH_PER_MINUTE})`, 60 + Math.floor(Math.random() * 60));
  await env.SEEN.put(bk, String(n + 1), { expirationTtl: 120 });
  const basic = btoa(`${env.RC_CLIENT_ID}:${env.RC_CLIENT_SECRET}`);
  const res = await fetchImpl(`${env.RC_SERVER || "https://platform.ringcentral.com"}/restapi/oauth/token`, {
    method: "POST", headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: env.RC_JWT }),
  });
  if (res.status === 429) throw new RetryableError("rc auth throttled", 120 + Math.floor(Math.random() * 120));
  if (!res.ok) throw new Error(`rc auth ${res.status}`);
  const j = await res.json();
  if (!j || !j.access_token) throw new Error("rc auth: no access_token in response");
  // RingCentral invalidated a 35-minute-old token on 2026-09-06 while a fresh one lived through the tile's churn: keep no token longer than 15 min
  await env.SEEN.put("rc:access_token", j.access_token, { expirationTtl: Math.max(60, Math.min(900, Number(j.expires_in || 3600) - 300)) });
  return j.access_token;
}
