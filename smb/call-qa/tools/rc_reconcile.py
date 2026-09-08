#!/usr/bin/env python3
"""rc_reconcile.py — the final execution, as one command.

Diffs a RingCentral inventory (one JSON per line: {"sid","legs":[...],"meta":{...}}, as
rc_sessions_pre.jsonl) against the rc-qa ledger (D1 smbos_call_qa via wrangler) and re-queues
what is missing or failed, Store A first, with prefetched legs, at the heavy-group pace.
Sessions under 30 s are skipped (RingCentral keeps nothing that short). Dry run by default.

  python3 rc_reconcile.py --inventory rc_sessions_pre.jsonl --attribution attribution.jsonl [--store STOREA] [--live]
  ADMIN_TOKEN must be in the environment for --live (rotate: wrangler secret put ADMIN_TOKEN in sys-firewall/rc-qa-gate).
Prints a receipt: inventoried · graded · no_recording · failed · missing · queued. fabricated:false
"""
import argparse, datetime, json, os, subprocess, sys, time, urllib.request

GATE = os.environ.get("RC_QA_GATE", "https://rc-qa-gate.<your-account>.workers.dev")
HERE = os.path.dirname(os.path.abspath(__file__))
GATE_DIR = os.path.join(HERE, "..", "sys-firewall", "rc-qa-gate")
STAGGER_S = int(os.environ.get("RC_QA_STAGGER_S", "12"))   # 5/min: the gate's share of RingCentral's heavy 10/min

def ledger():
    out = subprocess.run(["wrangler", "d1", "execute", "smbos_call_qa", "--remote", "--json", "--command",
                          "SELECT telephony_session_id AS sid, status FROM calls"], cwd=GATE_DIR, capture_output=True, text=True, timeout=180)
    if out.returncode != 0: sys.exit(f"NO_SIGNAL: wrangler d1 failed: {out.stderr[-300:]}")
    txt = out.stdout; j = json.loads(txt[txt.index("["):])
    return {r["sid"]: r["status"] for r in j[0]["results"]}

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--inventory", required=True); ap.add_argument("--attribution"); ap.add_argument("--store"); ap.add_argument("--live", action="store_true"); ap.add_argument("--limit", type=int, default=0, help="queue at most N (Queues caps a delay at 43,200 s = 3,600 messages at 12 s); run the next wave after this one drains"); a = ap.parse_args()
    inv = [json.loads(l) for l in open(a.inventory) if l.startswith('{"sid"')]
    attr = {json.loads(l)["sid"]: json.loads(l) for l in open(a.attribution)} if a.attribution else {}
    inv = [r for r in inv if int(r["meta"].get("duration") or 0) >= 30]
    if a.store: inv = [r for r in inv if attr.get(r["sid"], {}).get("store_code") == a.store]
    led = ledger()
    counts = {"inventoried": len(inv), "graded": 0, "no_recording": 0, "failed": 0, "in_ladder": 0, "missing": 0}
    todo = []
    for r in inv:
        st = led.get(r["sid"])
        if st == "graded": counts["graded"] += 1
        elif st == "no_recording": counts["no_recording"] += 1
        elif st in ("queued", "transcribed"): counts["in_ladder"] += 1
        elif st == "failed": counts["failed"] += 1; todo.append(r)
        else: counts["missing"] += 1; todo.append(r)
    todo.sort(key=lambda r: (attr.get(r["sid"], {}).get("store_code") != "STOREA", r["meta"]["startTime"]), reverse=False)
    counts["beyond_limit"] = max(0, len(todo) - a.limit) if a.limit else 0
    if a.limit: todo = todo[:a.limit]
    counts["to_queue"] = len(todo); counts["eta_h"] = round(len(todo) * STAGGER_S / 3600, 1)
    if len(todo) * STAGGER_S > 43200: sys.exit(f"REFUSED: {len(todo)} × {STAGGER_S}s exceeds the 43,200 s Queues delay cap — pass --limit {43200 // STAGGER_S}")
    print("RECEIPT", json.dumps(counts))
    if not a.live: print("dry run — add --live to queue", len(todo), "sessions"); return 0
    tok = os.environ.get("ADMIN_TOKEN") or sys.exit("NO_SIGNAL: ADMIN_TOKEN not in the environment")
    ok = bad = 0
    # concurrent posts: the admin route only ENQUEUES, and each message's delay is computed from its index, so send
    # order does not matter — 3,500 posts at ~0.3 s each would take ~17 min serially, which no attended shell survives here
    import concurrent.futures
    def post(i_r):
        i, r = i_r
        end = (datetime.datetime.fromisoformat(r["meta"]["startTime"].replace("Z", "+00:00")) + datetime.timedelta(seconds=int(r["meta"]["duration"]))).strftime("%Y-%m-%dT%H:%M:%SZ")
        body = json.dumps({"prefetched": {"legs": r["legs"], "meta": r["meta"]}}).encode()
        req = urllib.request.Request(f"{GATE}/admin/replay/{r['sid']}?end={end}&delay={i * STAGGER_S}", data=body, method="POST", headers={"X-Admin-Token": tok, "content-type": "application/json", "User-Agent": "wia-rc-reconcile/1.0"})   # Cloudflare 403s Python's default UA at the edge (measured 2026-09-07)
        try: urllib.request.urlopen(req, timeout=30); return (True, None)
        except Exception as e: return (False, f"{r['sid']} {str(e)[:80]}")
    with concurrent.futures.ThreadPoolExecutor(max_workers=int(os.environ.get("RC_QA_WORKERS", "6"))) as ex:
        for good, why in ex.map(post, enumerate(todo)):
            if good: ok += 1
            else:
                bad += 1
                if bad <= 5: print("  refused", why, flush=True)

    print("QUEUED", json.dumps({"ok": ok, "bad": bad}))
    return 0 if bad == 0 else 2

if __name__ == "__main__": sys.exit(main())
