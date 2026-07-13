// SLICE-012 commitment persistence (§3, §5 commitment.draft). This module is
// additive and follows the persons/sites Drizzle snapshot convention.
import { eq } from "drizzle-orm";

import { commitments } from "./schema";
import type { Queryable } from "./client";
import { drizzleFor } from "./drizzle";
import type { CommitmentTypeName, Verification } from "../domain/commitment-types";
import type { CommitmentStatus } from "../domain/commitment-state";

export interface CommitmentSnapshot {
  id: string;
  workspace_id: string;
  client_id: string;
  site_id: string;
  type: CommitmentTypeName;
  title: string;
  spec: unknown;
  schedule_rrule: string;
  target_qty: string | null;
  unit: string | null;
  verification: Verification;
  valid_from: string;
  valid_to: string;
  status: CommitmentStatus;
  created_at: string;
}

export interface CreateCommitmentParams {
  id: string;
  workspaceId: string;
  clientId: string;
  siteId: string;
  type: CommitmentTypeName;
  title: string;
  spec: unknown;
  scheduleRrule: string;
  targetQty: number | null;
  unit: string | null;
  verification: Verification;
  validFrom: string;
  validTo: string;
}

const commitmentSelection = {
  id: commitments.id,
  workspaceId: commitments.workspaceId,
  clientId: commitments.clientId,
  siteId: commitments.siteId,
  type: commitments.type,
  title: commitments.title,
  spec: commitments.spec,
  scheduleRrule: commitments.scheduleRrule,
  targetQty: commitments.targetQty,
  unit: commitments.unit,
  verification: commitments.verification,
  validFrom: commitments.validFrom,
  validTo: commitments.validTo,
  status: commitments.status,
  createdAt: commitments.createdAt,
};

function timestampSnapshot(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function snapshot(row: {
  id: string;
  workspaceId: string;
  clientId: string;
  siteId: string;
  type: string;
  title: string;
  spec: unknown;
  scheduleRrule: string;
  targetQty: string | null;
  unit: string | null;
  verification: unknown;
  validFrom: string;
  validTo: string;
  status: string;
  createdAt: Date | string;
}): CommitmentSnapshot {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    client_id: row.clientId,
    site_id: row.siteId,
    type: row.type as CommitmentTypeName,
    title: row.title,
    spec: row.spec,
    schedule_rrule: row.scheduleRrule,
    target_qty: row.targetQty,
    unit: row.unit,
    verification: row.verification as Verification,
    valid_from: row.validFrom,
    valid_to: row.validTo,
    status: row.status as CommitmentStatus,
    created_at: timestampSnapshot(row.createdAt),
  };
}

export async function lockedActiveSite(
  tx: Queryable,
  workspaceId: string,
  siteId: string,
): Promise<{ id: string; client_id: string } | null> {
  const result = await tx.query<{ id: string; client_id: string; status: "draft" | "active" | "archived" }>(
    `SELECT id, client_id, status
     FROM sites
     WHERE workspace_id = $1 AND id = $2
     FOR UPDATE`,
    [workspaceId, siteId],
  );
  const site = result.rows[0];
  return site?.status === "active" ? { id: site.id, client_id: site.client_id } : null;
}

export async function createCommitmentRow(
  tx: Queryable,
  params: CreateCommitmentParams,
): Promise<CommitmentSnapshot> {
  const db = drizzleFor(tx);
  const rows = await db
    .insert(commitments)
    .values({
      id: params.id,
      workspaceId: params.workspaceId,
      clientId: params.clientId,
      siteId: params.siteId,
      type: params.type,
      title: params.title,
      spec: params.spec,
      scheduleRrule: params.scheduleRrule,
      targetQty: params.targetQty === null ? null : String(params.targetQty),
      unit: params.unit,
      verification: params.verification,
      validFrom: params.validFrom,
      validTo: params.validTo,
      status: "draft",
    })
    .returning(commitmentSelection);
  const row = rows[0];
  if (row === undefined || row.status !== "draft") {
    throw new Error("commitment.draft insert returned no draft row");
  }
  return snapshot(row);
}

