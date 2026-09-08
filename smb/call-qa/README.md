# SMBOS · rc-qa — Wayne-SMB-OS call QA pipeline (HO-RCQA-001, built)
`fabricated:false` · built 2026-09-05 from `the pipeline handoff` · live on Cloudflare

Completed RingCentral calls at the store are transcribed, graded against the four-category rubric, persisted with all four subscores for trending, and — when the gate trips — an alert is written and (only when armed) texted to the shop manager.

## The three workers (grep law)
| Worker | Layer | Hostname | Holds |
|---|---|---|---|
| `sys-net/rc-qa-ingress` | sys-net | **`rc-qa.example.com`** (the only one) | handshake echo · Validation-Token verify · dedupe · enqueue with a 90 s head start · 200 in ms |
| `sys-firewall/rc-qa-gate` | sys-firewall | none (workers.dev for `/health` + admin) | JWT-grant token broker + KV cache · call-log resolve by `telephonySessionId` · retry ladder · redaction · D1 · **policy** · SMS dual gate · subscription cron |
| `disp-qube/rc-qa-infer` | disp-qube | none, service binding only | Whisper turbo (base64) + Llama 3.3 70B fp8-fast (json_schema) → **observations only** |

Deploy inward-out: `rc-qa-infer` → `rc-qa-gate` → `rc-qa-ingress` (each dir: `wrangler deploy`). Tests: `node --test test/*.test.js` in each worker dir (5 + 12 + 4 + policy 5).

## Where the spec was corrected by the live APIs (beyond its own D1–D6)
1. **`X-Wayne-Hook` does not exist on the wire.** RingCentral cannot send custom headers. The shared secret is the developer-specified `deliveryMode.validationToken`, which RingCentral echoes back in the `Validation-Token` header **on every delivery**. So the handshake branch fires only on a Validation-Token with an **empty body**; an echo-first handler would have swallowed every event.
2. **Account scope, not extension scope.** The spec's filter `/account/~/extension/~/telephony/sessions` sees only the authenticating extension (101). The gate subscribes to `/restapi/v1.0/account/~/telephony/sessions` (created 2026-09-05, `scope: account`, status Active) and falls back to extension scope, saying so in `/health`, if the account filter is refused.
3. **Direct lookup.** Verified on the Store A account: the company call log accepts `telephonySessionId` as a filter (verification question 3: yes). No 30-minute window scan.
4. **Custom domain instead of a `routes` block.** The wrangler token binds Worker custom domains but cannot write zone DNS, which a route needs first. Same property: one routed worker.
5. **Rep attribution falls back** from `record.extension` to the leg's extension to the internal party of `to`/`from` (queue-routed inbound calls carry it there).

## Operator instructions (the operator's list, 2026-09-06)

1. **Rubric = the client's verbatim wording.** Done 2026-09-06: `rubric/client-rubric-example.json` carries the client's Scorpion/Gemini prompt unedited (email 2026-08-18, forwarded to ops@example.com). Its four rules are applied per call in `policy.js`; the model observes `qualified`, `intake_outcome`, `service_type`; revenue is NO_SIGNAL until a Scorpion export or a TekMetric repair-order join supplies the Value column.
   1a. **Internal rubric, domain-wide.** `rubric/wayne-smb-v1.json` is Wayne's own four-category coaching rubric for the Wayne-SMB OS Platform (any shop). Every grade carries both: `rubric_version = client-rubric-example+wayne-smb-v1`. A new client launch adds a client file beside it and keeps the internal one.
