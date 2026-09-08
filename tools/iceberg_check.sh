#!/usr/bin/env bash
# iceberg_check.sh — the public tree carries no client, store, person, domain or account identifier.
# Prints the hit count and lists hits; exit 1 if any. Python so it behaves identically on every grep.
cd "$(dirname "$0")/.." || exit 2
python3 - <<'PY'
import re, pathlib, sys
PAT = re.compile(r"cbac|christian brothers|cbauto|slater|allnutt|lochbaum|centala|watkins|mirick|\bwoody\b|\bbbob\b|\bbob@|sterling|\btemple\b|woodway|TX096|TX062|templelocation|wayneia|catalytic-|bw-11b|0154c7c4|bac766a2|49fdb721|ucc_comm_rc|205866040|\bwost\b|\+1254[0-9]{7}", re.I)
SKIP = {"node_modules", "target", ".git", ".wrangler", "__pycache__"}
hits = []
for p in pathlib.Path(".").rglob("*"):
    if not p.is_file() or set(p.parts) & SKIP or p.name == "iceberg_check.sh": continue
    try: s = p.read_text(encoding="utf-8", errors="ignore")
    except Exception: continue
    for m in PAT.finditer(s): hits.append(f"{p}:{s.count(chr(10), 0, m.start())+1}:{m.group(0)}")
print(len(hits))
for h in hits[:40]: print(" ", h)
sys.exit(1 if hits else 0)
PY
