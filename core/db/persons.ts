// SLICE-006 person persistence. Domain CRUD stays behind core/db and uses the
// Drizzle mirror introduced for action slices.
import { and, asc, count, eq, inArray, ne } from "drizzle-orm";

import type { Queryable } from "./client";
import { drizzleFor } from "./drizzle";
import { authDevices, persons, workspaces } from "./schema";

export type RoleClass = "owner" | "manager" | "supervisor" | "worker";
export type PersonStatus = "active" | "inactive" | "pseudonymized";
export type SupportedLocale = "de" | "en";

export interface PersonSnapshot {
  id: string;
  workspace_id: string;
  display_name: string;
  role_class: RoleClass;
  auth_user_id: string | null;
  email: string | null;
  phone: string | null;
  locale: SupportedLocale;
  pin_hash: string | null;
  status: PersonStatus;
  created_at: string;
}

export interface CreatePersonParams {
  id: string;
  workspaceId: string;
  displayName: string;
  roleClass: RoleClass;
  email?: string;
  phone?: string;
  locale: SupportedLocale;
}

export interface PersonPatch {
  displayName?: string;
  roleClass?: RoleClass;
  email?: string | null;
  phone?: string | null;
  locale?: SupportedLocale;
  status?: PersonStatus;
  authUserId?: string | null;
  pinHash?: string | null;
}

export interface RevokedDeviceAudit {
  id: string;
  beforeStatus: "pending" | "active";
}

export interface DashboardMembership {
  person_id: string;
  workspace_id: string;
  workspace_display_name: string;
  role_class: Extract<RoleClass, "owner" | "manager">;
  locale: SupportedLocale;
}

export interface PublicDashboardMembership {
  workspace_id: string;
  workspace_display_name: string;
}

export const PSEUDONYMIZE_CLEARED_FIELDS = [
  "display_name",
  "email",
  "phone",
  "pin_hash",
  "auth_user_id",
] as const;

const personSelection = {
  id: persons.id,
  workspaceId: persons.workspaceId,
  displayName: persons.displayName,
  roleClass: persons.roleClass,
  authUserId: persons.authUserId,
  email: persons.email,
  phone: persons.phone,
  locale: persons.locale,
  pinHash: persons.pinHash,
  status: persons.status,
  createdAt: persons.createdAt,
};

