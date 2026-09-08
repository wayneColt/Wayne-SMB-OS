#!/usr/bin/env bash
# final_sweep.sh — the one command for the moment the ladder has DRAINED for a store.
#
#   bash final_sweep.sh <inventory.jsonl> <attribution.jsonl> [STORE=STOREA] [--yes]
#
# Order is load-bearing:
#   1. refuse unless the store has ZERO open rows (queued/transcribed) — a sweep over a still-running
#      ladder re-queues sessions the queue has not reached yet (they have no row, so they read "missing")
#   2. mint a fresh ADMIN_TOKEN and put it on the gate; it lives only in this process's environment
#   3. dry run (prints RECEIPT: inventoried · graded · failed · missing · to-queue)
#   4. --yes → live run (Store A-first, 12 s stagger through the heavy-group bucket)
#   5. rotate the token AGAIN so the one this process used is dead the moment it exits
#   6. print the store's reading, cache-busted, and the sandbox URL
# Nothing here writes a secret to disk. fabricated:false · 2026-09-06
set -euo pipefail
INV="${1:?inventory.jsonl}"; ATTR="${2:?attribution.jsonl}"; STORE="${3:-STOREA}"; YES="${4:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; GATE_DIR="$HERE/../sys-firewall/rc-qa-gate"
GATE="${RC_QA_GATE:-https://rc-qa-gate.<your-account>.workers.dev}"
[ -f "$INV" ] && [ -f "$ATTR" ] || { echo "NO_SIGNAL: inventory or attribution file missing"; exit 3; }

echo "── 1. open rows for $STORE"
OPEN=$(cd "$GATE_DIR" && npx wrangler d1 execute smbos_call_qa --remote --json --command "SELECT COUNT(*) n FROM calls WHERE store_code='$STORE' AND status NOT IN ('graded','failed','no_recording');" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['results'][0]['n'])")
echo "   open=$OPEN"
[ "$OPEN" = "0" ] || { echo "REFUSED: $OPEN row(s) still in the ladder for $STORE — a sweep now would re-queue sessions the queue has not reached. Wait for the drain."; exit 1; }
# zero open rows can happen for a moment between two jobs while the queue still holds delayed messages;
# the ladder is DRAINED only when it has also gone quiet — no grade for this store in the last 20 minutes
QUIET=$(cd "$GATE_DIR" && npx wrangler d1 execute smbos_call_qa --remote --json --command "SELECT CAST(strftime('%s','now') - strftime('%s', COALESCE(MAX(g.graded_at), '2000-01-01')) AS INTEGER) s FROM grades g JOIN calls c ON c.telephony_session_id=g.telephony_session_id WHERE c.store_code='$STORE';" 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)[0]['results'][0]['s'])")
echo "   last grade ${QUIET}s ago"
[ "$QUIET" -ge 1200 ] || { echo "REFUSED: the ladder graded a $STORE call ${QUIET}s ago — not drained, only between jobs. Wait until it has been quiet 20 minutes."; exit 1; }

echo "── 2. mint + put ADMIN_TOKEN (in-process only)"
TOK=$(python3 -c 'import secrets; print(secrets.token_hex(24))'); [ ${#TOK} -eq 48 ] || { echo "NO_SIGNAL: token mint failed"; exit 3; }
( cd "$GATE_DIR" && printf '%s' "$TOK" | npx wrangler secret put ADMIN_TOKEN >/dev/null 2>&1 ) || { echo "NO_SIGNAL: secret put failed"; exit 3; }
export ADMIN_TOKEN="$TOK"; sleep 8   # let the secret propagate before the first admin call

echo "── 3. dry run"
python3 "$HERE/rc_reconcile.py" --inventory "$INV" --attribution "$ATTR" --store "$STORE"

if [ "$YES" = "--yes" ]; then
  echo "── 4. LIVE"
  python3 "$HERE/rc_reconcile.py" --inventory "$INV" --attribution "$ATTR" --store "$STORE" --live
else
  echo "── 4. (dry only — pass --yes as the 4th argument to queue what is missing)"
fi

echo "── 5. rotate the token again (the one this process used is now dead)"
NEW=$(python3 -c 'import secrets; print(secrets.token_hex(24))')
( cd "$GATE_DIR" && printf '%s' "$NEW" | npx wrangler secret put ADMIN_TOKEN >/dev/null 2>&1 ) && echo "   rotated" || echo "   NO_SIGNAL: second rotation failed — rotate by hand: wrangler secret put ADMIN_TOKEN"
unset ADMIN_TOKEN TOK NEW

echo "── 6. reading"
curl -s -m 25 -A wia-smbos/1.0 "$GATE/stats?days=90&store=$STORE&cb=$(date +%s)" | python3 -c "
import sys, json; d = json.load(sys.stdin); o = d['opportunity_summary']; p = d.get('progress', {})
print('  progress', p, '· kpi_base', d.get('kpi_base'))
print('  inbound answered', o['total_inbound_calls_answered'], '· graded', o['calls_graded'], '· outbound set aside', o['outbound_calls_graded'], '· qualified', o['qualified_leads'], '· scheduled', o['scheduled_on_the_call'], '· close', o['close_rate_pct'], '%')
print('  FINAL' if not (p.get('queued') or p.get('transcribed')) else '  still grading')"