2. **Recording on 120 and 122.** Done 2026-09-06 (verified: 14 extensions auto-record; 120 inbound, 122 all directions).
   2a. **Manager number, then the phone system, then arm SMS by the plane.**
       - `cd sys-firewall/rc-qa-gate && wrangler secret put SHOP_MANAGER_PHONE` (E.164, e.g. +15550100001). Optional `RC_SMS_FROM`; otherwise the SMS-enabled DID on the authenticating extension is discovered and cached.
       - Configure the VoIP side in RingCentral admin: the manager's number must be SMS-reachable; alerts come from extension 101's direct number.
       - Arm by the plane on https://<your-console-host> → APEX: toggles `ringcentral` + `write_ops` + `prod` ON and the dial at ASSISTED (≥ 51). Until then every alert is `drafted`. (Direct flip: `SMS_LIVE=1` in `wrangler.jsonc` vars — the plane is the honest way.)
3. **Key rotation half of the runbook.** `~/google-cloud-sdk/bin/gcloud auth login` as the account that owns `kss-platform-79026`, then `bash ~/os_main_stage/os_main/final_architecture/WOSP-console-wt/tools/staged/BOBBASH_KEYSTROKE_20260905_PATCH_AND_ROTATE.sh --no-patch`.
4. **Set the instruments on the Face.** Everything is cold until a hand moves them: dial, pins, toggles at https://<your-console-host> (root session).

## Verification questions — answered on the live account (2026-09-05)
| # | Question | Answer |
|---|---|---|
| 1 | recording automatic or on-demand? | **Automatic on 12 extensions** (101, 107, 109, 110, 114, 115, 116, 117, 119, 124 all directions; queues 5 and 6 inbound), 90-day retention. **Not recorded: 120 (Casey Kim) and 122 (Store A SalesDesk).** Those two lines are blind spots in the KPI sample. |
| 2 | distinct extensions per rep? | 15 user extensions; **122 Store A SalesDesk is shared** — per-rep coaching is impossible on that line. |
| 3 | `telephonySessionId` filter? | Yes — used. |
| 4 | call-length ceiling | base64 path; `MAX_AUDIO_BYTES` 20 MiB; `@cf/deepgram/nova-3` still HOLD. |
| 5 | consent / retention | not a code question; the pipeline retains a redacted transcript (PAN stripped) in D1 `smbos_call_qa`. |
| 6 | rubric authority | **Closed 2026-09-06** — `rubric/client-rubric-example.json` is the client's wording verbatim; `wayne-smb-v1.json` is Wayne's internal rubric. |
| 7 | alert recipient | **`SHOP_MANAGER_PHONE` is not set** — every alert is DRAFTED into D1 until it is. The SMS `from` number auto-resolves to the SMS-enabled DID on extension 101. |

## SMS is dual-gated
An alert is **sent** only when `SMS_LIVE="1"` (wrangler var) **or** the apex plane arms it: `ringcentral` + `write_ops` + `prod` toggles ON and the dial at ASSISTED (≥ 51), read from `wayne-main-state /state/apex:wosp`. Otherwise it is **drafted** (`alerts.status='drafted'`). Above 4 sent alerts in an hour it is **suppressed**. Fails closed on any doubt (no apex state → drafted).

## Ops
- Health: `https://rc-qa.example.com/health` (ingress counters) · `https://rc-qa-gate.<your-account>.workers.dev/health` (subscription, sms gate, calls by status, grades, alerts 24 h) · infer has no hostname.
- Secrets (gate): `RC_CLIENT_ID RC_CLIENT_SECRET RC_JWT RC_VALIDATION_TOKEN ADMIN_TOKEN` (+ optional `RC_SMS_FROM SHOP_MANAGER_PHONE`); (ingress): `RC_VALIDATION_TOKEN` (same value). Rotate with `wrangler secret put`; the validation token must match on both.
- Subscription: cron `17 */6 * * *` renews when < 2 days remain; `POST /admin/ensure-subscription` (header `X-Admin-Token`) forces it.
- Replay any recorded session through the ladder: `POST /admin/replay/<telephonySessionId>?end=<ISO>` (header `X-Admin-Token`).
- D1: `smbos_call_qa` (<d1-database-id>), schema `schema/001_init.sql`. Queue `rc-qa-jobs`, DLQ `rc-qa-dlq`, KV `RC_QA_SEEN` (<kv-namespace-id>).
- First live smoke 2026-09-05T20:59Z: replayed a 98 s inbound call → transcript 1,161 chars → 5/4/5/5 = 19/20 · booked · no alert · 12 s end to end.

