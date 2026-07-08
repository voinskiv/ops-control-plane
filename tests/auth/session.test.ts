import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { noopUnlimitedResolver } from "@core/actions/entitlement";
import { Kernel } from "@core/actions/kernel";
import { internalRegistry, registry } from "@core/actions/registry";
import type { Actor, ResponseEnvelope } from "@core/actions/types";
import { DashboardAuth, AUTH_TOKEN_COOKIE, WORKSPACE_COOKIE, type CookieChange } from "@core/auth/session";
import { setAuthTransportForTests, type AuthIdentity, type AuthTransport, type SendInviteParams } from "@core/auth/transport";
import type { AuthDb } from "@core/db/auth";
import { connect, type DbClient } from "@core/db/client";
import { createKernelDb, type KernelDb } from "@core/db/kernel";

let admin: DbClient;
let kernelDb: KernelDb;
let kernel: Kernel;
let auth: DashboardAuth;
let invites: SendInviteParams[];
let identities: Map<string, AuthIdentity>;

const runTag = `test-auth-${randomUUID().slice(0, 8)}`;
const workspaceA = randomUUID();
const workspaceB = randomUUID();
const ownerAId = randomUUID();
const ownerBId = randomUUID();
const managerAId = randomUUID();
const linkedManagerId = randomUUID();
const supervisorId = randomUUID();
const workerId = randomUUID();

const ownerA = { type: "person", id: ownerAId, roleClass: "owner", workspaceId: workspaceA } as const satisfies Actor;

function freshKey(): string {
  return `auth:${randomUUID()}`;
}

function tokenFor(identity: AuthIdentity): string {
  const token = `token:${identity.id}`;
  identities.set(token, identity);
  return token;
}

