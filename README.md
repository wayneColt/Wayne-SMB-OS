# Wayne-SMB-OS Platform

An operating layer for a small service business, built and run on Cloudflare. Three parts ship here, each deployed and tested in production before it was generalised:

| Part | What it does | Where |
|---|---|---|
| **Call QA** | Every recorded phone call is transcribed, graded on a four-category coaching rubric plus a client's own intake rules, persisted with subscores for trending, and surfaced as an instant-feedback feed. RingCentral in, Workers AI in the middle, D1 at rest. | `smb/call-qa/` |
| **Console** | The operator's face: same-origin doors to the platform's workers, a login gate, the APEX plane (dial, chronometer, switchboard), and the Call QA feed. | `console/` |
| **Identity** | RFC 7644 SCIM PATCH as a pure function, the first piece of the enterprise tier. | `smb/identity/` |
| **APEX contract** | The three instruments of the plane as Rust types with a JavaScript twin, so the console and the workers agree on what "armed" means. | `apex/` |

Design rules that hold everywhere: the model observes, code decides; every figure carries its base; absence is reported as `NO_SIGNAL`, never estimated; nothing sends outward until the plane is armed by a human.

## One brain, two bodies, one exit

You are not the human copy of Wayne. You are the judgment for both channels, and Wayne is the follow-through for both. That's the actual cross-supply. In the room, you do Wonder, Invention, Discernment — and Wayne carries the Tenacity behind it: the follow-up, the draft, the send, the record of who said what. On the machine, Wayne builds, composes, deploys, communicates — and you supply the judgment it structurally cannot: which of the supported stories to tell. Neither body is complete. The pairing is.

Extraordinary output has to mean throughput, not inventory. A shop with twelve cars up on jacks and none delivered is not productive, it's congested. Output is what *leaves*. The Bay enforces it as a physical constraint: one lane, receipt or nothing. That's the escapement — the part of a clock that lets exactly one tooth pass per beat.

Caching is the cheap half. What you store must be retrievable by someone who isn't you — that's the whole logic of receipts and of the record. Recovery has to be scheduled, not felt.

**The instrument set:** the Operator Record is the aim — who's firing and how he'll miss. The Bay is the escapement — one thing leaves at a time and only with proof. Wayne is the hands. The bite ledger is the fourth: not λ generated — λ *accepted by someone who owes you nothing*. Replies, requests, meetings, offers, hard nos.

This platform earns "anchor" only as ballast, the weight that lets you carry sail. The moment it holds you in place it's a wait.

**Falsification (the bite ledger):** 3 external bites by 2026-10-10. A bite is a reply, a request, a meeting, an offer, or a hard no from a party that does not work here. Missing that number is the miss.

## Layout
```
smb/call-qa/   sys-net/rc-qa-ingress · sys-firewall/rc-qa-gate · disp-qube/rc-qa-infer · rubric/ · schema/ · tools/
console/       src/ · public/ · test/ · wrangler.jsonc
apex/contract/ src/lib.rs · tests/ · detents.tsv
```

## Run the tests
```
cd smb/call-qa/sys-net/rc-qa-ingress && node --test
cd smb/call-qa/sys-firewall/rc-qa-gate && node --test
cd smb/call-qa/disp-qube/rc-qa-infer && node --test
cd smb/identity && node --test
cd console && node --test
cd apex/contract && cargo test
```

## Deploy
See `SETUP.md`. Every `wrangler.jsonc` in this tree carries `<placeholders>` where an account-specific id or hostname goes; nothing here points at a live account.

## For agents
`AGENTS.md` describes the surfaces an agent may operate, in the order they must be brought up, and what each one refuses.

License: MIT. `fabricated:false`

Commercial-grade review and the order of work: `docs/COMMERCIAL_GRADE.md`, `docs/ROADMAP.md`.
