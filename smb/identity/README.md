# identity
Enterprise identity for the platform, built outward from the smallest verifiable piece.
- `scim_patch.js` — RFC 7644 PatchOp applied to a resource as a pure function (replace/add/remove; sub-attributes; `[attr eq "v"]` filters; members add/remove; path-less merge). `deprovisions(patch)` names the one event that must revoke sessions immediately.
- Roadmap (see `docs/ROADMAP.md`): organizations → OIDC login (Google/Microsoft) → SCIM `/Users` `/Groups` endpoints on this parser → SAML 2.0 SP. SAML/SCIM are the enterprise tier; the small-business buyer needs organizations, self-serve onboarding and billing first.
`fabricated:false`
