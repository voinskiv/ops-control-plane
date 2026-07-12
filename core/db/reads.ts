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
