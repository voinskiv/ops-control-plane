-- 0002_rls.sql — RLS backstop per ARCHITECTURE.md §7 (F13).
-- Kernel DB traffic runs as a dedicated app_kernel role that is *subject to*
-- RLS (it does not bypass it), setting app.workspace_id per transaction so
-- GUC-based policies compare each row's workspace_id to that setting. The
-- Supabase service role never serves request-path kernel DB traffic.
--
-- No DELETE privilege is granted and no DELETE policy exists on any table:
-- nothing hard-deletes — lifecycle via status (§3).

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_kernel') THEN
    CREATE ROLE app_kernel NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO app_kernel;

-- Unset GUC resolves to NULL, so every policy fails closed.
CREATE FUNCTION app_current_workspace_id() RETURNS uuid
LANGUAGE sql STABLE
AS $$
  SELECT nullif(current_setting('app.workspace_id', true), '')::uuid
$$;

-- Tenant tables: uniform workspace-scoped SELECT / INSERT / UPDATE policies.
-- audit_events is handled separately below (append-only: no UPDATE).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'persons',
    'auth_devices',
    'clients',
    'sites',
    'commitments',
    'reports',
    'execution_windows',
    'assignments',
    'execution_records',
    'proofs',
    'exceptions',
    'escalation_rules',
    'escalation_events',
    'action_invocations',
    'agent_proposals',
    'recovery_actions',
    'report_shares',
    'documents',
    'outbound_messages'
  ]
  LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON TABLE %I TO app_kernel', t);
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT TO app_kernel USING (workspace_id = app_current_workspace_id())',
      t || '_tenant_select', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT TO app_kernel WITH CHECK (workspace_id = app_current_workspace_id())',
      t || '_tenant_insert', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR UPDATE TO app_kernel USING (workspace_id = app_current_workspace_id()) WITH CHECK (workspace_id = app_current_workspace_id())',
      t || '_tenant_update', t);
  END LOOP;
END
$$;

-- workspaces — tenant root: its own id is the tenancy key (§3).
GRANT SELECT, INSERT, UPDATE ON TABLE workspaces TO app_kernel;
ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
CREATE POLICY workspaces_tenant_select ON workspaces
  FOR SELECT TO app_kernel USING (id = app_current_workspace_id());
CREATE POLICY workspaces_tenant_insert ON workspaces
  FOR INSERT TO app_kernel WITH CHECK (id = app_current_workspace_id());
CREATE POLICY workspaces_tenant_update ON workspaces
  FOR UPDATE TO app_kernel USING (id = app_current_workspace_id()) WITH CHECK (id = app_current_workspace_id());

-- plans — global config (§3): readable in any tenant context; the kernel gets
-- no write path until plan.set ships (Phase 5).
GRANT SELECT ON TABLE plans TO app_kernel;
ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY plans_select ON plans FOR SELECT TO app_kernel USING (true);

-- audit_events — append-only (§6): SELECT + INSERT only; privileges are also
-- revoked in 0003_immutability.sql.
GRANT SELECT, INSERT ON TABLE audit_events TO app_kernel;
ALTER TABLE audit_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_events_tenant_select ON audit_events
  FOR SELECT TO app_kernel USING (workspace_id = app_current_workspace_id());
CREATE POLICY audit_events_tenant_insert ON audit_events
  FOR INSERT TO app_kernel WITH CHECK (workspace_id = app_current_workspace_id());

-- schema_migrations — tooling metadata: RLS on with no policies makes it
-- invisible to app_kernel.
ALTER TABLE IF EXISTS schema_migrations ENABLE ROW LEVEL SECURITY;
