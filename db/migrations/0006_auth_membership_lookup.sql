-- 0006_auth_membership_lookup.sql — DEC-011 RLS-safe pre-selection
-- dashboard membership lookup for SLICE-008 auth.

-- DEC-011: pre-workspace membership discovery needs one narrow
-- SECURITY DEFINER query shape while keeping normal request-path traffic on
-- app_kernel under tenant RLS. This mirrors DEC-005's platform lookup pattern:
-- empty search_path, schema-qualified references, and EXECUTE only to
-- app_kernel. It returns only the DEC-010 R4 fields.
CREATE FUNCTION app_dashboard_memberships_for_auth_user(auth_user uuid)
RETURNS TABLE (workspace_id uuid, workspace_display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT p.workspace_id, w.name AS workspace_display_name
  FROM public.persons p
  JOIN public.workspaces w ON w.id = p.workspace_id
  WHERE p.auth_user_id = auth_user
    AND p.status = 'active'
    AND p.role_class IN ('owner', 'manager')
    AND w.status = 'active'
  ORDER BY w.name, p.id
$$;
REVOKE ALL ON FUNCTION app_dashboard_memberships_for_auth_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_dashboard_memberships_for_auth_user(uuid) TO app_kernel;
