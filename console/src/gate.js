/**
 * gate.js — the Face's login gate. operator@smbos (alias admin), root on the Face.
 *
 * What a session is: an HMAC-SHA-256 signed claim {u, role, iat, exp} in an HttpOnly,
 * Secure, SameSite=Strict cookie, 12 h. The signing key and the operator record live in
 * the WOSP_AUTH KV namespace, both written ONCE by the sacrificial mint worker (mint/)
 * from a password generated on the operator's glass. The password reaches this Worker only at
 * login, over TLS, and is never stored: PBKDF2-SHA-256 (100k, the Workers cap) is
 * recomputed against the minted salt and compared in constant time.
 *
 * What a session is NOT: kernel authority. The cookie opens the Face's doors; every run
 * still ends A=LAG and only the Kernel disposes. Root here means root on the Face.
 *
 * Membrane: no binding → 503 (sealed, not open); no minted operator → login refuses;
 * no cookie → 302 /login for pages, 401 for /v1 doors. fabricated:false
 */
export const KV_BINDING = "WOSP_AUTH";
export const SESSION_COOKIE = "wosp_session";
export const SESSION_TTL_S = 12 * 3600;
export const PBKDF2_ITER = 100000;               // Cloudflare Workers cap PBKDF2 at 100,000 iterations
export const OPERATOR = "operator@smbos";
export const ALIASES = Object.freeze({ admin: OPERATOR });
export const LOGIN_MAX_FAILS = 8;
export const LOGIN_WINDOW_S = 900;
export const PUBLIC_PATHS = new Set(["/health", "/login", "/login.html"]);

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64u(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = ""; for (const b of u) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function unb64u(s) {
  let t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  while (t.length % 4) t += "=";
  return Uint8Array.from(atob(t), (c) => c.charCodeAt(0));
}
/** constant-time string compare — length difference is folded in, never short-circuited */
export function ctEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let d = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) d |= (x[i] || 0) ^ (y[i] || 0);
  return d === 0;
}
export async function pbkdf2(password, salt, iterations = PBKDF2_ITER) {
  const key = await crypto.subtle.importKey("raw", enc.encode(String(password)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return b64u(bits);
}
export async function hmacB64u(keyStr, msg) {
  const k = await crypto.subtle.importKey("raw", enc.encode(String(keyStr)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64u(await crypto.subtle.sign("HMAC", k, enc.encode(msg)));
}
export async function signSession(keyStr, claims) {
  const p = b64u(enc.encode(JSON.stringify(claims)));
  return `${p}.${await hmacB64u(keyStr, p)}`;
}
export async function readSession(keyStr, token, now = Date.now()) {
  if (!keyStr || !token || typeof token !== "string") return null;
  const i = token.indexOf(".");
  if (i <= 0) return null;
  const p = token.slice(0, i), sig = token.slice(i + 1);
  if (!ctEqual(sig, await hmacB64u(keyStr, p))) return null;
  let c; try { c = JSON.parse(dec.decode(unb64u(p))); } catch (_) { return null; }
  if (!c || typeof c !== "object" || typeof c.exp !== "number" || c.exp * 1000 <= now || typeof c.u !== "string") return null;
  return c;
}
export function cookieValue(request, name = SESSION_COOKIE) {
  const h = request.headers.get("cookie") || "";
  for (const part of h.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1);
  }
  return null;
}
export const setCookie = (token, maxAge = SESSION_TTL_S) =>
  `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
export const clearCookie = () => `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export function resolveUser(name) {
  const n = String(name || "").trim().toLowerCase();
  return ALIASES[n] || n;
}
export async function gateStatus(kv) {
  if (!kv) return { gate: "absent", reason: `binding ${KV_BINDING} absent — the Face is sealed` };
  const minted = await kv.get("auth:minted", "json");
  if (!minted) return { gate: "unminted", reason: "no operator minted — open the mint on your glass (console/mint)" };
  return { gate: "armed", user: minted.user, minted_at: minted.at, minted_by: minted.by };
}
export async function session(request, kv) {
  if (!kv) return null;
  const key = await kv.get("auth:session_key");
  return readSession(key, cookieValue(request));
}
/** POST /v1/auth/login → {status, body, cookie?}. Never says which of user/password was wrong. */
export async function login(kv, body, ip = "0") {
  const now = Date.now();
  const rk = `rl:${ip}`;
  const fails = Number((await kv.get(rk)) || 0);
  if (fails >= LOGIN_MAX_FAILS) return { status: 429, body: { membrane: "NO_SIGNAL", reason: `too many refused logins from this address; wait ${LOGIN_WINDOW_S}s`, fabricated: false } };
  const bump = async () => kv.put(rk, String(fails + 1), { expirationTtl: LOGIN_WINDOW_S });
  const u = resolveUser(body && body.username);
  const rec = u ? await kv.get(`user:${u}`, "json") : null;
  const password = String((body && body.password) || "");
  // derive even when the user is unknown so timing does not name the operator
  const salt = rec && rec.salt ? unb64u(rec.salt) : new Uint8Array(32);
  const iter = rec && Number.isInteger(rec.iterations) ? rec.iterations : PBKDF2_ITER;
  const h = await pbkdf2(password, salt, iter);
  if (!rec || !rec.hash || !ctEqual(h, rec.hash)) { await bump(); return { status: 401, body: { membrane: "NO_SIGNAL", reason: "credentials refused", fabricated: false } }; }
  const key = await kv.get("auth:session_key");
  if (!key) return { status: 503, body: { membrane: "NO_SIGNAL", reason: "session key absent — the mint did not finish; mint again", fabricated: false } };
  const iat = Math.floor(now / 1000), exp = iat + SESSION_TTL_S;
  const claims = { u, role: rec.role || "root", iat, exp };
  const token = await signSession(key, claims);
  return { status: 200, body: { ok: true, user: u, role: claims.role, exp, ttl_s: SESSION_TTL_S, kernel_accept: false, fabricated: false }, cookie: setCookie(token) };
}
