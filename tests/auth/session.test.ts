import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { noopUnlimitedResolver } from "@core/actions/entitlement";
import { handleActionsPost } from "@core/actions/http";
import { Kernel } from "@core/actions/kernel";
import { internalRegistry, registry } from "@core/actions/registry";
import type { Actor, ResponseEnvelope } from "@core/actions/types";
import {
  DashboardAuth,
  AUTH_TOKEN_COOKIE,
  cookieHeader,
  GOOGLE_INVITE_STATE_COOKIE,
  WORKSPACE_COOKIE,
  type CookieChange,
} from "@core/auth/session";
import { setAuthTransportForTests, type AuthIdentity, type AuthTransport, type SendInviteParams } from "@core/auth/transport";
import { createAuthDb, type AuthDb } from "@core/db/auth";
import { connect, type DbClient } from "@core/db/client";
import { createKernelDb, type KernelDb } from "@core/db/kernel";
import { dashboardMembershipByWorkspace, dashboardMembershipsByAuthUserId } from "@core/db/persons";

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

function googleIdentity(params: {
  id: string;
  email: string;
  providerEmail: string;
  emailVerified: boolean;
  userMetadata?: Record<string, unknown>;
}): AuthIdentity {
  return {
    id: params.id,
    email: params.email,
    authenticationMethods: ["oauth"],
    identities: [
      {
        provider: "google",
        identityData: { email: params.providerEmail, emailVerified: params.emailVerified },
      },
    ],
    ...(params.userMetadata === undefined ? {} : { user_metadata: params.userMetadata }),
  } as AuthIdentity;
}

