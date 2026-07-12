-- 0008_due_commitments_cron.sql — DEC-020 option 1.
-- Tenant discovery discloses only the identifiers required to dispatch the
-- ordinary tenant-scoped commitment.complete action through the kernel.
CREATE FUNCTION app_due_commitments()
RETURNS TABLE (workspace_id uuid, commitment_id uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT c.workspace_id, c.id AS commitment_id
  FROM public.commitments c
  JOIN public.workspaces w ON w.id = c.workspace_id
  WHERE c.status IN ('active', 'paused')
    AND w.status = 'active'
    AND NULLIF(w.settings->>'tz', '') IS NOT NULL
    AND c.valid_to < (CURRENT_TIMESTAMP AT TIME ZONE (w.settings->>'tz'))::date
  ORDER BY c.workspace_id, c.id
$$;
REVOKE ALL ON FUNCTION app_due_commitments() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_due_commitments() TO app_kernel;
