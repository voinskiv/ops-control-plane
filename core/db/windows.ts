import { eq } from "drizzle-orm";

import type { VerificationRequirements } from "../domain/commitment-types";
import type { WindowStatus } from "../domain/window-state";
import type { Queryable } from "./client";
import { drizzleFor } from "./drizzle";
import { executionWindows } from "./schema";

export interface WindowSnapshot {
  id: string;
  workspace_id: string;
  commitment_id: string;
  site_id: string;
  date: string;
  starts_at: string;
  ends_at: string;
  target_qty: string | null;
  unit: string | null;
  requirements: VerificationRequirements;
  fulfillment: unknown;
  closed_by: string | null;
  closed_at: string | null;
  report_id: string | null;
  status: WindowStatus;
  created_at: string;
}

function timestamp(value: Date | string | null): string | null {
  return value instanceof Date ? value.toISOString() : value;
}

function snapshot(row: typeof executionWindows.$inferSelect): WindowSnapshot {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    commitment_id: row.commitmentId,
    site_id: row.siteId,
    date: row.date,
    starts_at: timestamp(row.startsAt)!,
    ends_at: timestamp(row.endsAt)!,
    target_qty: row.targetQty,
    unit: row.unit,
    requirements: row.requirements as VerificationRequirements,
    fulfillment: row.fulfillment,
    closed_by: row.closedBy,
    closed_at: timestamp(row.closedAt),
    report_id: row.reportId,
    status: row.status as WindowStatus,
    created_at: timestamp(row.createdAt)!,
  };
}

export async function createWindowRow(
  tx: Queryable,
  params: {
    id: string;
    workspaceId: string;
    commitmentId: string;
    siteId: string;
    date: string;
    startsAt: string;
    endsAt: string;
    targetQty: string | null;
    unit: string | null;
    requirements: VerificationRequirements;
    fulfillment: unknown;
  },
): Promise<WindowSnapshot> {
  const rows = await drizzleFor(tx)
    .insert(executionWindows)
    .values({
      id: params.id,
      workspaceId: params.workspaceId,
      commitmentId: params.commitmentId,
      siteId: params.siteId,
      date: params.date,
      startsAt: new Date(params.startsAt),
      endsAt: new Date(params.endsAt),
      targetQty: params.targetQty,
      unit: params.unit,
      requirements: params.requirements,
      fulfillment: params.fulfillment,
      status: "scheduled",
    })
    .returning();
  if (rows[0] === undefined) throw new Error("window.generate insert returned no row");
  return snapshot(rows[0]);
}

export async function lockWindow(tx: Queryable, workspaceId: string, windowId: string): Promise<WindowSnapshot | null> {
  const result = await tx.query<typeof executionWindows.$inferSelect>(
    `SELECT id, workspace_id AS "workspaceId", commitment_id AS "commitmentId", site_id AS "siteId",
       date::text AS date, starts_at AS "startsAt", ends_at AS "endsAt", target_qty AS "targetQty", unit,
       requirements, fulfillment, closed_by AS "closedBy", closed_at AS "closedAt", report_id AS "reportId",
       status, created_at AS "createdAt"
     FROM execution_windows WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [workspaceId, windowId],
  );
  return result.rows[0] === undefined ? null : snapshot(result.rows[0]);
}

export async function updateWindowStatus(tx: Queryable, windowId: string, status: WindowStatus): Promise<WindowSnapshot> {
  const rows = await drizzleFor(tx)
    .update(executionWindows)
    .set({ status })
    .where(eq(executionWindows.id, windowId))
    .returning();
  if (rows[0] === undefined) throw new Error("window action lost locked row");
  return snapshot(rows[0]);
}

export async function supervisorHasWindowSite(
  tx: Queryable,
  workspaceId: string,
  siteId: string,
  personId: string,
): Promise<boolean> {
  const result = await tx.query(
    `SELECT id FROM sites
     WHERE workspace_id = $1 AND id = $2
       AND COALESCE(settings->'supervisor_person_ids', '[]'::jsonb) @> jsonb_build_array($3::text)`,
    [workspaceId, siteId, personId],
  );
  return result.rowCount === 1;
}

export interface GeneratableCommitment {
  workspace_id: string;
  commitment_id: string;
}

export async function generatableCommitments(tx: Queryable): Promise<GeneratableCommitment[]> {
  const result = await tx.query<GeneratableCommitment>(
    "SELECT workspace_id, commitment_id FROM app_generatable_commitments()",
  );
  return result.rows;
}

export interface DueScheduledWindow {
  workspace_id: string;
  window_id: string;
}

export async function dueScheduledWindows(tx: Queryable): Promise<DueScheduledWindow[]> {
  const result = await tx.query<DueScheduledWindow>(
    "SELECT workspace_id, window_id FROM app_due_scheduled_windows()",
  );
  return result.rows;
}
