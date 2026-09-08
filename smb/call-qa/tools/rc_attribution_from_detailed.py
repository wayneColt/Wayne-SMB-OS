#!/usr/bin/env python3
"""rc_attribution_from_detailed.py — re-credit sessions from a compact DETAILED call-log file under the connected-leg rule.

  python3 rc_attribution_from_detailed.py --detailed rc_sessions_detailed.jsonl --store-map store_map.json --roster rc_extensions.jsonl --out attribution_v2.jsonl [--old attribution.jsonl]

THE RULE (measured 2026-09-07 on real legs): an inbound call is Accepted on the shared main line, then every agent's
phone gets a FindMe ring; exactly one leg reads "Call connected" — that extension answered. A leg that reads
"Stopped" or "IP Phone Offline" is a colleague's phone that did NOT answer and must never take the credit.
Order of preference: first CONNECTED leg with a non-shared extension → any non-shared extension → a shared line
(named, shared=true) → nothing (Unassigned by rule 4). fabricated:false
"""
import argparse, json
CONNECTED = ("Call connected", "Accepted", "Answered", "Voicemail")

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--detailed", required=True); ap.add_argument("--store-map", required=True); ap.add_argument("--roster", required=True); ap.add_argument("--out", required=True); ap.add_argument("--old")
    a = ap.parse_args()
    smap = json.load(open(a.store_map)); ext_store = smap["extension_store"]; shared = smap["shared_extensions"]; num_store = smap["store_of_number"]
    roster = {}
    for line in open(a.roster):
        try: r = json.loads(line)
        except ValueError: continue
        if isinstance(r, dict) and r.get("id"): roster[str(r["id"])] = r
    old = {}
    if a.old:
        for line in open(a.old):
            try: r = json.loads(line); old[r["sid"]] = r
            except Exception: pass
    out = open(a.out, "w"); n = changed = 0; by = {}
    for line in open(a.detailed):
        try: r = json.loads(line)
        except ValueError: continue
        recs = r.get("records") if isinstance(r.get("records"), list) else None
        if not recs: continue
        rec = max(recs, key=lambda x: x.get("dur") or 0); legs = rec.get("legs") or []
        def ids(l):
            for side in (l.get("to"), l.get("from"), l.get("extension")):
                e = str((side or {}).get("extensionId") or (side or {}).get("id") or "")
                if e: yield e
        agent = None; sh = False
        for want in (True, False):
            for l in legs:
                if want and str(l.get("result") or "") not in CONNECTED: continue
                for e in ids(l):
                    if e in ext_store and e not in shared: agent = e; break
                if agent: break
            if agent: break
        if not agent:
            for l in legs + [rec]:
                for e in ids(l) if l is not rec else [str((rec.get("ext") or {}).get("id") or "")]:
                    if e and e in shared: agent = e; sh = True; break
                if agent: break
        store = ext_store.get(agent or "")
        if not store:
            num = (rec.get("to") or {}).get("phoneNumber") if rec.get("dir") == "Inbound" else (rec.get("from") or {}).get("phoneNumber")
            store = num_store.get(num or "", "UNKNOWN")
        ro = roster.get(agent or "", {})
        row = {"sid": r["sid"], "extension_id": agent, "extension_number": ro.get("ext"), "rep_name": (shared.get(agent) if sh else ro.get("name")) or None, "store_code": store, "shared": sh}
        out.write(json.dumps(row) + "\n"); n += 1
        o = old.get(r["sid"])
        if o and (o.get("rep_name") != row["rep_name"]):
            changed += 1; k = f"{o.get('rep_name')} → {row['rep_name']}"; by[k] = by.get(k, 0) + 1
    out.close()
    print(json.dumps({"sessions": n, "credit_changed": changed, "top_changes": sorted(by.items(), key=lambda x: -x[1])[:12], "fabricated": False}))

if __name__ == "__main__":
    main()
