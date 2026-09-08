# Wayne-SMB-OS Platform

An operating layer for a small service business, built and run on Cloudflare. Three parts ship here, each deployed and tested in production before it was generalised:

| Part | What it does | Where |
|---|---|---|
| **Call QA** | Every recorded phone call is transcribed, graded on a four-category coaching rubric plus a client's own intake rules, persisted with subscores for trending, and surfaced as an instant-feedback feed. RingCentral in, Workers AI in the middle, D1 at rest. | `smb/call-qa/` |
| **Console** | The operator's face: same-origin doors to the platform's workers, a login gate, the APEX plane (dial, chronometer, switchboard), and the Call QA feed. | `console/` |
| **Identity** | RFC 7644 SCIM PATCH as a pure function, the first piece of the enterprise tier. | `smb/identity/` |
| **APEX contract** | The three instruments of the plane as Rust types with a JavaScript twin, so the console and the workers agree on what "armed" means. | `apex/` |

Design rules that hold everywhere: the model observes, code decides; every figure carries its base; absence is reported as `NO_SIGNAL`, never estimated; nothing sends outward until the plane is armed by a human.

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
