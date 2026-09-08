-- 002 · the client KPI observations (the client's logic, 2026-08-18) persisted per grade. Additive.
ALTER TABLE grades ADD COLUMN qualified INTEGER;
ALTER TABLE grades ADD COLUMN intake_outcome TEXT;
ALTER TABLE grades ADD COLUMN service_type TEXT;
CREATE INDEX IF NOT EXISTS idx_grades_intake ON grades(intake_outcome);
