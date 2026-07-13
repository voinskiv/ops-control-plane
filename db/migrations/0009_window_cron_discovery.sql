-- 0009_window_cron_discovery.sql — DEC-023 item 1.
-- Discovery returns natural identifiers only; all mutations still dispatch
-- through the ordinary tenant-scoped kernel.
CREATE FUNCTION app_generatable_commitments()
RETURNS TABLE (workspace_id uuid, commitment_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT c.workspace_id, c.id AS commitment_id
  FROM public.commitments c
  JOIN public.workspaces w ON w.id = c.workspace_id
  WHERE c.status = 'active'
    AND w.status = 'active'
    AND NULLIF(w.settings->>'tz', '') IS NOT NULL
    AND c.valid_from < ((CURRENT_TIMESTAMP AT TIME ZONE (w.settings->>'tz'))::date + 7)
    AND c.valid_to >= (CURRENT_TIMESTAMP AT TIME ZONE (w.settings->>'tz'))::date
  ORDER BY c.workspace_id, c.id
$$;
REVOKE ALL ON FUNCTION app_generatable_commitments() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_generatable_commitments() TO app_kernel;

CREATE FUNCTION app_due_scheduled_windows()
RETURNS TABLE (workspace_id uuid, window_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT ew.workspace_id, ew.id AS window_id
  FROM public.execution_windows ew
  WHERE ew.status = 'scheduled'
    AND ew.starts_at <= CURRENT_TIMESTAMP
  ORDER BY ew.workspace_id, ew.id
$$;
REVOKE ALL ON FUNCTION app_due_scheduled_windows() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_due_scheduled_windows() TO app_kernel;
