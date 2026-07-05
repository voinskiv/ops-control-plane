-- 0003_immutability.sql — immutability enforcement per ARCHITECTURE.md §6 (F4, F30).
-- The protected set is exactly {audit_events, execution_records, proofs}.
-- Other naturally append-only tables (e.g. escalation_events) are guarded
-- inside core/domain without triggers; action_invocations is deliberately
-- outside this set (inserted pending, updated exactly once — F30).

-- audit_events: append-only — UPDATE/DELETE privileges revoked outright (§6).
REVOKE UPDATE, DELETE ON TABLE audit_events FROM PUBLIC, app_kernel;

-- execution_records / proofs: DELETE revoked; UPDATE gated by BEFORE triggers (F4).
REVOKE DELETE ON TABLE execution_records FROM PUBLIC, app_kernel;
REVOKE DELETE ON TABLE proofs FROM PUBLIC, app_kernel;

-- F4: reject any UPDATE that (a) touches a non-status column, or (b) runs
-- without the kernel-set session GUC app.kernel_op — so only kernel-driven
-- status transitions (record.verify/supersede/void, proof.complete_upload)
-- pass and every fact column stays immutable.
CREATE FUNCTION enforce_fact_immutability() RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF nullif(current_setting('app.kernel_op', true), '') IS NULL THEN
    RAISE EXCEPTION 'non-kernel UPDATE on % rejected: app.kernel_op is not set (F4)', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  IF (to_jsonb(OLD) - 'status') IS DISTINCT FROM (to_jsonb(NEW) - 'status') THEN
    RAISE EXCEPTION 'UPDATE on % touches a fact column; only status transitions are allowed (F4)', TG_TABLE_NAME
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER execution_records_fact_immutability
  BEFORE UPDATE ON execution_records
  FOR EACH ROW EXECUTE FUNCTION enforce_fact_immutability();

CREATE TRIGGER proofs_fact_immutability
  BEFORE UPDATE ON proofs
  FOR EACH ROW EXECUTE FUNCTION enforce_fact_immutability();
