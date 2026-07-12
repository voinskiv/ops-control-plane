-- 0007_auth_membership_supervisors.sql — DEC-013 item 4
-- Widen only the existing DEC-011 role filter. The SECURITY DEFINER,
-- search_path, grants, active-row predicates, ordering, and return fields stay
-- identical to 0006_auth_membership_lookup.sql.
CREATE OR REPLACE FUNCTION app_dashboard_memberships_for_auth_user(auth_user uuid)
RETURNS TABLE (workspace_id uuid, workspace_display_name text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ''
AS $$
  SELECT p.workspace_id, w.name AS workspace_display_name
  FROM public.persons p
  JOIN public.workspaces w ON w.id = p.workspace_id
  WHERE p.auth_user_id = auth_user
    AND p.status = 'active'
    AND p.role_class IN ('owner', 'manager', 'supervisor')
    AND w.status = 'active'
  ORDER BY w.name, p.id
$$;
REVOKE ALL ON FUNCTION app_dashboard_memberships_for_auth_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app_dashboard_memberships_for_auth_user(uuid) TO app_kernel;
