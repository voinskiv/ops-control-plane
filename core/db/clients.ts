// SLICE-007 client persistence (§5 catalog, §3 clients). Mirrors the
// SLICE-006 persons.ts shape: Drizzle CRUD behind core/db, flat action
// inputs mapping 1:1 to columns (DEC-008 shape, confirmed for clients/sites
// by DEC-009 Q4).
import { and, count, eq, ne } from "drizzle-orm";

import type { Queryable } from "./client";
import { drizzleFor } from "./drizzle";
import { clients, sites } from "./schema";

export type ClientStatus = "active" | "archived";

// DEC-009 Q4 implementation note: clients.contact is a single NOT NULL jsonb
// column: contact is written or replaced wholesale on the fields present in
// the action input, never deep-merged (no sub-field-level patch semantics —
// unspecified by §5/§3 beyond "fields", so this is the smallest additive
// shape).
export interface ContactInfo {
  email?: string;
  phone?: string;
  note?: string;
}

export interface ClientSnapshot {
  id: string;
  workspace_id: string;
  name: string;
  contact: ContactInfo;
  status: ClientStatus;
  created_at: string;
}

export interface CreateClientParams {
  id: string;
  workspaceId: string;
  name: string;
  contact?: ContactInfo;
}

export interface ClientPatch {
  name?: string;
  contact?: ContactInfo;
  status?: ClientStatus;
}

const clientSelection = {
  id: clients.id,
  workspaceId: clients.workspaceId,
  name: clients.name,
  contact: clients.contact,
  status: clients.status,
  createdAt: clients.createdAt,
};

function timestampSnapshot(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toClientSnapshot(row: {
  id: string;
  workspaceId: string;
  name: string;
  contact: unknown;
  status: ClientStatus;
  createdAt: Date | string;
}): ClientSnapshot {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    name: row.name,
    contact: (row.contact ?? {}) as ContactInfo,
    status: row.status,
    created_at: timestampSnapshot(row.createdAt),
  };
}

export async function createClientRow(tx: Queryable, params: CreateClientParams): Promise<ClientSnapshot> {
  const db = drizzleFor(tx);
  const rows = await db
    .insert(clients)
    .values({
      id: params.id,
      workspaceId: params.workspaceId,
      name: params.name,
      contact: params.contact ?? {},
      status: "active",
    })
    .returning(clientSelection);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("client.create insert returned no row");
  }
  return toClientSnapshot(row);
}

export async function clientById(tx: Queryable, workspaceId: string, clientId: string): Promise<ClientSnapshot | null> {
  const db = drizzleFor(tx);
  const rows = await db
    .select(clientSelection)
    .from(clients)
    .where(and(eq(clients.workspaceId, workspaceId), eq(clients.id, clientId)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toClientSnapshot(row);
}

export async function lockedClientById(
  tx: Queryable,
  workspaceId: string,
  clientId: string,
): Promise<{ id: string; status: ClientStatus } | null> {
  const res = await tx.query<{ id: string; status: ClientStatus }>(
    `SELECT id, status
     FROM clients
     WHERE workspace_id = $1 AND id = $2
     FOR UPDATE`,
    [workspaceId, clientId],
  );
  return res.rows[0] ?? null;
}

export async function activeClientLocked(tx: Queryable, workspaceId: string, clientId: string): Promise<boolean> {
  return (await lockedClientById(tx, workspaceId, clientId))?.status === "active";
}

export async function updateClientRow(
  tx: Queryable,
  workspaceId: string,
  clientId: string,
  patch: ClientPatch,
): Promise<ClientSnapshot> {
  const db = drizzleFor(tx);
  const rows = await db
    .update(clients)
    .set(patch)
    .where(and(eq(clients.workspaceId, workspaceId), eq(clients.id, clientId)))
    .returning(clientSelection);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`client ${clientId} disappeared during update`);
  }
  return toClientSnapshot(row);
}

// DEC-009 Q5: client.archive refuses while any of the client's sites is not
// archived (reject-while-sites-active — no cascade).
export async function hasNonArchivedSites(tx: Queryable, workspaceId: string, clientId: string): Promise<boolean> {
  const db = drizzleFor(tx);
  const rows = await db
    .select({ n: count() })
    .from(sites)
    .where(and(eq(sites.workspaceId, workspaceId), eq(sites.clientId, clientId), ne(sites.status, "archived")));
  return Number(rows[0]?.n ?? 0) > 0;
}
