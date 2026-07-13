import { and, eq, inArray } from "drizzle-orm";

import type { Queryable } from "./client";
import { drizzleFor } from "./drizzle";
import { persons, workspaces } from "./schema";

export interface MeIdentityRow {
  person_id: string;
  display_name: string;
  role_class: "owner" | "manager" | "supervisor";
  workspace_id: string;
  workspace_display_name: string;
  locale: string;
  workspace_settings: unknown;
}

export interface MeDayPackRow {
  site_id: string;
  site_name: string;
  window_id: string | null;
  commitment_id: string | null;
  title: string | null;
  type: "coverage" | "output" | "service_scope" | null;
  starts_at: Date | string | null;
  ends_at: Date | string | null;
  target_qty: string | null;
  unit: string | null;
  requirements: unknown;
  fulfillment: unknown;
  window_status: "scheduled" | "open" | "fulfilled" | "shortfall" | "missed" | "closed" | null;
  assignment_person_id: string | null;
  assignment_display_name: string | null;
  assignment_status: "planned" | "confirmed" | "removed" | null;
  assignment_role_class: "owner" | "manager" | "supervisor" | "worker" | null;
}

// §16 / DEC-010 R2 / DEC-013: the read re-checks the selected active,
// eligible membership inside its own RLS-scoped transaction. The route's
// actor resolution remains the identical first request gate used by actions.
export async function meIdentityRow(
  tx: Queryable,
  personId: string,
  workspaceId: string,
): Promise<MeIdentityRow | null> {
  const db = drizzleFor(tx);
  const rows = await db
    .select({
      personId: persons.id,
      displayName: persons.displayName,
      roleClass: persons.roleClass,
      workspaceId: workspaces.id,
      workspaceDisplayName: workspaces.name,
      locale: persons.locale,
      workspaceSettings: workspaces.settings,
    })
    .from(persons)
    .innerJoin(workspaces, eq(workspaces.id, persons.workspaceId))
    .where(
      and(
        eq(persons.id, personId),
        eq(persons.workspaceId, workspaceId),
        eq(persons.status, "active"),
        inArray(persons.roleClass, ["owner", "manager", "supervisor"]),
        eq(workspaces.status, "active"),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    person_id: row.personId,
    display_name: row.displayName,
    role_class: row.roleClass === "owner" || row.roleClass === "manager" ? row.roleClass : "supervisor",
    workspace_id: row.workspaceId,
    workspace_display_name: row.workspaceDisplayName,
    locale: row.locale,
    workspace_settings: row.workspaceSettings,
  };
}

// §8 F12 / §11 / DEC-016 item 8: one fresh, RLS-scoped projection supplies
// active sites, today's windows, and existing assignments. Owner/manager role
// inheritance is workspace-wide; supervisors are filtered by the current
// settings.supervisor_person_ids value on every request.
export async function meDayPackRows(
  tx: Queryable,
  workspaceId: string,
  date: string,
  roleClass: MeIdentityRow["role_class"],
  personId: string,
): Promise<MeDayPackRow[]> {
  const result = await tx.query<MeDayPackRow>(
    `SELECT s.id AS site_id,
            s.name AS site_name,
            ew.id AS window_id,
            c.id AS commitment_id,
            c.title,
            c.type,
            ew.starts_at,
            ew.ends_at,
            ew.target_qty,
            ew.unit,
            ew.requirements,
            ew.fulfillment,
            ew.status AS window_status,
            a.person_id AS assignment_person_id,
            p.display_name AS assignment_display_name,
            a.status AS assignment_status,
            p.role_class AS assignment_role_class
       FROM sites s
       LEFT JOIN execution_windows ew
         ON ew.workspace_id = s.workspace_id
        AND ew.site_id = s.id
        AND ew.date = $2::date
       LEFT JOIN commitments c
         ON c.workspace_id = ew.workspace_id
        AND c.id = ew.commitment_id
       LEFT JOIN assignments a
         ON a.workspace_id = ew.workspace_id
        AND a.window_id = ew.id
       LEFT JOIN persons p
         ON p.workspace_id = a.workspace_id
        AND p.id = a.person_id
      WHERE s.workspace_id = $1
        AND s.status = 'active'
        AND (
          $3::boolean
          OR COALESCE(s.settings->'supervisor_person_ids', '[]'::jsonb)
             @> jsonb_build_array($4::text)
        )
      ORDER BY s.name ASC, ew.starts_at ASC, ew.id ASC, p.display_name ASC, p.id ASC`,
    [workspaceId, date, roleClass === "owner" || roleClass === "manager", personId],
  );
  return result.rows;
}