function googleInviteState(workspaceId: string, personId: string): { state: string; cookie: string } {
  const previousSupabaseUrl = process.env.SUPABASE_URL;
  process.env.SUPABASE_URL = "https://project.supabase.test";
  const started = auth.startGoogleInvite("https://app.example.test/api/auth/google/invite", workspaceId, personId);
  if (previousSupabaseUrl === undefined) {
    delete process.env.SUPABASE_URL;
  } else {
    process.env.SUPABASE_URL = previousSupabaseUrl;
  }
  expect(started).not.toBeNull();
  const redirectTo = new URL(started?.location ?? "").searchParams.get("redirect_to");
  const state = new URL(redirectTo ?? "").searchParams.get("state");
  const stateCookie = started?.cookies.find((cookie) => cookie.name === GOOGLE_INVITE_STATE_COOKIE);
  expect(state).toBeTruthy();
  expect(stateCookie).toBeDefined();
  expect(JSON.parse(stateCookie?.value ?? "{}")).toMatchObject({ nonce: state, workspaceId, personId });
  expect(cookieHeader(stateCookie ?? { name: GOOGLE_INVITE_STATE_COOKIE, value: "" })).toContain("HttpOnly");
  return { state: state ?? "", cookie: stateCookie?.value ?? "" };
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

async function linkInvocationCount(personId: string, authUserId: string): Promise<number> {
  const res = await admin.query<{ n: string }>(
    `SELECT count(*) AS n
     FROM action_invocations
     WHERE workspace_id = $1
       AND action_name = 'person.link_auth'
       AND idempotency_key = $2`,
    [workspaceA, `person.link:${personId}:${authUserId}`],
  );
  return Number(res.rows[0]?.n ?? 0);
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
    withWorkspace: (_workspaceId, fn) => fn(admin),
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
      return { inviteId: `invite:${params.personId}` };
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
    const inviteAudit = await admin.query<{ extras: { auth_invite_id?: unknown; invited_email?: unknown; invite_sent?: unknown } }>(
      "SELECT extras FROM audit_events WHERE action = 'person.invite' AND entity_id = $1",
      [managerAId],
    );
    expect(inviteAudit.rows[0]?.extras).toEqual({
      auth_invite_id: `invite:${managerAId}`,
      invited_email: "manager-a@example.test",
    });
    expect(inviteAudit.rows[0]?.extras.invite_sent).toBeUndefined();

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

  it("invites and links an active supervisor through the unchanged email acceptance path", async () => {
    const personId = randomUUID();
    const email = `supervisor-invite-${personId}@example.test`;
    await insertPerson({
      id: personId,
      workspaceId: workspaceA,
      displayName: "Invited Supervisor",
      roleClass: "supervisor",
      email,
    });
    expect(await dispatch(ownerA, "person.invite", { person_id: personId })).toMatchObject({ status: "ok" });
    const authUserId = randomUUID();
    const accepted = await auth.acceptInvite({
      accessToken: tokenFor({ id: authUserId, email }),
      workspaceId: workspaceA,
      personId,
    });
    expect(accepted.envelope.status).toBe("ok");
    expect(await personAuthUser(personId)).toBe(authUserId);
    expect((await auth.resolveActor(cookieLine(accepted.cookies))).actor).toEqual({
      type: "person",
      id: personId,
      roleClass: "supervisor",
      workspaceId: workspaceA,
    });
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
    expect((established.envelope.result as { memberships?: unknown[] }).memberships).toEqual(
      expect.arrayContaining([
        { workspace_id: workspaceA, workspace_display_name: "Auth A GmbH" },
        { workspace_id: workspaceB, workspace_display_name: "Auth B GmbH" },
      ]),
    );
    for (const membership of (established.envelope.result as { memberships?: Record<string, unknown>[] }).memberships ?? []) {
      expect(Object.keys(membership).sort()).toEqual(["workspace_display_name", "workspace_id"]);
    }

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

  it("clears malformed selected-workspace cookies before any workspace revalidation query", async () => {
    const url = inject("databaseUrl");
    const authDb = createAuthDb(url);
    const authUserId = randomUUID();
    const personId = randomUUID();
    await insertPerson({
      id: personId,
      workspaceId: workspaceA,
      displayName: "Malformed Cookie Manager",
      roleClass: "manager",
      email: "malformed-cookie@example.test",
      authUserId,
    });
    const accessToken = tokenFor({ id: authUserId, email: "malformed-cookie@example.test" });
    const authWithRlsDb = new DashboardAuth(authDb, () => kernel);

    try {
      for (const selectedWorkspace of ["not-a-uuid", ""]) {
        const resolved = await authWithRlsDb.resolveActor(
          `${AUTH_TOKEN_COOKIE}=${encodeURIComponent(accessToken)}; ${WORKSPACE_COOKIE}=${encodeURIComponent(selectedWorkspace)}`,
        );
        expect(resolved.actor).toBeNull();
        expect(resolved.cookies).toEqual([{ name: WORKSPACE_COOKIE, value: "", maxAge: 0 }]);
        await expect(
          handleActionsPost(() => kernel, resolved.actor, {
            name: "person.update",
            input: { person_id: personId, display_name: "Should Not Run" },
            idempotency_key: freshKey(),
          }),
        ).resolves.toMatchObject({
          httpStatus: 401,
          envelope: { status: "rejected", result: { code: "unauthenticated" } },
        });
      }
    } finally {
      await authDb.end();
    }
  });

  it("admits supervisor memberships and rejects worker-only identities", async () => {
    const supervisorAuth = (await admin.query<{ auth_user_id: string | null }>(
      "SELECT auth_user_id FROM persons WHERE id = $1",
      [supervisorId],
    )).rows[0]?.auth_user_id;
    const workerAuth = (await admin.query<{ auth_user_id: string | null }>("SELECT auth_user_id FROM persons WHERE id = $1", [workerId]))
      .rows[0]?.auth_user_id;
    expect(supervisorAuth).toBeTruthy();
    expect(workerAuth).toBeTruthy();
    const supervisorSession = await auth.establish(
      tokenFor({ id: supervisorAuth ?? randomUUID(), email: "supervisor@example.test" }),
      workspaceA,
    );
    expect(supervisorSession.envelope.status).toBe("ok");
    expect((await auth.resolveActor(cookieLine(supervisorSession.cookies))).actor).toMatchObject({ roleClass: "supervisor" });

    const workerSession = await auth.establish(tokenFor({ id: workerAuth ?? randomUUID(), email: "worker@example.test" }));
    expect(workerSession.envelope).toMatchObject({
      status: "rejected",
      result: { code: "no_dashboard_membership" },
    });
  });

  it("applies a supervisor role change on the next request without cached role authority", async () => {
    const authUserId = randomUUID();
    const personId = randomUUID();
    await insertPerson({
      id: personId,
      workspaceId: workspaceA,
      displayName: "Role Changed Supervisor",
      roleClass: "supervisor",
      email: "role-change-supervisor@example.test",
      authUserId,
    });
    const established = await auth.establish(
      tokenFor({ id: authUserId, email: "role-change-supervisor@example.test" }),
      workspaceA,
    );
    expect((await auth.resolveActor(cookieLine(established.cookies))).actor).toMatchObject({ roleClass: "supervisor" });

    expect(await dispatch(ownerA, "person.update", { person_id: personId, role_class: "worker" })).toMatchObject({
      status: "ok",
    });
    expect((await auth.resolveActor(cookieLine(established.cookies))).actor).toBeNull();
  });

  it("runs auth request reads as app_kernel under RLS while the DEC-011 lookup lists eligible memberships", async () => {
    const url = inject("databaseUrl");
    const authDb = createAuthDb(url);
    const authUserId = randomUUID();
    const personId = randomUUID();
    await insertPerson({
      id: personId,
      workspaceId: workspaceA,
      displayName: "RLS Manager",
      roleClass: "manager",
      email: "rls-manager@example.test",
      authUserId,
    });

    try {
      const raw = await authDb.withClient((client) =>
        client.query<{ current_user: string; n: string }>("SELECT current_user, count(*) AS n FROM workspaces"),
      );
      expect(raw.rows[0]).toMatchObject({ current_user: "app_kernel", n: "0" });

      const memberships = await authDb.withClient((client) => dashboardMembershipsByAuthUserId(client, authUserId));
      expect(memberships).toEqual([{ workspace_id: workspaceA, workspace_display_name: "Auth A GmbH" }]);

      const selected = await authDb.withWorkspace(workspaceA, (client) =>
        dashboardMembershipByWorkspace(client, authUserId, workspaceA),
      );
      expect(selected).toMatchObject({ person_id: personId, role_class: "manager", workspace_id: workspaceA });
    } finally {
      await authDb.end();
    }
  });

  it("widens the DEC-011 function to active supervisors without changing its return fields", async () => {
    const url = inject("databaseUrl");
    const authDb = createAuthDb(url);
    const authUserId = randomUUID();
    const personId = randomUUID();
    await insertPerson({
      id: personId,
      workspaceId: workspaceA,
      displayName: "RLS Supervisor",
      roleClass: "supervisor",
      email: "rls-supervisor@example.test",
      authUserId,
    });
    try {
      expect(await authDb.withClient((client) => dashboardMembershipsByAuthUserId(client, authUserId))).toEqual([
        { workspace_id: workspaceA, workspace_display_name: "Auth A GmbH" },
      ]);
      expect(await authDb.withWorkspace(workspaceA, (client) => dashboardMembershipByWorkspace(client, authUserId, workspaceA))).toMatchObject({
        person_id: personId,
        role_class: "supervisor",
        workspace_id: workspaceA,
      });
    } finally {
      await authDb.end();
    }
  });

  it("rejects Google invite state tampering before person.link_auth", async () => {
    const personId = randomUUID();
    const email = `state-${personId}@example.test`;
    await insertPerson({ id: personId, workspaceId: workspaceA, displayName: "State Supervisor", roleClass: "supervisor", email });
    expect(await dispatch(ownerA, "person.invite", { person_id: personId })).toMatchObject({ status: "ok" });
    const binding = googleInviteState(workspaceA, personId);
    const authUserId = randomUUID();
    const result = await auth.completeGoogleInvite({
      accessToken: tokenFor(googleIdentity({ id: authUserId, email, providerEmail: email, emailVerified: true })),
      state: randomUUID(),
      stateCookie: binding.cookie,
    });
    expect(result.envelope).toMatchObject({ status: "rejected", result: { code: "validation_failed" } });
    expect(await personAuthUser(personId)).toBeNull();
    expect(await linkInvocationCount(personId, authUserId)).toBe(0);
  });

  it("rejects an unverified Google provider email even when user_metadata claims verification", async () => {
    const personId = randomUUID();
    const email = `unverified-${personId}@example.test`;
    await insertPerson({ id: personId, workspaceId: workspaceA, displayName: "Unverified Supervisor", roleClass: "supervisor", email });
    expect(await dispatch(ownerA, "person.invite", { person_id: personId })).toMatchObject({ status: "ok" });
    const binding = googleInviteState(workspaceA, personId);
    const result = await auth.completeGoogleInvite({
      accessToken: tokenFor(
        googleIdentity({
          id: randomUUID(),
          email,
          providerEmail: email,
          emailVerified: false,
          userMetadata: { email, email_verified: true },
        }),
      ),
      state: binding.state,
      stateCookie: binding.cookie,
    });
    expect(result.envelope).toMatchObject({ status: "rejected", result: { code: "auth_email_mismatch" } });
    expect(await personAuthUser(personId)).toBeNull();
  });

  it("rejects a verified Google provider email that does not match the invited email", async () => {
    const personId = randomUUID();
    const email = `mismatch-google-${personId}@example.test`;
    await insertPerson({ id: personId, workspaceId: workspaceA, displayName: "Mismatch Google Supervisor", roleClass: "supervisor", email });
    expect(await dispatch(ownerA, "person.invite", { person_id: personId })).toMatchObject({ status: "ok" });
    const binding = googleInviteState(workspaceA, personId);
    const result = await auth.completeGoogleInvite({
      accessToken: tokenFor(
        googleIdentity({ id: randomUUID(), email, providerEmail: `other-${personId}@example.test`, emailVerified: true }),
      ),
      state: binding.state,
      stateCookie: binding.cookie,
    });
    expect(result.envelope).toMatchObject({ status: "rejected", result: { code: "auth_email_mismatch" } });
    expect(await personAuthUser(personId)).toBeNull();
  });

  it("links a supervisor from the verified Google identity email case-insensitively and ignores user_metadata", async () => {
    const personId = randomUUID();
    const invitedEmail = `Google.${personId}@Example.Test`;
    await insertPerson({ id: personId, workspaceId: workspaceA, displayName: "Google Supervisor", roleClass: "supervisor", email: invitedEmail });
    expect(await dispatch(ownerA, "person.invite", { person_id: personId })).toMatchObject({ status: "ok" });
    const binding = googleInviteState(workspaceA, personId);
    const authUserId = randomUUID();
    const result = await auth.completeGoogleInvite({
      accessToken: tokenFor(
        googleIdentity({
          id: authUserId,
          email: "ignored-user-email@example.test",
          providerEmail: invitedEmail.toLowerCase(),
          emailVerified: true,
          userMetadata: { email: "attacker@example.test", email_verified: false },
        }),
      ),
      state: binding.state,
      stateCookie: binding.cookie,
    });
    expect(result.envelope.status).toBe("ok");
    expect(await personAuthUser(personId)).toBe(authUserId);
  });

  it("rejects invite acceptance when no person.invite was issued for the person", async () => {
    const personId = randomUUID();
    await insertPerson({
      id: personId,
      workspaceId: workspaceA,
      displayName: "Uninvited Manager",
      roleClass: "manager",
      email: "uninvited@example.test",
    });
    const accessToken = tokenFor({ id: randomUUID(), email: "uninvited@example.test" });

    const accepted = await auth.acceptInvite({ accessToken, workspaceId: workspaceA, personId });
    expect(accepted.envelope).toMatchObject({ status: "rejected", result: { code: "invite_ineligible" } });
    expect(await personAuthUser(personId)).toBeNull();
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
    expect(await dispatch(ownerA, "person.invite", { person_id: personId })).toMatchObject({ status: "ok" });
    const authUserId = randomUUID();
    const accessToken = tokenFor({ id: authUserId, email: "other@example.test" });

    const accepted = await auth.acceptInvite({ accessToken, workspaceId: workspaceA, personId });
    expect(accepted.envelope).toMatchObject({ status: "rejected", result: { code: "auth_email_mismatch" } });
    expect(await personAuthUser(personId)).toBeNull();
  });

  it("rejects an identity at a manager-updated email when the invite was sent to another email", async () => {
    const personId = randomUUID();
    await insertPerson({
      id: personId,
      workspaceId: workspaceA,
      displayName: "Invite Email Binding",
      roleClass: "manager",
      email: "invited@example.test",
    });
    expect(await dispatch(ownerA, "person.invite", { person_id: personId })).toMatchObject({ status: "ok" });
    expect(await dispatch(ownerA, "person.update", { person_id: personId, email: "attacker@example.test" })).toMatchObject({
      status: "ok",
    });

    const authUserId = randomUUID();
    const accessToken = tokenFor({ id: authUserId, email: "attacker@example.test" });
    const accepted = await auth.acceptInvite({ accessToken, workspaceId: workspaceA, personId });

    expect(accepted.envelope).toMatchObject({ status: "rejected", result: { code: "auth_email_mismatch" } });
    expect(await personAuthUser(personId)).toBeNull();
    expect(await linkInvocationCount(personId, authUserId)).toBe(0);
  });

  it("rechecks the invited email inside the person.link_auth kernel transaction", async () => {
    const personId = randomUUID();
    await insertPerson({
      id: personId,
      workspaceId: workspaceA,
      displayName: "Kernel Invite Binding",
      roleClass: "manager",
      email: "invited-in-kernel@example.test",
    });
    expect(await dispatch(ownerA, "person.invite", { person_id: personId })).toMatchObject({ status: "ok" });
    expect(
      await dispatch(ownerA, "person.update", { person_id: personId, email: "attacker-in-kernel@example.test" }),
    ).toMatchObject({ status: "ok" });

    const authUserId = randomUUID();
    const linked = await kernel.dispatchInternal(
      { type: "system", workspaceId: workspaceA },
      {
        name: "person.link_auth",
        input: { person_id: personId, auth_user_id: authUserId, email: "attacker-in-kernel@example.test" },
        idempotencyKey: `person.link:${personId}:${authUserId}`,
      },
    );

    expect(linked).toMatchObject({ status: "rejected", result: { code: "auth_email_mismatch" } });
    expect(await personAuthUser(personId)).toBeNull();
  });

  it("does not persist failed link acceptance so a corrected email can re-invite and link with the same identity", async () => {
    const personId = randomUUID();
    await insertPerson({
      id: personId,
      workspaceId: workspaceA,
      displayName: "Corrected Manager",
      roleClass: "manager",
      email: "old@example.test",
    });
    expect(await dispatch(ownerA, "person.invite", { person_id: personId })).toMatchObject({ status: "ok" });
    const authUserId = randomUUID();
    const accessToken = tokenFor({ id: authUserId, email: "new@example.test" });

    const mismatch = await auth.acceptInvite({ accessToken, workspaceId: workspaceA, personId });
    expect(mismatch.envelope).toMatchObject({ status: "rejected", result: { code: "auth_email_mismatch" } });
    expect(await personAuthUser(personId)).toBeNull();

    expect(await dispatch(ownerA, "person.update", { person_id: personId, email: "new@example.test" })).toMatchObject({
      status: "ok",
    });
    expect(await dispatch(ownerA, "person.invite", { person_id: personId })).toMatchObject({ status: "ok" });

    const linked = await auth.acceptInvite({ accessToken, workspaceId: workspaceA, personId });
    expect(linked.envelope.status).toBe("ok");
    expect(await personAuthUser(personId)).toBe(authUserId);
  });

  it("rejects person.invite once the target is already linked", async () => {
    const invited = await dispatch(ownerA, "person.invite", { person_id: linkedManagerId });
    expect(invited).toMatchObject({ status: "rejected", result: { code: "auth_already_linked" } });
    expect(invites).toEqual([]);
  });
});
