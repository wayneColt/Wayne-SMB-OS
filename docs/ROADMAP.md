# Roadmap
v0.1.0 (now) — the tree as derived: Call QA (3 workers), Console, APEX contract, SCIM PATCH parser, iceberg guard, CI.
v0.2 — organizations + per-organization keys; every query scoped.
v0.3 — self-serve onboarding: RingCentral OAuth connect, automatic STORE_MAP.
v0.4 — billing + entitlements (Stripe), quotas read by the gate.
v0.5 — audit log, retention, export, hard delete.
v0.6 — status page, semver + deprecation policy, support tier.
v1.0 — OIDC login; SAML 2.0 + SCIM endpoints (enterprise tier) on `smb/identity/`.
Rule for every version: model observes, code decides; `NO_SIGNAL` over an estimate; nothing sends until a human arms it.
