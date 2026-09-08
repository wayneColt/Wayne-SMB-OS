# Commercial-grade review · 2026-09-08

Production-grade means the thing runs and does not lie; commercial-grade means a stranger can buy it, run it, and leave it. The platform's buyer is a small service business (a shop owner or a franchisee, a handful of stores), not enterprise IT. So the six enterprise domains are scored honestly below, and then re-ordered by what earns the first paying store.

| Domain | What the tree holds today | Gap to commercial-grade |
|---|---|---|
| Identity & access | One operator record in KV (PBKDF2), an admin token per gate; sessions with expiry | No organizations or tenants; no OIDC/SSO; no SCIM/SAML (parser landed, endpoints not); RBAC is operator-or-nothing |
| Auditability | Every call row timestamped; DwEC records carry recomputed digests; Cloudflare observability on | No per-organization audit export; no SIEM stream; metrics are system-wide |
| Data protection | TLS at the edge; D1 at rest; transcripts redacted of card-shaped digit runs; **zero npm dependencies** (small supply chain); D1 Time Travel for point-in-time restore | No tenant isolation (a single `store_code` column); no retention or hard-delete policy; no SBOM/CVE job; no third-party pen test |
| Administration | `SETUP.md`, wrangler and secrets by hand; STORE_MAP measured by hand | No self-serve onboarding, no RingCentral OAuth connect, no entitlements or quotas, no billing |
| Operational contracts | `/health` on every worker; a probe lane in the estate that ran it | No SLA, status page, support tiers, semver policy or deprecation window yet (v0.1.0 tag pending) |
| Compliance | — | No SOC 2 / ISO; no MSA / DPA; no written BC/DR (Cloudflare-managed, undocumented) |

## What earns the first paying store, in order
1. **Organizations** — an `organizations` table, `store → organization`, per-organization API keys; every read scoped by organization. This is the one change that makes a second customer possible.
2. **Self-serve onboarding** — connect RingCentral by OAuth (not a pasted JWT), pick stores, measure STORE_MAP from the call log automatically.
3. **Billing and entitlement** — Stripe Checkout + webhook → plan and quota per organization; the alert and grading budgets read the plan.
4. **Audit, retention, export** — per-organization event log, retention window, one-click export; hard delete on request.
5. **Operational contract** — semver + deprecation window in writing, a status page, a support tier (even one).
6. **SSO** — OIDC (Google Workspace / Microsoft) for the operator login; SAML 2.0 + SCIM endpoints as the enterprise tier.

Unit economics (list prices, measured volumes; revenue is an input until a store pays): Whisper large-v3-turbo $0.00051 per audio minute; Llama 3.3 70B fp8-fast $0.29 per million input tokens, $2.25 per million output. A store taking ~1,400 recorded calls a month at ~3.4 minutes costs about $2.40 to transcribe and about $1.50 to grade — roughly $4 of inference per store-month before the $5 Workers plan. The margin question is therefore not cost; it is whether a store will pay for graded calls at all. `fabricated:false`
