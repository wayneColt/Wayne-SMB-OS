// Shared test fixture for the gate: an in-memory WOSP_AUTH namespace minted for operator@smbos,
// and a cookie signed with its session key. Top-level await is fine in ESM tests.
// fabricated:false
import { OPERATOR, PBKDF2_ITER, b64u, pbkdf2, signSession, SESSION_TTL_S, SESSION_COOKIE } from "../src/gate.js";

export const PASSWORD = "correct-horse-battery-staple-24";
export const SESSION_KEY = "k".repeat(64);
export const SALT = new Uint8Array(32).fill(7);
export const USER_REC = { username: OPERATOR, aliases: ["admin"], role: "root", kdf: "PBKDF2-SHA-256", iterations: PBKDF2_ITER, salt: b64u(SALT), hash: await pbkdf2(PASSWORD, SALT, PBKDF2_ITER), minted_at: "2026-09-05T20:00:00Z", minted_by: "test" };

/** a KV stub: get(key, "json"|undefined), put, delete; `m` exposes the map */
export function kvStub(seed = {}) {
  const m = new Map(Object.entries(seed).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]));
  return {
    m,
    async get(k, type) { const v = m.get(k); if (v === undefined || v === null) return null; return type === "json" ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, String(v)); },
    async delete(k) { m.delete(k); },
  };
}
export const minted = () => kvStub({ [`user:${OPERATOR}`]: USER_REC, "auth:session_key": SESSION_KEY, "auth:minted": { at: "2026-09-05T20:00:00Z", user: OPERATOR, by: "test" } });
export const unminted = () => kvStub({});

const iat = Math.floor(Date.now() / 1000);
export const COOKIE = `${SESSION_COOKIE}=${await signSession(SESSION_KEY, { u: OPERATOR, role: "root", iat, exp: iat + SESSION_TTL_S })}`;
export const STALE_COOKIE = `${SESSION_COOKIE}=${await signSession(SESSION_KEY, { u: OPERATOR, role: "root", iat: iat - 20 * 3600, exp: iat - 8 * 3600 })}`;