function timestampSnapshot(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

function supportedLocale(value: unknown): SupportedLocale {
  return value === "en" ? "en" : "de";
}

function toPersonSnapshot(row: {
  id: string;
  workspaceId: string;
  displayName: string;
  roleClass: RoleClass;
  authUserId: string | null;
  email: string | null;
  phone: string | null;
  locale: string;
  pinHash: string | null;
  status: PersonStatus;
  createdAt: Date | string;
}): PersonSnapshot {
  return {
    id: row.id,
    workspace_id: row.workspaceId,
    display_name: row.displayName,
    role_class: row.roleClass,
    auth_user_id: row.authUserId,
    email: row.email,
    phone: row.phone,
    locale: supportedLocale(row.locale),
    pin_hash: row.pinHash,
    status: row.status,
    created_at: timestampSnapshot(row.createdAt),
  };
}

export function pseudonymizedDisplayName(personId: string): string {
  return `Person ${personId.replaceAll("-", "").slice(-6).toLowerCase()}`;
}

export async function workspaceDefaultLocale(tx: Queryable, workspaceId: string): Promise<SupportedLocale | null> {
  const db = drizzleFor(tx);
  const rows = await db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const settings = row.settings as { default_locale?: unknown };
  return supportedLocale(settings.default_locale);
}

export async function createPersonRow(tx: Queryable, params: CreatePersonParams): Promise<PersonSnapshot> {
  const db = drizzleFor(tx);
  const rows = await db
    .insert(persons)
    .values({
      id: params.id,
      workspaceId: params.workspaceId,
      displayName: params.displayName,
      roleClass: params.roleClass,
      email: params.email ?? null,
      phone: params.phone ?? null,
      locale: params.locale,
      status: "active",
    })
    .returning(personSelection);
  const row = rows[0];
  if (row === undefined) {
    throw new Error("person.create insert returned no row");
  }
  return toPersonSnapshot(row);
}

export async function personById(
  tx: Queryable,
  workspaceId: string,
  personId: string,
): Promise<PersonSnapshot | null> {
  const db = drizzleFor(tx);
  const rows = await db
    .select(personSelection)
    .from(persons)
    .where(and(eq(persons.workspaceId, workspaceId), eq(persons.id, personId)))
    .limit(1);
  const row = rows[0];
  return row === undefined ? null : toPersonSnapshot(row);
}

export async function dashboardMembershipsByAuthUserId(
  tx: Queryable,
  authUserId: string,
): Promise<PublicDashboardMembership[]> {
  const res = await tx.query<PublicDashboardMembership>(
    "SELECT workspace_id, workspace_display_name FROM app_dashboard_memberships_for_auth_user($1)",
    [authUserId],
  );
  return res.rows.map((row) => ({
    workspace_id: row.workspace_id,
    workspace_display_name: row.workspace_display_name,
  }));
}

export async function dashboardMembershipByWorkspace(
  tx: Queryable,
  authUserId: string,
  workspaceId: string,
): Promise<DashboardMembership | null> {
  const db = drizzleFor(tx);
  const rows = await db
    .select({
      personId: persons.id,
      workspaceId: persons.workspaceId,
      workspaceDisplayName: workspaces.name,
      roleClass: persons.roleClass,
      locale: persons.locale,
    })
    .from(persons)
    .innerJoin(workspaces, eq(workspaces.id, persons.workspaceId))
    .where(
      and(
        eq(persons.authUserId, authUserId),
        eq(persons.workspaceId, workspaceId),
        eq(persons.status, "active"),
        inArray(persons.roleClass, ["owner", "manager"]),
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
    workspace_id: row.workspaceId,
    workspace_display_name: row.workspaceDisplayName,
    role_class: row.roleClass === "owner" ? "owner" : "manager",
    locale: supportedLocale(row.locale),
  };
}

export async function activeOwnerCount(tx: Queryable, workspaceId: string): Promise<number> {
  const db = drizzleFor(tx);
  const rows = await db
    .select({ n: count() })
    .from(persons)
    .where(
      and(eq(persons.workspaceId, workspaceId), eq(persons.roleClass, "owner"), eq(persons.status, "active")),
    );
  return Number(rows[0]?.n ?? 0);
}

export async function lockWorkspaceForOwnerGuard(tx: Queryable, workspaceId: string): Promise<boolean> {
  const res = await tx.query("SELECT id FROM workspaces WHERE id = $1 FOR UPDATE", [workspaceId]);
  return res.rowCount === 1;
}

export async function updatePersonRow(
  tx: Queryable,
  workspaceId: string,
  personId: string,
  patch: PersonPatch,
): Promise<PersonSnapshot> {
  const db = drizzleFor(tx);
  const rows = await db
    .update(persons)
    .set(patch)
    .where(and(eq(persons.workspaceId, workspaceId), eq(persons.id, personId)))
    .returning(personSelection);
  const row = rows[0];
  if (row === undefined) {
    throw new Error(`person ${personId} disappeared during update`);
  }
  return toPersonSnapshot(row);
}

type LinkAuthRejected = "validation_failed" | "auth_already_linked" | "auth_email_mismatch" | "invite_ineligible";

async function latestPersonInviteEmail(tx: Queryable, workspaceId: string, personId: string): Promise<string | null> {
  const res = await tx.query<{ invited_email: string }>(
    `SELECT extras ->> 'invited_email' AS invited_email
     FROM audit_events
     WHERE workspace_id = $1
       AND action = 'person.invite'
       AND entity_type = 'persons'
       AND entity_id = $2
       AND extras ? 'auth_invite_id'
       AND extras ? 'invited_email'
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [workspaceId, personId],
  );
  return res.rows[0]?.invited_email ?? null;
}

async function lockedPersonForLink(
  tx: Queryable,
  workspaceId: string,
  personId: string,
): Promise<PersonSnapshot | null> {
  const res = await tx.query<{
    id: string;
    workspace_id: string;
    display_name: string;
    role_class: RoleClass;
    auth_user_id: string | null;
    email: string | null;
    phone: string | null;
    locale: string;
    pin_hash: string | null;
    status: PersonStatus;
    created_at: Date | string;
  }>(
    `SELECT id, workspace_id, display_name, role_class, auth_user_id, email,
            phone, locale, pin_hash, status, created_at
     FROM persons
     WHERE workspace_id = $1 AND id = $2
     FOR UPDATE`,
    [workspaceId, personId],
  );
  const row = res.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    ...row,
    locale: supportedLocale(row.locale),
    created_at: timestampSnapshot(row.created_at),
  };
}

async function validateLinkAuthUserToPerson(
  tx: Queryable,
  person: PersonSnapshot | null,
  params: {
    workspaceId: string;
    personId: string;
    email: string;
  },
): Promise<{ ok: true } | { rejected: LinkAuthRejected }> {
  if (person === null || person.status !== "active" || (person.role_class !== "owner" && person.role_class !== "manager")) {
    return { rejected: "validation_failed" };
  }
  if (person.email === null || person.email !== params.email) {
    return { rejected: "auth_email_mismatch" };
  }
  if (person.auth_user_id !== null) {
    return { rejected: "auth_already_linked" };
  }
  const invitedEmail = await latestPersonInviteEmail(tx, params.workspaceId, params.personId);
  if (invitedEmail === null) {
    return { rejected: "invite_ineligible" };
  }
  if (invitedEmail !== params.email) {
    return { rejected: "auth_email_mismatch" };
  }
  return { ok: true };
}

export async function preflightLinkAuthUserToPerson(
  tx: Queryable,
  params: {
    workspaceId: string;
    personId: string;
    email: string;
  },
): Promise<{ ok: true } | { rejected: LinkAuthRejected }> {
  const before = await personById(tx, params.workspaceId, params.personId);
  return validateLinkAuthUserToPerson(tx, before, params);
}

export async function linkAuthUserToPerson(
  tx: Queryable,
  params: {
    workspaceId: string;
    personId: string;
    authUserId: string;
    email: string;
  },
): Promise<{ person: PersonSnapshot } | { rejected: LinkAuthRejected }> {
  const person = await lockedPersonForLink(tx, params.workspaceId, params.personId);
  const validation = await validateLinkAuthUserToPerson(tx, person, params);
  if ("rejected" in validation) {
    return validation;
  }
  return { person: await updatePersonRow(tx, params.workspaceId, params.personId, { authUserId: params.authUserId }) };
}

export async function revokeNonRevokedAuthDevices(
  tx: Queryable,
  workspaceId: string,
  personId: string,
): Promise<RevokedDeviceAudit[]> {
  const db = drizzleFor(tx);
  const before = await db
    .select({ id: authDevices.id, status: authDevices.status })
    .from(authDevices)
    .where(
      and(
        eq(authDevices.workspaceId, workspaceId),
        eq(authDevices.personId, personId),
        ne(authDevices.status, "revoked"),
      ),
    )
    .orderBy(asc(authDevices.id));

  if (before.length === 0) {
    return [];
  }

  await db
    .update(authDevices)
    .set({ status: "revoked" })
    .where(
      and(
        eq(authDevices.workspaceId, workspaceId),
        eq(authDevices.personId, personId),
        ne(authDevices.status, "revoked"),
      ),
    );

  return before.map((row) => ({
    id: row.id,
    beforeStatus: row.status === "pending" ? "pending" : "active",
  }));
}
