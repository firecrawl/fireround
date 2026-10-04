ALTER TABLE funding_rounds ADD COLUMN IF NOT EXISTS audit jsonb;
--> statement-breakpoint
ALTER TABLE funding_rounds ADD COLUMN IF NOT EXISTS audit_facts text;
--> statement-breakpoint
ALTER TABLE funding_rounds ADD COLUMN IF NOT EXISTS pending_disposition disposition;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS funding_rounds_pending_audit_idx ON funding_rounds (updated_at) WHERE pending_disposition IS NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION round_audit_facts(r funding_rounds) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT md5(concat_ws('|', r.company_id, r.stage, r.stage_as_written, r.is_extension, r.amount_as_written, r.amount_currency,
    r.amount_usd_millions, r.amount_scope, r.financing_total_as_written, r.valuation_as_written, r.announced_on, r.certainty, r.history))
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION gate_round_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.audit IS NOT NULL AND NEW.audit->>'status' IN ('pass', 'human') AND NEW.audit_facts IS NULL THEN
    NEW.audit_facts := round_audit_facts(NEW);
  END IF;
  IF NEW.disposition = 'rejected' THEN
    NEW.pending_disposition := NULL;
  ELSIF NEW.disposition IN ('publish', 'flagged')
    AND EXISTS (SELECT 1 FROM settings WHERE key = 'publication_audit' AND value = 'true'::jsonb)
    AND NOT (coalesce(NEW.audit->>'status', '') IN ('pass', 'human') AND NEW.audit_facts IS NOT DISTINCT FROM round_audit_facts(NEW)) THEN
    NEW.pending_disposition := NEW.disposition;
    NEW.disposition := 'review';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS funding_rounds_publication_gate ON funding_rounds;
--> statement-breakpoint
CREATE TRIGGER funding_rounds_publication_gate BEFORE INSERT OR UPDATE ON funding_rounds FOR EACH ROW EXECUTE FUNCTION gate_round_publication();
