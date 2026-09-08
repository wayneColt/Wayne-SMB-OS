# WOSP · console (the Face's door)

`fabricated:false` · 2026-09-04 · `-b`

The operator's Face for WayneOSPlatform: one static page, three lanes (Use · Work · Deploy), a plain-language Oracle that names the lane and the hand, a configure panel that **proposes**, and a probe panel that reports receipts or `NO_SIGNAL` — never an inherited state.

Live: `https://wosp-console.<your-account>.workers.dev/`

## Why a Worker under a static page

The Control Pane and the Container IDE send no CORS headers and have no `OPTIONS` route. Measured 2026-09-04: opened from the desk (`file://`), every probe on the console read `NO_SIGNAL` while both organs were `200` by curl. The page was honest about what it saw and wrong about what was there.

So the page is served by its own Worker, which opens exactly the doors the page calls, same-origin, through service bindings (public hostnames do not route Worker-to-Worker; bindings do — `wayne_main/wrangler.jsonc`):

| door (this origin) | binding | organ | upstream |
|---|---|---|---|
| `GET /v1/pane/health` | `CONTROL_PANE` | wayne-aios-control-pane | `/health` |
| `GET /v1/pane/sotr` | `CONTROL_PANE` | wayne-aios-control-pane | `/v1/sotr` |
| `GET\|POST /v1/pane/configure` | `CONTROL_PANE` | wayne-aios-control-pane | `/v1/configure` → `A=LAG` |
| `GET /v1/ide/health` | `DEV_IDE` | wayne-cdn-container-sandbox | `/health` |
| `GET /v1/ide/wosp/loop` | `DEV_IDE` | wayne-cdn-container-sandbox | `/v1/wosp/loop?profile=` (allowlist enforced at the door too) |

`GET /health` is the card: service, doors, live upstream receipts, `kernel_accept:false`, `fabricated:false` last. Anything else under `/v1` is `{"membrane":"NO_SIGNAL"}` 404 and never touches a binding.

The page detects its door at boot (`/health` answers as `wosp-console` → same-origin doors; otherwise direct addresses, and a browser block is reported as a browser block). The desk copy at `~/os_main_stage/WOSP_CONSOLE.html` is byte-identical to `public/index.html`.

## Guards (each can go red)

```
node --test                          # 14 door tests · three CONTROL cases plant a bad door and assert the audit catches it
python3 ../tools/console_parity.py   # html doors ⊆ src DOORS ⊆ wrangler services
python3 ../tools/console_parity.py --selftest   # 4 planted defects, guard must fail on each
```

Both ride `.github/workflows/ladder.yml` as rung A4.

## Not

- an accept path — every upstream is propose-only; no door reaches `/v1/propose`, `/v1/ceo`, `/v1/citl`, exec, or any deploy
- the apex — `apex:false`; a hostname is a separate, deliberate bind
- a second Control Pane — the pane's `/` Face is the pane's; this is the platform's operator Face
- CORS on the pane or the IDE — the door makes the question moot; those organs stay untouched
- Workers Builds — deploy is a keystroke here, `wrangler deploy` from this directory

## Rollback

`wrangler rollback --name wosp-console` (or `wrangler delete --name wosp-console`; the two upstream organs are untouched by either).

## Related

- `../wosp/loop.py` — the sting the Work lane opens
- `../GESTURE.md` — the Decisions tray the Deploy lane names
- `../SOTR_1_WAYNE_WOSP.html` — the plate; published on the WayneIQ artifact hub at `:8526/publications/serve/SOTR_1_WAYNE_WOSP.html`
- Control Pane: `https://wayne-aios-control-pane.<your-account>.workers.dev/`

## The gate (v2.7, 2026-09-05)

The Face is behind `/login`. `src/gate.js` holds the whole mechanism: PBKDF2-SHA-256 (100k, the Workers cap) recomputed at login against the minted salt, constant-time compare, an HMAC-SHA-256 session cookie (12 h, HttpOnly, Secure, SameSite=Strict), eight refused logins per address per 15 min. KV `WOSP_AUTH` carries three keys, all written once by the sacrificial `mint/` worker from a password generated on the operator's glass: `user:operator@smbos` (salt + hash, alias `admin`, role root), `auth:session_key`, `auth:minted`. `run_worker_first: true` puts the gate in front of the asset layer.

Membrane: binding absent → 503 on everything but `/health` (sealed, not open); unminted → login refuses; no cookie → 302 `/login` for pages, 401 `{login:"/login"}` for doors. `test/gate.test.js` (13) proves each refusal; `test/_auth.js` is the minted fixture the door and DwEC tests share. `smoke.mjs` has a GATE leg that needs no secret and a SESSION leg that needs `WOSP_PASSWORD` in the operator's shell. Metal reads the state organ directly (`tools/metal/dwec_bridge_drain.py`), never a gated route.