export async function lockCommitment(
  tx: Queryable,
  workspaceId: string,
  commitmentId: string,
): Promise<CommitmentSnapshot | null> {
  const result = await tx.query<{
    id: string;
    workspace_id: string;
    client_id: string;
    site_id: string;
    type: string;
    title: string;
    spec: unknown;
    schedule_rrule: string;
    target_qty: string | null;
    unit: string | null;
    verification: unknown;
    valid_from: string;
    valid_to: string;
    status: string;
    created_at: Date | string;
  }>(
    `SELECT id, workspace_id, client_id, site_id, type, title, spec,
       schedule_rrule, target_qty, unit, verification,
       valid_from::text, valid_to::text, status, created_at
     FROM commitments
     WHERE workspace_id = $1 AND id = $2
     FOR UPDATE`,
    [workspaceId, commitmentId],
  );
  const row = result.rows[0];
  return row === undefined
    ? null
    : snapshot({
        id: row.id,
        workspaceId: row.workspace_id,
        clientId: row.client_id,
        siteId: row.site_id,
        type: row.type,
        title: row.title,
        spec: row.spec,
        scheduleRrule: row.schedule_rrule,
        targetQty: row.target_qty,
        unit: row.unit,
        verification: row.verification,
        validFrom: row.valid_from,
        validTo: row.valid_to,
        status: row.status,
        createdAt: row.created_at,
      });
}

export interface CommitmentSpecPatch {
  title?: string;
  spec?: unknown;
  scheduleRrule?: string;
  targetQty?: number | null;
  unit?: string | null;
  verification?: Verification;
  validFrom?: string;
  validTo?: string;
}

export async function updateCommitmentSpecRow(
  tx: Queryable,
  commitmentId: string,
  patch: CommitmentSpecPatch,
): Promise<CommitmentSnapshot> {
  const values: Partial<typeof commitments.$inferInsert> = {};
  if (patch.title !== undefined) values.title = patch.title;
  if (patch.spec !== undefined) values.spec = patch.spec;
  if (patch.scheduleRrule !== undefined) values.scheduleRrule = patch.scheduleRrule;
  if (patch.targetQty !== undefined) values.targetQty = patch.targetQty === null ? null : String(patch.targetQty);
  if (patch.unit !== undefined) values.unit = patch.unit;
  if (patch.verification !== undefined) values.verification = patch.verification;
  if (patch.validFrom !== undefined) values.validFrom = patch.validFrom;
  if (patch.validTo !== undefined) values.validTo = patch.validTo;

  const rows = await drizzleFor(tx)
    .update(commitments)
    .set(values)
    .where(eq(commitments.id, commitmentId))
    .returning(commitmentSelection);
  const row = rows[0];
  if (row === undefined) throw new Error("commitment.update_spec lost locked row");
  return snapshot(row);
}

export async function updateCommitmentStatusRow(
  tx: Queryable,
  commitmentId: string,
  status: CommitmentStatus,
): Promise<CommitmentSnapshot> {
  const rows = await drizzleFor(tx)
    .update(commitments)
    .set({ status })
    .where(eq(commitments.id, commitmentId))
    .returning(commitmentSelection);
  const row = rows[0];
  if (row === undefined) throw new Error("commitment lifecycle action lost locked row");
  return snapshot(row);
}

export async function commitmentSiteIsActive(
  tx: Queryable,
  workspaceId: string,
  siteId: string,
): Promise<boolean> {
  const result = await tx.query<{ status: string }>(
    `SELECT status FROM sites WHERE workspace_id = $1 AND id = $2 FOR UPDATE`,
    [workspaceId, siteId],
  );
  return result.rows[0]?.status === "active";
}

export async function commitmentHasOpenWindows(
  tx: Queryable,
  workspaceId: string,
  commitmentId: string,
): Promise<boolean> {
  const result = await tx.query(
    `SELECT id FROM execution_windows
     WHERE workspace_id = $1 AND commitment_id = $2 AND status <> 'closed'
     LIMIT 1 FOR UPDATE`,
    [workspaceId, commitmentId],
  );
  return result.rowCount !== 0;
}

export interface DueCommitment {
  workspace_id: string;
  commitment_id: string;
}

export async function dueCommitments(tx: Queryable): Promise<DueCommitment[]> {
  const result = await tx.query<DueCommitment>(
    "SELECT workspace_id, commitment_id FROM app_due_commitments()",
  );
  return result.rows;
}

export interface WindowCronCommitment {
  id: string;
  schedule_rrule: string;
  valid_from: string;
  valid_to: string;
  time_zone: string;
}

export async function windowCronCommitment(
  tx: Queryable,
  workspaceId: string,
  commitmentId: string,
): Promise<WindowCronCommitment | null> {
  const result = await tx.query<WindowCronCommitment>(
    `SELECT c.id, c.schedule_rrule, c.valid_from::text, c.valid_to::text,
       w.settings->>'tz' AS time_zone
     FROM commitments c
     JOIN workspaces w ON w.id = c.workspace_id
     WHERE c.workspace_id = $1 AND c.id = $2 AND c.status = 'active' AND w.status = 'active'`,
    [workspaceId, commitmentId],
  );
  return result.rows[0] ?? null;
}
