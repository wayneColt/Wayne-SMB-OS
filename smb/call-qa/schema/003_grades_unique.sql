-- 003 · one grade per session. Cloudflare Queues delivers at least once and the gate runs two consumers; on
-- 2026-09-07 thirteen sessions were graded twice within seconds. The gate's graded-check cannot close a race that
-- starts before either job finishes; this index can. The gate inserts OR REPLACE, so a re-grade replaces, never duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS uq_grades_sess ON grades(telephony_session_id);