## Stats for the presentation
`GET https://rc-qa-gate.<your-account>.workers.dev/stats?days=90` — public, CORS `*`, cached 5 min. the client's three sections computed in code from the grades table: opportunity summary (calls answered, qualified, scheduled + close rate, lost + why), staff intake coaching (James's columns; Lost Revenue = NO_SIGNAL), deep-dive inputs (scheduled and lost service types per staff), plus the Wayne coaching averages and a weekly series. Staff names appear as the extension records them; blank or shared → Unassigned (rule 4).

**Inbound only (2026-09-06).** the client's three sections are computed over **inbound** calls: `total_inbound_calls_answered` is every inbound session the ladder saw for the store in the window (graded, failed, or too short to record); `calls_graded`, qualified, scheduled, lost, the staff table and the weekly trend are inbound scored rows only. Outbound calls are still transcribed and graded (coaching), reported as `outbound_calls_graded` and in `excluded_by_direction`, and never counted as a lead or a close — an outbound "we're calling to confirm" graded *Scheduled* is not a closed lead. `kpi_base: "inbound calls only"` rides every response.

**Direction/start-time repair (2026-09-06).** 140 rows written by the first replay plan carried an empty prefetched meta (no direction, start_time = the batch clock). They were backfilled from the inventory (140 `UPDATE` statements, 0 misses; the statement file carries caller numbers and stays out of the repo, in the job's tmp) and the upsert now repairs `direction`, `from/to_number` and `start_time` on conflict when a later pass knows them (`COALESCE`), so a retry can never re-open the hole.

**Who answered — the connected-leg rule (2026-09-07).** On an inbound call the shared main line *Accepts*, every agent's phone gets a *FindMe* ring, and exactly one leg reads **"Call connected"** — that extension answered. Legs reading *Stopped* or *IP Phone Offline* are colleagues who did not. The first attribution credited the first extension it saw and was wrong on 1,640 of 3,071 Aug–Sep sessions (a stopped ring, or the offline Abe Store B Office phone); it was re-credited with `tools/rc_attribution_from_detailed.py`, the ledger backfilled, and KV `attr:<sid>` overwritten. `tools/rc_inventory.py` applies the same rule at pull time and writes `<base>.legs.jsonl` as the audit trail. Preference: first connected non-shared extension → any non-shared → a shared line (named, `shared:true`) → Unassigned (rule 4).

**Backfill in waves.** `tools/rc_inventory.py --from … --to …` pulls a window at ≤ 4 detailed pages/min (the comm tile spends ~4/min of the same heavy group). Cloudflare Queues caps a message delay at 43,200 s, so at the 12 s stagger a wave is at most 3,600 sessions: `rc_reconcile.py --limit 3500 --live`, then the next wave only after the ladder has drained (open 0, quiet ≥ 20 min) — a session still delayed in the queue has no row and would be re-queued. The gate acks a duplicate replay of a graded session without re-fetching or re-grading, so a boundary overlap costs nothing. Each wave: mint a token → `wrangler secret put ADMIN_TOKEN` → live run with the token only in the process environment → rotate. Posts are concurrent (`RC_QA_WORKERS`, default 6) and carry a User-Agent — the edge 403s Python's default before any token check. A recording RingCentral no longer holds (media 404) lands as `no_recording`.

## Not done (honest)
- `SHOP_MANAGER_PHONE` unset → alerts draft only. Setting it and arming SMS are operator acts.
- Recordings on 120 and 122 are off → not a code fix; a RingCentral admin setting.
- `@cf/deepgram/nova-3` chunking for > 15-minute calls: HOLD.
