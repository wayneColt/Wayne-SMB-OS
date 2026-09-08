# APEX · Operator Card — the three instruments
`fabricated:false` · 2026-09-05 · one page · the runtime contract is `apex/contract` (Rust) with its JS twin `console/src/apex.js`; both are held to `apex/contract/detents.tsv`.

## The law of three
| Instrument | Question | Persists as | Missing it |
|---|---|---|---|
| **Pin Chronometer** | *When* does the Oracle wake, and for how long? | pins on the rim (96 × 15 min) + a gear train (epoch) | agents never run, or never sleep |
| **Silver Precision Dial** | *How far* may a worker go this epoch? | one detent position 0–100 | blast radius negotiated in prose |
| **Toggle Switchboard** | *Which circuits* exist this epoch? | a toggle per circuit; lamps are readouts | a "read-only" agent still holds write credentials |

The Oracle is the **reader** of the three, never a fourth. It inspects, then dispatches. Every mutation takes a `Wetware` token in the contract and a **root session** on the Face. There is no method by which a worker or the Oracle raises a detent, pulls a pin, or closes a toggle. Workers may **trip a lamp** (state); the hand **resets** it (policy).

## Detents — the cliffs, with the math
`confidence(d) = 0.99 − 0.0039·d` · `budget(d) = 0.05·d^1.8` · `write(d) = d ≥ 50` · `prod_write(d) = detent ≥ ASSISTED`

| Detent | d | conf cutoff | budget | writes | posture |
|---|---|---|---|---|---|
| MONITOR | 0–25 | 0.99–0.89 | $0–$16 | no | read MCP, diff, report |
| SHADOW | 26–50 | 0.89–0.80 | $18–$57 | mock only* | real network, mock commits |
| ASSISTED | 51–75 | 0.79–0.70 | $59–$119 | yes, gated | IPC writes under threshold |
| AUTONOMOUS | 76–99 | 0.69–0.60 | $121–$195 | yes | multi-day, key rotate, heal hooks |
| UNCHECKED | 100 | 0.60 | $199 | yes | kernel / sandbox is the only wall |

*The 50 cliff, named: at exactly 50 the write bit is on and the detent is still SHADOW, so writes reach only mock state trees and staging. A prod commit attempted in SHADOW is a trip-claw, not a retry. No soft bumps: an "almost" clearance is no clearance. Per-department **derate** is allowed; per-department **raise** is not representable.

## Dual-gate writes — AND, never synonyms
- `write_ops` OFF + dial 90 → **dark circuit**, escalate.
- `write_ops` ON + dial 40 → **dial cliff**, escalate.
- both ON and ≥ 50 → guarded write is legal **inside the current epoch and budget** (mock targets at 50, prod from 51 with `prod` ON).
Merging them loses "arm a circuit for a future epoch without granting it now" — the difference between unplugging the pump and setting the OFF tripper for 22:00.

## Chronometer — two motions, one ring
1. **Strobe pins (out)** — discrete wake events, each with an **inscription** (the goal the Oracle plans under; it does not invent one).
2. **Epoch (gear train)** — how long that wake may live. Pin-out without an epoch is an unbounded agent; an epoch without pins is cron with no policy surface.

**Trip-claw (first-class):** a worker still waiting past its epoch → freeze state → persist to the bucket → **lamp RED** → do **not** move the dial or pull other pins → next strobe reads the red lamp as health, not as a goal.
**Pin-in is not off.** It is cold persistence, circuits may stay armed for the next strobe. **Air-gap** = gears disengaged **and** all toggles OFF **and** dial 0.

## What the Oracle may do at a strobe — order is load-bearing
1 read chronometer (which pin, epoch left) · 2 read dial (confidence, budget, write bit) · 3 read switchboard mask + lamps (tripped ≠ off) · 4 aggregate IPC facts (Accounting · Production · Sales · HR) · 5 plan under the three · 6 dispatch; **escalate any step that fails a gate; never widen one.**
Three hard stops, in order: **dark circuit → dial cliff → budget cliff → epoch claw.** There is no stop called "the model felt unsure"; that is already on the dial.

## The armed states that matter
| Pins | Dial | Toggles | State |
|---|---|---|---|
| out, off-epoch | 65 | git + cdn ON | **ARMED SLEEP** — policy live, zero token burn until a pin trips (the money state) |
| one strobe | 51–75 | write ON | **GUARDED EPOCH** — the default long-horizon sweep |
| strobing | 10–25 | git + cdn ON, prod OFF | **SENTINEL** — telemetry only |
| gears off | 0 | all OFF | **AIR-GAP** — cold storage, not sleep |
| one strobe | 85–95 | prod ON | **HOTFIX** — legal only because a hand set both radius and circuit |
| any | 100 | any ON | **UNCHECKED** — log the detent change as an operator act |

## Where it lives
- Face: `https://<your-console-host>` → **APEX** section (root session). Reads `GET /v1/apex`; writes `PUT /v1/apex/{dial,chronometer,switchboard}`.
- Mirror: `wayne-main-state /state/apex:wosp` — what `rc-qa-gate` (SMS dual gate: `ringcentral` + `write_ops` + `prod`, dial ≥ 51) and metal read. Lamps: `/state/apex:lamps`, written by workers, cleared by a reset.
- Contract: `apex/contract` (`cargo test`, 7) · twin `console/src/apex.js` (`node --test`, 6) · both against `detents.tsv`.
- Visibility rules: pins, dial, toggles are the only writable controls; lamps are readouts; the strip's "target" is the current pin's inscription, never a free prompt box; a red lamp beside a green toggle is legal and is never auto-flipped.

Why this kills drift: time, radius and circuit live **outside** the token stream. Workers can still be wrong inside the box. They cannot move the box.
