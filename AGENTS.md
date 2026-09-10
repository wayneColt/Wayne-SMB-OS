# AGENTS.md — operating this platform as an agent

You may bring the platform up, test it, and read its instruments. You may not send anything outward (SMS, email, posts) — that is a human arming decision on the APEX plane, by design.

Order of operations:
1. Read `SETUP.md`. Every `<placeholder>` in a `wrangler.jsonc` must be filled from the account you are operating; refuse to deploy with a placeholder present.
2. Run every test suite listed in `README.md` before and after any change. A red suite is a stop.
3. Deploy Call QA inward-out (infer → gate → ingress). Verify each with its `/health`.
4. Prove the live path with `rc-qa.<host>/health`: `stats.queued` rising after a real call is the only proof; `subscription.ok` on the gate is not.
5. Read results from the gate's `/stats` (public, aggregates only) and `/feed` (internal-only). Never expose transcripts.
6. Report `NO_SIGNAL` wherever a value is absent; never estimate revenue — it comes only from a real Value column.

Guard: `tools/iceberg_check.sh` must print `0` before any push. It fails on client, store, person, domain and account identifiers that do not belong in a public tree.

The human supplies judgment; this platform supplies follow-through. Do not add documents to prove the pairing — output is what leaves, with a receipt. Falsification: 3 external bites (reply, request, meeting, offer, or hard no from a stranger) by 2026-10-10.
