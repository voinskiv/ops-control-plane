-- 0004_audit_extras_platform_bootstrap.sql — DEC-006, DEC-007, and the two
-- operator-confirmed SLICE-003 bootstrap pieces (2026-07-06).

-- DEC-006: §5's Audit-extras payloads live in a dedicated column so
-- before/after stay pure entity-state diffs; covered by the append-only
-- privilege revocation of 0003 automatically.
ALTER TABLE audit_events ADD COLUMN extras jsonb;

-- DEC-007: platform actions (workspace.create, plan.set, entitlement.override)
-- are attributed faithfully, matching action_invocations (DEC-005).
-- invocation_actor_type stays a separate type deliberately.
ALTER TYPE actor_type ADD VALUE 'platform';

-- DEC-005 replay lookup (operator-confirmed): platform-actor invocations are
-- replay-matched by (idempotency_key, actor_type='platform') before any
-- workspace context exists. One auditable query shape via SECURITY DEFINER
-- instead of a policy carve-out; the strict tenant policies stay untouched.
CREATE FUNCTION app_platform_invocation_lookup(key text)
RETURNS SETOF action_invocations
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT * FROM public.action_invocations
  WHERE idempotency_key = key AND actor_type = 'platform'
$$;
REVOKE ALL ON FUNCTION app_platform_invocation_lookup(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_platform_invocation_lookup(text) TO app_kernel;

-- First plans row (operator-confirmed): global reference config (F9), outside
-- DEC-004's kernel-replay rule for tenant fixtures; limits/price stay inert
-- while the Phase 0 entitlement resolver is noop-unlimited — Phase 5
-- populates real plans via plan.set.
INSERT INTO plans (code, name, limits, price) VALUES ('pilot', 'Pilot', '{}', '{}');