function cookieLine(changes: CookieChange[]): string {
  return changes.map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`).join("; ");
}

async function dispatch(actor: Actor, name: string, input: unknown, idempotencyKey = freshKey()): Promise<ResponseEnvelope> {
  return kernel.dispatch(actor, { name, input, idempotencyKey });
}

async function personAuthUser(personId: string): Promise<string | null> {
  const res = await admin.query<{ auth_user_id: string | null }>("SELECT auth_user_id FROM persons WHERE id = $1", [personId]);
  return res.rows[0]?.auth_user_id ?? null;
}

async function insertWorkspace(id: string, slug: string, name: string): Promise<void> {
  await admin.query(
    `INSERT INTO workspaces (id, name, slug, plan_code, settings, status)
     VALUES ($1, $2, $3, 'pilot', $4, 'active')`,
    [
      id,
      name,
      slug,
      JSON.stringify({
        tz: "Europe/Berlin",
        default_locale: "de",
        branding: {},
        action_policies: {},
        retention_months: 24,
      }),
    ],
  );
}

async function insertPerson(params: {
  id: string;
  workspaceId: string;
  displayName: string;
  roleClass: "owner" | "manager" | "supervisor" | "worker";
  email?: string | null;
  authUserId?: string | null;
  status?: "active" | "inactive" | "pseudonymized";
}): Promise<void> {
  await admin.query(
    `INSERT INTO persons
       (id, workspace_id, display_name, role_class, auth_user_id, email, locale, status)
     VALUES ($1, $2, $3, $4, $5, $6, 'de', $7)`,
    [
      params.id,
      params.workspaceId,
      params.displayName,
      params.roleClass,
      params.authUserId ?? null,
      params.email ?? null,
      params.status ?? "active",
    ],
  );
}

beforeAll(async () => {
  const url = inject("databaseUrl");
  admin = await connect(url);
  kernelDb = createKernelDb(url);
  kernel = new Kernel(kernelDb, registry, noopUnlimitedResolver, internalRegistry);
  const authDb: AuthDb = {
    withClient: (fn) => fn(admin),
    end: async () => undefined,
  };
  auth = new DashboardAuth(authDb, () => kernel);

  await insertWorkspace(workspaceA, `${runTag}-a`, "Auth A GmbH");
  await insertWorkspace(workspaceB, `${runTag}-b`, "Auth B GmbH");
  await insertPerson({
    id: ownerAId,
    workspaceId: workspaceA,
    displayName: "Owner A",
    roleClass: "owner",
    email: "owner-a@example.test",
  });
  await insertPerson({
    id: ownerBId,
    workspaceId: workspaceB,
    displayName: "Owner B",
    roleClass: "owner",
    email: "owner-b@example.test",
  });
  await insertPerson({
    id: managerAId,
    workspaceId: workspaceA,
    displayName: "Manager A",
    roleClass: "manager",
    email: "manager-a@example.test",
  });
  await insertPerson({
    id: linkedManagerId,
    workspaceId: workspaceA,
    displayName: "Linked Manager",
    roleClass: "manager",
    email: "linked@example.test",
    authUserId: randomUUID(),
  });
  await insertPerson({
    id: supervisorId,
    workspaceId: workspaceA,
    displayName: "Supervisor A",
    roleClass: "supervisor",
    email: "supervisor@example.test",
    authUserId: randomUUID(),
  });
  await insertPerson({
    id: workerId,
    workspaceId: workspaceA,
    displayName: "Worker A",
    roleClass: "worker",
    email: "worker@example.test",
    authUserId: randomUUID(),
  });
});

beforeEach(() => {
  invites = [];
  identities = new Map<string, AuthIdentity>();
  const transport: AuthTransport = {
    async sendInvite(params) {
      invites.push(params);
    },
    async sendMagicLink() {
      return undefined;
    },
    async userFromAccessToken(accessToken) {
      return identities.get(accessToken) ?? null;
    },
  };
  setAuthTransportForTests(transport);
});

afterEach(() => {
  setAuthTransportForTests(null);
});

afterAll(async () => {
  await kernelDb.end();
  await admin.end();
});

describe("manager auth (SLICE-008, DEC-010)", () => {
  it("sends a person.invite and accepts it by linking the Supabase identity to the person row", async () => {
    const invited = await dispatch(ownerA, "person.invite", { person_id: managerAId });
    expect(invited.status).toBe("ok");
    expect(invites).toEqual([{ email: "manager-a@example.test", workspaceId: workspaceA, personId: managerAId }]);

    const authUserId = randomUUID();
    const accessToken = tokenFor({ id: authUserId, email: "manager-a@example.test" });
    const accepted = await auth.acceptInvite({ accessToken, workspaceId: workspaceA, personId: managerAId });

    expect(accepted.envelope.status).toBe("ok");
    expect(await personAuthUser(managerAId)).toBe(authUserId);
    expect(accepted.cookies.some((cookie) => cookie.name === AUTH_TOKEN_COOKIE && cookie.value === accessToken)).toBe(true);
    expect(accepted.cookies.some((cookie) => cookie.name === WORKSPACE_COOKIE && cookie.value === workspaceA)).toBe(true);

    const resolved = await auth.resolveActor(cookieLine(accepted.cookies));
    expect(resolved.actor).toEqual({ type: "person", id: managerAId, roleClass: "manager", workspaceId: workspaceA });
  });

  it("lists one qualifying identity across two workspaces and switches by re-validating the selected workspace", async () => {
    const authUserId = randomUUID();
    const managerBId = randomUUID();
    await insertPerson({
      id: managerBId,
      workspaceId: workspaceB,
      displayName: "Manager B",
      roleClass: "manager",
      email: "multi@example.test",
      authUserId,
    });
    const managerA2Id = randomUUID();
    await insertPerson({
      id: managerA2Id,
      workspaceId: workspaceA,
      displayName: "Manager A2",
      roleClass: "manager",
      email: "multi@example.test",
      authUserId,
    });
    const accessToken = tokenFor({ id: authUserId, email: "multi@example.test" });

    const established = await auth.establish(accessToken);
    expect(established.envelope.status).toBe("ok");
    expect((established.envelope.result as { selected_workspace_id?: string | null }).selected_workspace_id).toBeNull();
    expect((established.envelope.result as { memberships?: unknown[] }).memberships).toHaveLength(2);

    const selected = await auth.establish(accessToken, workspaceB);
    expect(selected.envelope.status).toBe("ok");
    expect((selected.envelope.result as { selected_workspace_id?: string }).selected_workspace_id).toBe(workspaceB);
    const resolved = await auth.resolveActor(cookieLine(selected.cookies));
    expect(resolved.actor).toEqual({ type: "person", id: managerBId, roleClass: "manager", workspaceId: workspaceB });
  });

  it("revokes a selected dashboard session immediately when the person is deactivated", async () => {
    const authUserId = randomUUID();
    const targetId = randomUUID();
    await insertPerson({
      id: targetId,
      workspaceId: workspaceA,
      displayName: "Revoked Manager",
      roleClass: "manager",
      email: "revoked@example.test",
      authUserId,
    });
    const accessToken = tokenFor({ id: authUserId, email: "revoked@example.test" });
    const established = await auth.establish(accessToken, workspaceA);
    expect((await auth.resolveActor(cookieLine(established.cookies))).actor).toMatchObject({ id: targetId });

    const deactivated = await dispatch(ownerA, "person.deactivate", { person_id: targetId, reason: "offboarded" });
    expect(deactivated.status).toBe("ok");

    const resolved = await auth.resolveActor(cookieLine(established.cookies));
    expect(resolved.actor).toBeNull();
    expect(resolved.cookies).toEqual([{ name: WORKSPACE_COOKIE, value: "", maxAge: 0 }]);
  });

  it("returns one typed rejection for identities with only ineligible role memberships", async () => {
    const supervisorAuth = (await admin.query<{ auth_user_id: string | null }>(
      "SELECT auth_user_id FROM persons WHERE id = $1",
      [supervisorId],
    )).rows[0]?.auth_user_id;
    const workerAuth = (await admin.query<{ auth_user_id: string | null }>("SELECT auth_user_id FROM persons WHERE id = $1", [workerId]))
      .rows[0]?.auth_user_id;
    expect(supervisorAuth).toBeTruthy();
    expect(workerAuth).toBeTruthy();
    for (const [authUserId, email] of [
      [supervisorAuth, "supervisor@example.test"],
      [workerAuth, "worker@example.test"],
    ] as const) {
      const accessToken = tokenFor({ id: authUserId ?? randomUUID(), email });
      const established = await auth.establish(accessToken);
      expect(established.envelope).toMatchObject({ status: "rejected", result: { code: "no_dashboard_membership" } });
    }
  });

  it("rejects invite acceptance when the Supabase identity email no longer matches the person email", async () => {
    const personId = randomUUID();
    await insertPerson({
      id: personId,
      workspaceId: workspaceA,
      displayName: "Mismatch Manager",
      roleClass: "manager",
      email: "expected@example.test",
    });
    const authUserId = randomUUID();
    const accessToken = tokenFor({ id: authUserId, email: "other@example.test" });

    const accepted = await auth.acceptInvite({ accessToken, workspaceId: workspaceA, personId });
    expect(accepted.envelope).toMatchObject({ status: "rejected", result: { code: "auth_email_mismatch" } });
    expect(await personAuthUser(personId)).toBeNull();
  });

  it("rejects person.invite once the target is already linked", async () => {
    const invited = await dispatch(ownerA, "person.invite", { person_id: linkedManagerId });
    expect(invited).toMatchObject({ status: "rejected", result: { code: "auth_already_linked" } });
    expect(invites).toEqual([]);
  });
});
