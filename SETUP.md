# Setup

1. **Cloudflare account** with Workers, KV, D1, Queues and Workers AI.
2. **Call QA**, inward-out:
   - `disp-qube/rc-qa-infer`: `wrangler deploy` (Workers AI binding only).
   - `sys-firewall/rc-qa-gate`: create a D1 database and apply `schema/001_init.sql`, `002_client_kpi.sql`, `003_grades_unique.sql`; create a KV namespace; create queues `rc-qa-jobs` and `rc-qa-dlq`; fill the `<placeholders>` in `wrangler.jsonc`; put secrets `RC_CLIENT_ID`, `RC_CLIENT_SECRET`, `RC_JWT`, `RC_VALIDATION_TOKEN`, `ADMIN_TOKEN`, and later `SHOP_MANAGER_PHONE`; set `STORE_CODE` and measure your `STORE_MAP`; `wrangler deploy`.
   - `sys-net/rc-qa-ingress`: bind the KV namespace and the queue, set the same `RC_VALIDATION_TOKEN`, attach a custom domain, `wrangler deploy`.
   - Subscribe: `POST /admin/ensure-subscription` on the gate with `X-Admin-Token`. The gate records the subscription id in KV; the ingress verifies each delivery against it, because RingCentral sends no token on deliveries (measured).
3. **Console**: create the auth KV namespace, mint the operator record, fill the service bindings with your own worker names, `wrangler deploy`.
4. **Rubrics**: `smb/call-qa/rubric/wayne-smb-v1.json` is the domain-wide coaching rubric. `rubric/client-rubric.example.json` shows the shape of a client's intake rules; replace it with your client's wording and set `RUBRIC_VERSION` in `rc-qa-infer/src/index.js`.
5. **Arming**: alerts stay `drafted` until the APEX plane arms `ringcentral`, `write_ops` and `prod` with the dial at ASSISTED or above.
