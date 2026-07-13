// Workspace bootstrap persistence for workspace.create (§5 catalog, §3
// workspaces/plans). Domain writes use Drizzle starting with SLICE-005
// (DECISIONS.md implementation note, 2026-07-06).
import { eq } from "drizzle-orm";

import type { Queryable } from "./client";
import { drizzleFor } from "./drizzle";
import { plans, workspaces } from "./schema";

export interface WorkspaceSettings {
  tz: "Europe/Berlin";
  default_locale: "de";
  branding: Record<string, never>;
  action_policies: Record<string, never>;
  retention_months: 24;
}

export interface PlanSnapshot {
  code: string;
  name: string;
  limits: unknown;
  price: unknown;
}

export interface WorkspaceSnapshot {
  id: string;
  name: string;
  slug: string;
  plan_code: string;
  settings: WorkspaceSettings;
  status: "active";
  created_at: string;
}

export interface CreateWorkspaceParams {
  id: string;
  name: string;
  planCode: string;
}

export const DEFAULT_WORKSPACE_SETTINGS: WorkspaceSettings = {
  tz: "Europe/Berlin",
  default_locale: "de",
  branding: {},
  action_policies: {},
  retention_months: 24,
};

function timestampSnapshot(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

export async function planSnapshotForCode(tx: Queryable, planCode: string): Promise<PlanSnapshot | null> {
  const db = drizzleFor(tx);
  const rows = await db
    .select({
      code: plans.code,
      name: plans.name,
      limits: plans.limits,
      price: plans.price,
    })
    .from(plans)
    .where(eq(plans.code, planCode))
    .limit(1);
  return rows[0] ?? null;
}

export async function workspaceTimeZone(tx: Queryable, workspaceId: string): Promise<string | null> {
  const result = await tx.query<{ time_zone: string | null }>(
    "SELECT settings->>'tz' AS time_zone FROM workspaces WHERE id = $1",
    [workspaceId],
  );
  return result.rows[0]?.time_zone ?? null;
}

export async function createWorkspaceRow(tx: Queryable, params: CreateWorkspaceParams): Promise<WorkspaceSnapshot> {
  const db = drizzleFor(tx);
  const settings = { ...DEFAULT_WORKSPACE_SETTINGS };
  const slug = params.id;
  const rows = await db
    .insert(workspaces)
    .values({
      id: params.id,
      name: params.name,
      slug,
      planCode: params.planCode,
      settings,
      status: "active",
    })
    .returning({
      id: workspaces.id,
      name: workspaces.name,
      slug: workspaces.slug,
      planCode: workspaces.planCode,
      settings: workspaces.settings,
      status: workspaces.status,
      createdAt: workspaces.createdAt,
    });
  const row = rows[0];
  if (row === undefined) {
    throw new Error("workspace.create insert returned no row");
  }
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    plan_code: row.planCode,
    settings: row.settings as WorkspaceSettings,
    status: "active",
    created_at: timestampSnapshot(row.createdAt),
  };
}
