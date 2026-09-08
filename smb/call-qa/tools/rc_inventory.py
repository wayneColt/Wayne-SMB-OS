#!/usr/bin/env python3
"""rc_inventory.py — pull RingCentral's DETAILED call log for a window into the two files rc_reconcile.py reads.

  python3 rc_inventory.py --from 2026-06-08 --to 2026-08-13 --out /path/base \
      --store-map store_map.json --roster rc_extensions.jsonl [--pages-per-min 4]

Writes  <base>.jsonl              one summary line, then {"sid","legs":[{recordingId,contentUri,startTime}],"meta":{...}}
        <base>.attribution.jsonl  {"sid","extension_id","extension_number","rep_name","store_code","shared"}

Budget: the company call log is RingCentral's HEAVY group (10/min per app+user) and the comm tile spends ~4/min of it,
so this paces itself at --pages-per-min (default 4) and honours Retry-After on a 429. A fresh JWT token is minted for
the run and lives only in this process. Nothing here downloads media. Recordings are only NAMED (contentUri); the gate
fetches them through its own bucket, and a recording RingCentral no longer holds lands as no_recording there.
fabricated:false · 2026-09-07
"""
import argparse, base64, json, os, sys, time, urllib.parse, urllib.request, urllib.error

CREDS = os.environ.get("RC_CREDENTIALS", "/mnt/wayne/production/flywheel/config/rc_credentials.json")
UA = "wia-rc-inventory/1.0"

def jwt_of(c):
    """The credentials file keeps the JWT either as a string or under a named key ({"wia": "..."}); resolve both."""
    j = c.get("jwt")
    if isinstance(j, dict): j = j.get(os.environ.get("RC_JWT_KEY", "wia")) or next(iter(j.values()), None)
    if not isinstance(j, str) or j.count(".") != 2: sys.exit("NO_SIGNAL: no JWT credential found in the credentials file")
    return j

