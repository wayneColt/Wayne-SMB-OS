# Instant feedback — the loop, as built · 2026-09-07 · fabricated:false

**The claim on the presentation:** "Store A adjusts immediately on the tool's feedback: a coaching note lands minutes after a call ends."
**What makes it true:**

| Step | Organ | Latency (measured) |
|---|---|---|
| call ends | RingCentral webhook → `rc-qa-ingress` (rc-qa.example.com) | seconds |
| recording ready | queue delay 90 s, then `rc-qa-gate` fetches media through the heavy-group bucket | ~90–120 s |
| transcribed → graded | `rc-qa-infer` (Workers AI whisper + llama-3.3-70b) against the client's prompt, verbatim; rules applied in code | ~30–60 s |
| the note lands | `grades.coaching_note` + `strengths`; `alerts` drafted by the gate's triggers (ESCALATION · LOW_SCORE < 12 · LOST_LEAD > 3 min) | total **~3 min** after the call ends (`minutes_to_note` on the feed) |
| the manager reads it | console **SMBOS · Instant feedback** (`/v1/smbos/feed`, behind the operator's login; the gate's `/feed` answers only through the binding) | on refresh |
| the manager is pushed | SMS to `SHOP_MANAGER_PHONE` — **armed only by the plane** (`ringcentral` + `write_ops` + `prod` ON, dial ≥ 51) or `SMS_LIVE=1` | when armed |
| the week is read | `/stats` — the client's three sections, inbound only, one grade per session | public, cached 5 min |

**Membrane:** notes name staff and paraphrase customers, so the feed never leaves the login. Revenue stays NO_SIGNAL. Every grade is the client's language; Wayne's four-category rubric rides beside it for coaching.
**Not yet:** a rep-facing view (each rep sees only their own calls) — a second door on the same feed, gated per user, when Store A wants it.
