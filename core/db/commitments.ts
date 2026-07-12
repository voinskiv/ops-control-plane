// SLICE-012 commitment persistence (§3, §5 commitment.draft). This module is
// additive and follows the persons/sites Drizzle snapshot convention.
import { commitments } from "./schema";
import type { Queryable } from "./client";
import { drizzleFor } from "./drizzle";
import type { CommitmentTypeName, Verification } from "../domain/commitment-types";

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
  status: "draft";
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
    status: "draft",
    created_at: timestampSnapshot(row.createdAt),
  };
}