def token(c):
    body = urllib.parse.urlencode({"grant_type": "urn:ietf:params:oauth:grant-type:jwt-bearer", "assertion": jwt_of(c)}).encode()
    basic = base64.b64encode(f"{c['clientId']}:{c['clientSecret']}".encode()).decode()
    req = urllib.request.Request(c["server"].rstrip("/") + "/restapi/oauth/token", data=body, method="POST",
                                 headers={"Authorization": "Basic " + basic, "Content-Type": "application/x-www-form-urlencoded", "User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as f:
        return json.load(f)["access_token"]

def get(url, tok):
    req = urllib.request.Request(url, headers={"Authorization": "Bearer " + tok, "User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=60) as f:
            return f.status, json.load(f), f.headers
    except urllib.error.HTTPError as e:
        return e.code, {}, e.headers

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from", dest="date_from", required=True); ap.add_argument("--to", dest="date_to", required=True)
    ap.add_argument("--out", required=True); ap.add_argument("--store-map", required=True); ap.add_argument("--roster", required=True)
    ap.add_argument("--pages-per-min", type=float, default=4.0); ap.add_argument("--per-page", type=int, default=250)
    a = ap.parse_args()
    smap = json.load(open(a.store_map)); ext_store = smap.get("extension_store", {}); shared = smap.get("shared_extensions", {}); num_store = smap.get("store_of_number", {})
    roster = {}
    for line in open(a.roster):
        try: r = json.loads(line)
        except ValueError: continue
        if isinstance(r, dict) and r.get("id"): roster[str(r["id"])] = r
    c = json.load(open(CREDS)); tok = token(c); server = c["server"].rstrip("/")
    pause = 60.0 / max(a.pages_per_min, 0.5)
    q = {"view": "Detailed", "withRecording": "true", "dateFrom": a.date_from + "T00:00:00.000Z", "dateTo": a.date_to + "T00:00:00.000Z", "perPage": str(a.per_page)}
    sessions, page, pages, waits = {}, 1, 0, 0
    while True:
        url = f"{server}/restapi/v1.0/account/~/call-log?" + urllib.parse.urlencode(dict(q, page=page))
        st, j, h = get(url, tok)
        if st == 429:
            ra = int((h.get("Retry-After") or "60") or 60); waits += 1
            print(f"  429 on page {page} — waiting {ra}s (heavy group)", flush=True); time.sleep(ra + 2); continue
        if st == 401:
            tok = token(c); print("  token re-minted", flush=True); continue
        if st != 200:
            print(f"NO_SIGNAL: call-log page {page} HTTP {st}", flush=True); break
        pages += 1
        recs = j.get("records") or []
        for r in recs:
            sid = r.get("telephonySessionId")
            if not sid: continue
            s = sessions.setdefault(sid, {"sid": sid, "legs": [], "meta": None, "_legs_raw": []})
            legs = r.get("legs") or []
            for leg in legs + [r]:
                rec = leg.get("recording")
                if rec and rec.get("contentUri") and not any(x["recordingId"] == str(rec.get("id")) for x in s["legs"]):
                    s["legs"].append({"recordingId": str(rec.get("id")), "contentUri": rec["contentUri"], "startTime": leg.get("startTime") or r.get("startTime")})
            s["_legs_raw"] += legs
            m = s["meta"]
            if m is None or (r.get("duration") or 0) > (m.get("duration") or 0):
                s["meta"] = {"startTime": r.get("startTime"), "duration": r.get("duration"), "direction": r.get("direction"),
                             "extension": r.get("extension"), "from": {"phoneNumber": (r.get("from") or {}).get("phoneNumber")}, "to": {"phoneNumber": (r.get("to") or {}).get("phoneNumber")}}
        nxt = (j.get("navigation") or {}).get("nextPage")
        print(f"  page {page}: {len(recs)} records · sessions so far {len(sessions)}", flush=True)
        if not nxt or not recs: break
        page += 1; time.sleep(pause)
    # attribution: the agent leg, by extension; shared lines are named, not people
    out_inv, out_attr, out_legs = open(a.out + ".jsonl", "w"), open(a.out + ".attribution.jsonl", "w"), open(a.out + ".legs.jsonl", "w")
    ge30 = 0; starts = []
    for sid, s in sessions.items():
        m = s["meta"] or {}
        agent = None; sh = False
        CONNECTED = ("Call connected", "Accepted", "Answered", "Voicemail")   # a missed ring on a colleague's phone must not take the credit
        def ext_ids(leg):
            for side in (leg.get("to"), leg.get("from"), leg.get("extension")):
                eid = str((side or {}).get("extensionId") or (side or {}).get("id") or "")
                if eid: yield eid
        for want_connected in (True, False):
            for leg in s["_legs_raw"]:
                if want_connected and str(leg.get("result") or "") not in CONNECTED: continue
                for eid in ext_ids(leg):
                    if eid in ext_store and eid not in shared: agent = eid; break
                if agent: break
            if agent: break
        if not agent:
            for leg in s["_legs_raw"] + [m]:
                for side in (leg.get("to"), leg.get("from"), leg.get("extension")):
                    eid = str((side or {}).get("extensionId") or (side or {}).get("id") or "")
                    if eid and eid in shared: agent = eid; sh = True; break
                if agent: break
        store = ext_store.get(agent or "", None)
        if not store:
            n = (m.get("to") or {}).get("phoneNumber") if m.get("direction") == "Inbound" else (m.get("from") or {}).get("phoneNumber")
            store = num_store.get(n or "", "UNKNOWN")
        ro = roster.get(agent or "", {})
        out_attr.write(json.dumps({"sid": sid, "extension_id": agent, "extension_number": ro.get("ext"), "rep_name": (shared.get(agent) if sh else ro.get("name")) or None, "store_code": store, "shared": sh}) + "\n")
        out_inv.write(json.dumps({"sid": sid, "legs": s["legs"], "meta": m}) + "\n")
        # the audit trail for the attribution: every leg's type, result, direction and extension ids — so a credit can be re-checked without a re-pull
        out_legs.write(json.dumps({"sid": sid, "agent": agent, "shared": sh, "legs": [{"legType": l.get("legType"), "result": l.get("result"), "direction": l.get("direction"), "ext": list(ext_ids(l))} for l in s["_legs_raw"]]}) + "\n")
        if int(m.get("duration") or 0) >= 30: ge30 += 1
        if m.get("startTime"): starts.append(m["startTime"])
    out_inv.close(); out_attr.close(); out_legs.close()
    summary = {"records": sum(1 for _ in sessions), "pages": pages, "throttled_waits": waits, "sessions": len(sessions), "ge_30s": ge30, "first": min(starts) if starts else None, "last": max(starts) if starts else None, "window": [a.date_from, a.date_to], "fabricated": False}
    # the summary goes FIRST (rc_reconcile keeps only lines that start with {"sid")
    body = open(a.out + ".jsonl").read(); open(a.out + ".jsonl", "w").write(json.dumps(summary) + "\n" + body)
    print("SUMMARY", json.dumps(summary), flush=True)
    return 0

if __name__ == "__main__":
    sys.exit(main())
