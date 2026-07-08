// SLICE-007 site persistence (§5 catalog, §3 sites, §9 active-site meter,
// §8/F12 supervisor site scope). DEC-009: sites gain a non-billable 'draft'
// status; site.create writes it; site.activate is the sole transition onto
// 'active' and therefore the sole §9 meter-moving event.
import { and, count, eq } from "drizzle-orm";

import type { Queryable } from "./client";
import { drizzleFor } from "./drizzle";
import { persons, sites } from "./schema";

export type SiteStatus = "draft" | "active" | "archived";

// DEC-009 Q4 implementation note: sites.address is a single NOT NULL jsonb
// column, written/replaced wholesale on presence (same rule as
// clients.contact — no deep merge).
export interface AddressInfo {
  street?: string;
  postal_code?: string;
  city?: string;
  country?: string;
}

// §3/§8 F12: settings.supervisor_person_ids is the authz source for
// supervisor site scope. v1 defines no other settings field.
export interface SiteSettings {
  supervisor_person_ids: string[];
}

export interface SiteSnapshot {
  id: string;
  workspace_id: string;
  client_id: string;
  name: string;
  address: AddressInfo;
  settings: SiteSettings;
  status: SiteStatus;
  created_at: string;
}

export interface CreateSiteParams {
  id: string;
  workspaceId: string;
  clientId: string;
  name: string;
  address?: AddressInfo;
  supervisorPersonIds?: string[];
}

export interface SitePatch {
  name?: string;
  address?: AddressInfo;
  settings?: SiteSettings;
  status?: SiteStatus;
}

const siteSelection = {
  id: sites.id,
  workspaceId: sites.workspaceId,
  clientId: sites.clientId,
  name: sites.name,
  address: sites.address,
  settings: sites.settings,
  status: sites.status,
  createdAt: sites.createdAt,
};

function timestampSnapshot(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function toSiteSnapshot(row: {
  id: string;
  workspaceId: string;
  clientId: string;
  name: string;
  address: unknown;
  settings: unknown;
  status: SiteStatus;
  createdAt: Date | string;
}): SiteSnapshot {
  const settings = (row.settings ?? {}) as Partial<SiteSettings>;
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    client_id: row.clientId,
    name: row.name,
    address: (row.address ?? {}) as AddressInfo,
    settings: { supervisor_person_ids: settings.supervisor_person_ids ?? [] },
    status: row.status,
    created_at: timestampSnapshot(row.createdAt),
  };
}

export async function createSiteRow(tx: Queryable, params: CreateSiteParams): Promise<SiteSnapshot> {
  const db = drizzleFor(tx);
  const rows = await db
    .insert(sites)
    .values({
      id: params.id,
      workspaceId: params.workspaceId,
      clientId: params.clientId,
      name: params.name,
      address: params.address ?? {},
      settings: { supervisor_person_ids: params.supervisorPersonIds ?? [] },
      status: "draft",
    })
    .returning(siteSelection);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("site.create insert returned no row");
  }
  return toSiteSnapshot(row);
}

export async function siteById(tx: Queryable, workspaceId: string, siteId: string): Promise<SiteSnapshot | null> {
  const db = drizzleFor(tx);
  const rows = await db
    .select(siteSelection)
    .from(sites)
    .where(and(eq(sites.workspaceId, workspaceId), eq(sites.id, siteId)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toSiteSnapshot(row);
}

export async function updateSiteRow(
  tx: Queryable,
  workspaceId: string,
  siteId: string,
  patch: SitePatch,
): Promise<SiteSnapshot> {
  const db = drizzleFor(tx);
  const rows = await db
    .update(sites)
    .set(patch)
    .where(and(eq(sites.workspaceId, workspaceId), eq(sites.id, siteId)))
    .returning(siteSelection);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`site ${siteId} disappeared during update`);
  }
  return toSiteSnapshot(row);
}

// DEC-009 Q3: supervisor_person_ids entries must be existing, active,
// in-workspace persons with role_class='supervisor' — it is the §8/F12 authz
// source for supervisor site scope, not a plain persistence field. Returns
// the subset of the given ids that fail validation (empty = all valid).
export async function invalidSupervisorPersonIds(
  tx: Queryable,
  workspaceId: string,
  personIds: string[],
): Promise<string[]> {
  if (personIds.length === 0) {
    return [];
  }
  const db = drizzleFor(tx);
  const unique = [...new Set(personIds)];
  const rows = await db
    .select({ id: persons.id })
    .from(persons)
    .where(and(eq(persons.workspaceId, workspaceId), eq(persons.roleClass, "supervisor"), eq(persons.status, "active")));
  const valid = new Set(rows.map((row) => row.id));
  return unique.filter((id) => !valid.has(id));
}

// §9: the active-site meter counts sites.status='active' only — 'draft' is
// explicitly non-billable (DEC-009).
export async function activeSiteCount(tx: Queryable, workspaceId: string): Promise<number> {
  const db = drizzleFor(tx);
  const rows = await db
    .select({ n: count() })
    .from(sites)
    .where(and(eq(sites.workspaceId, workspaceId), eq(sites.status, "active")));
  return Number(rows[0]?.n ?? 0);
}
