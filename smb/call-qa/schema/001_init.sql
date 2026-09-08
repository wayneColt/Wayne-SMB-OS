-- HO-RCQA-001 · schema/001_init.sql · D1 database smbos_call_qa (created 2026-08-31 for this pipeline)
-- The four subscores are persisted; total_score is computed in code (policy.js), never by the model.
CREATE TABLE IF NOT EXISTS calls (
  telephony_session_id TEXT PRIMARY KEY,
  store_code      TEXT NOT NULL DEFAULT 'STOREA',
  extension_id    TEXT,
  extension_number TEXT,
  rep_name        TEXT,
  direction       TEXT,             -- Inbound | Outbound
  from_number     TEXT,
  to_number       TEXT,
  start_time      TEXT NOT NULL,    -- ISO8601
  duration_sec    INTEGER NOT NULL,
  leg_count       INTEGER NOT NULL DEFAULT 1,
  recording_ids   TEXT,             -- JSON array, ordered by startTime
  transcript      TEXT,             -- redacted
  status          TEXT NOT NULL,    -- queued|no_recording|transcribed|graded|failed
  attempts        INTEGER NOT NULL DEFAULT 0,
  last_error      TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS grades (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  telephony_session_id TEXT NOT NULL REFERENCES calls(telephony_session_id),
  greeting_score       INTEGER NOT NULL CHECK (greeting_score  BETWEEN 1 AND 5),
  discovery_score      INTEGER NOT NULL CHECK (discovery_score BETWEEN 1 AND 5),
  action_score         INTEGER NOT NULL CHECK (action_score    BETWEEN 1 AND 5),
  empathy_score        INTEGER NOT NULL CHECK (empathy_score   BETWEEN 1 AND 5),
  total_score          INTEGER NOT NULL,   -- computed in code, not by model
  call_outcome         TEXT NOT NULL,      -- booked|inquiry|complaint|lost_lead
  hostility_flag       INTEGER NOT NULL DEFAULT 0,
  strengths            TEXT,
  coaching_note        TEXT,
  model                TEXT NOT NULL,
  rubric_version       TEXT NOT NULL,
  graded_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alerts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  telephony_session_id TEXT NOT NULL,
  trigger_code         TEXT NOT NULL,   -- LOW_SCORE|LOST_LEAD|ESCALATION
  reason               TEXT,
  channel              TEXT NOT NULL DEFAULT 'rc_sms',
  to_number            TEXT,
  text                 TEXT,
  status               TEXT NOT NULL,   -- sent|failed|suppressed|drafted
  sent_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_calls_start   ON calls(start_time);
CREATE INDEX IF NOT EXISTS idx_calls_status  ON calls(status);
CREATE INDEX IF NOT EXISTS idx_grades_sess   ON grades(telephony_session_id);
CREATE INDEX IF NOT EXISTS idx_grades_time   ON grades(graded_at);
CREATE INDEX IF NOT EXISTS idx_alerts_time   ON alerts(sent_at);
