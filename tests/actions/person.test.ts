import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { noopUnlimitedResolver } from "@core/actions/entitlement";
import { Kernel } from "@core/actions/kernel";
import { registry } from "@core/actions/registry";
import type { Actor, ResponseEnvelope } from "@core/actions/types";
import { connect, type DbClient } from "@core/db/client";
import { createKernelDb, type KernelDb } from "@core/db/kernel";

let admin: DbClient;
let kernelDb: KernelDb;
let kernel: Kernel;

const workspaceId = randomUUID();
const otherWorkspaceId = randomUUID();
const soloWorkspaceId = randomUUID();
const ownerId = randomUUID();
const managerId = randomUUID();
const supervisorId = randomUUID();
const workerActorId = randomUUID();
const soloOwnerId = randomUUID();
const runTag = `test-person-${randomUUID().slice(0, 8)}`;

const owner = { type: "person", id: ownerId, roleClass: "owner", workspaceId } as const satisfies Actor;
const manager = { type: "person", id: managerId, roleClass: "manager", workspaceId } as const satisfies Actor;
const supervisor = { type: "person", id: supervisorId, roleClass: "supervisor", workspaceId } as const satisfies Actor;
const workerActor = { type: "person", id: workerActorId, roleClass: "worker", workspaceId } as const satisfies Actor;
const agent = { type: "agent", id: randomUUID(), agentCode: "person_test_agent", workspaceId } as const satisfies Actor;
const soloOwner = { type: "person", id: soloOwnerId, roleClass: "owner", workspaceId: soloWorkspaceId } as const satisfies Actor;

function freshKey(): string {
  return `person:${randomUUID()}`;
}

async function dispatch(
  actor: Actor,
  name: string,
  input: unknown,
  idempotencyKey = freshKey(),
): Promise<ResponseEnvelope> {
  return kernel.dispatch(actor, { name, input, idempotencyKey });
}

async function invocationRow(key: string): Promise<{ id: string; status: string; result: ResponseEnvelope } | null> {
  const res = await admin.query<{ id: string; status: string; result: ResponseEnvelope }>(
    "SELECT id, status, result FROM action_invocations WHERE idempotency_key = $1",
    [key],
  );
  return res.rows[0] ?? null;
}

async function auditEventsFor(invocationId: string): Promise<
  {
    action: string;
    entity_type: string;
    entity_id: string;
    before: unknown;
    after: unknown;
    extras: unknown;
  }[]
> {
  const res = await admin.query<{
    action: string;
    entity_type: string;
    entity_id: string;
    before: unknown;
    after: unknown;
    extras: unknown;
  }>(
    "SELECT action, entity_type, entity_id, before, after, extras FROM audit_events WHERE invocation_id = $1 ORDER BY created_at, id",
    [invocationId],
  );
  return res.rows;
}

async function personRow(personId: string): Promise<{
  id: string;
  workspace_id: string;
  display_name: string;
  role_class: string;
  auth_user_id: string | null;
  email: string | null;
  phone: string | null;
  locale: string;
  pin_hash: string | null;
  status: string;
} | null> {
  const res = await admin.query<{
    id: string;
    workspace_id: string;
    display_name: string;
    role_class: string;
    auth_user_id: string | null;
    email: string | null;
    phone: string | null;
    locale: string;
    pin_hash: string | null;
    status: string;
  }>(
    `SELECT id, workspace_id, display_name, role_class, auth_user_id, email,
       phone, locale, pin_hash, status
     FROM persons WHERE id = $1`,
    [personId],
  );
  return res.rows[0] ?? null;
}

async function insertWorkspace(id: string, slug: string, defaultLocale = "de"): Promise<void> {
  await admin.query(
    `INSERT INTO workspaces (id, name, slug, plan_code, settings, status)
     VALUES ($1, 'Person Test GmbH', $2, 'pilot', $3, 'active')`,
    [
      id,
      slug,
      JSON.stringify({
        tz: "Europe/Berlin",
        default_locale: defaultLocale,
        branding: {},
        action_policies: {},
        retention_months: 24,
      }),
    ],
  );
}

async function insertPerson(params: {
  id?: string;
  workspaceId?: string;
  displayName?: string;
  roleClass?: "owner" | "manager" | "supervisor" | "worker";
  email?: string | null;
  phone?: string | null;
  locale?: string;
  pinHash?: string | null;
  authUserId?: string | null;
  status?: "active" | "inactive" | "pseudonymized";
}): Promise<string> {
  const id = params.id ?? randomUUID();
  await admin.query(
    `INSERT INTO persons
       (id, workspace_id, display_name, role_class, auth_user_id, email, phone,
        locale, pin_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id,
      params.workspaceId ?? workspaceId,
      params.displayName ?? "Fixture Person",
      params.roleClass ?? "worker",
      params.authUserId ?? null,
      params.email ?? null,
      params.phone ?? null,
      params.locale ?? "de",
      params.pinHash ?? null,
      params.status ?? "active",
    ],
  );
  return id;
}

async function insertAuthDevice(
  personId: string,
  status: "pending" | "active" | "revoked",
  params?: { workspaceId?: string; enrolledBy?: string },
): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO auth_devices
       (id, workspace_id, person_id, label, token_hash, enrolled_by, status)
     VALUES ($1, $2, $3, 'Phone', $4, $5, $6)`,
    [id, params?.workspaceId ?? workspaceId, personId, `token-${id}`, params?.enrolledBy ?? ownerId, status],
  );
  return id;
}

async function authDeviceStatus(deviceId: string): Promise<string | null> {
  const res = await admin.query<{ status: string }>("SELECT status FROM auth_devices WHERE id = $1", [deviceId]);
  return res.rows[0]?.status ?? null;
}

async function activeOwnerCountFor(workspace: string): Promise<number> {
  const res = await admin.query<{ n: string }>(
    "SELECT count(*) AS n FROM persons WHERE workspace_id = $1 AND role_class = 'owner' AND status = 'active'",
    [workspace],
  );
  return Number(res.rows[0]?.n ?? 0);
}

async function expectRejectedInvocationWithoutAudit(key: string, code: string): Promise<void> {
  const invocation = await invocationRow(key);
  expect(invocation?.status).toBe("rejected");
  expect(invocation?.result).toMatchObject({ status: "rejected", result: { code } });
  expect(await auditEventsFor(invocation?.id ?? "")).toEqual([]);
}

beforeAll(async () => {
  const url = inject("databaseUrl");
  admin = await connect(url);
  kernelDb = createKernelDb(url);
  kernel = new Kernel(kernelDb, registry, noopUnlimitedResolver);

  await insertWorkspace(workspaceId, runTag, "de");
  await insertWorkspace(otherWorkspaceId, `${runTag}-other`, "de");
  await insertWorkspace(soloWorkspaceId, `${runTag}-solo`, "de");

  await insertPerson({ id: ownerId, displayName: "Owner Actor", roleClass: "owner", email: "owner@example.test" });
  await insertPerson({ id: managerId, displayName: "Manager Actor", roleClass: "manager", email: "manager@example.test" });
  await insertPerson({ id: supervisorId, displayName: "Supervisor Actor", roleClass: "supervisor" });
  await insertPerson({ id: workerActorId, displayName: "Worker Actor", roleClass: "worker" });
  await insertPerson({
    id: soloOwnerId,
    workspaceId: soloWorkspaceId,
    displayName: "Solo Owner",
    roleClass: "owner",
    email: "solo@example.test",
  });
});

afterAll(async () => {
  await kernelDb.end();
  await admin.end();
});

describe("person.create (SLICE-006)", () => {
  it("creates an active person with workspace-default locale, audit, warning, and stable replay", async () => {
    const key = freshKey();
    const first = await dispatch(manager, "person.create", { display_name: "  Ada Worker  ", role_class: "worker" }, key);
    const replay = await dispatch(manager, "person.create", { display_name: "  Ada Worker  ", role_class: "worker" }, key);
    expect(first.status).toBe("ok");
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
    expect(first.warnings).toEqual([]);

    const personId = (first.result as { person_id?: string }).person_id ?? "";
    expect(first.result).toEqual({ person_id: personId });
    const person = await personRow(personId);
    expect(person).toMatchObject({
      workspace_id: workspaceId,
      display_name: "Ada Worker",
      role_class: "worker",
      email: null,
      phone: null,
      locale: "de",
      status: "active",
    });

    const invocation = await invocationRow(key);
    expect(invocation?.status).toBe("ok");
    const events = await auditEventsFor(invocation?.id ?? "");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "person.create",
      entity_type: "persons",
      entity_id: personId,
      extras: { role_change: { from: null, to: "worker" } },
    });
    expect(events[0]?.after).toMatchObject({ display_name: "Ada Worker", role_class: "worker", status: "active" });

    const counts = await admin.query<{ invocations: string; audits: string }>(
      `SELECT
         (SELECT count(*) FROM action_invocations WHERE idempotency_key = $1) AS invocations,
         (SELECT count(*) FROM audit_events WHERE action = 'person.create' AND entity_id = $2) AS audits`,
      [key, personId],
    );
    expect(counts.rows[0]).toEqual({ invocations: "1", audits: "1" });
  });

  it("warns when an invitable role has no email", async () => {
    const envelope = await dispatch(manager, "person.create", { display_name: "Manager No Mail", role_class: "manager" });
    expect(envelope).toMatchObject({ status: "ok", warnings: ["no_email_for_invitable_role"] });
  });

  it("rejects invalid role_class and missing display_name", async () => {
    await expect(dispatch(manager, "person.create", { display_name: "Bad", role_class: "admin" })).resolves.toMatchObject({
      status: "rejected",
      result: { code: "validation_failed" },
    });
    await expect(dispatch(manager, "person.create", { role_class: "worker" })).resolves.toMatchObject({
      status: "rejected",
      result: { code: "validation_failed" },
    });
  });
});

describe("person.update (SLICE-006)", () => {
  it("patches only present fields, clears email/phone with null, audits role changes, and replays", async () => {
    const targetId = await insertPerson({
      displayName: "Patch Target",
      roleClass: "worker",
      email: "old@example.test",
      phone: "111",
    });
    const key = freshKey();
    const input = {
      person_id: targetId,
      role_class: "supervisor",
      email: null,
      phone: " 222 ",
    };
    const first = await dispatch(manager, "person.update", input, key);
    const replay = await dispatch(manager, "person.update", input, key);
    expect(first.status).toBe("ok");
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
    expect(first.result).toEqual({ person_id: targetId });

    const person = await personRow(targetId);
    expect(person).toMatchObject({
      display_name: "Patch Target",
      role_class: "supervisor",
      email: null,
      phone: "222",
      locale: "de",
      status: "active",
    });

    const events = await auditEventsFor((await invocationRow(key))?.id ?? "");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "person.update",
      before: { role_class: "worker", email: "old@example.test", phone: "111" },
      after: { role_class: "supervisor", email: null, phone: "222" },
      extras: { role_change: { from: "worker", to: "supervisor" } },
    });
  });

  it("rejects empty patches, null non-null fields, pass-through fields, and pseudonymized targets", async () => {
    const targetId = await insertPerson({ displayName: "Update Reject", roleClass: "worker" });
    const pseudoId = await insertPerson({ displayName: "Person abc123", roleClass: "worker", status: "pseudonymized" });

    await expect(dispatch(manager, "person.update", { person_id: targetId })).resolves.toMatchObject({
      status: "rejected",
      result: { code: "validation_failed" },
    });
    await expect(dispatch(manager, "person.update", { person_id: targetId, display_name: null })).resolves.toMatchObject({
      status: "rejected",
      result: { code: "validation_failed" },
    });
    await expect(dispatch(manager, "person.update", { person_id: targetId, status: "inactive" })).resolves.toMatchObject({
      status: "rejected",
      result: { code: "validation_failed" },
    });
    await expect(dispatch(manager, "person.update", { person_id: pseudoId, display_name: "Nope" })).resolves.toMatchObject({
      status: "rejected",
      result: { code: "validation_failed" },
    });
  });
});

describe("person.deactivate (SLICE-006)", () => {
  it("moves active to inactive with reason audit and stable replay", async () => {
    const targetId = await insertPerson({ displayName: "Deactivate Target", roleClass: "worker" });
    const key = freshKey();
    const input = { person_id: targetId, reason: "Left the pilot workspace" };
    const first = await dispatch(manager, "person.deactivate", input, key);
    const replay = await dispatch(manager, "person.deactivate", input, key);
    expect(first.status).toBe("ok");
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
    expect(await personRow(targetId)).toMatchObject({ status: "inactive" });

    const events = await auditEventsFor((await invocationRow(key))?.id ?? "");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "person.deactivate",
      before: { status: "active" },
      after: { status: "inactive" },
      extras: { reason: "Left the pilot workspace" },
    });

    await expect(dispatch(manager, "person.deactivate", input)).resolves.toMatchObject({
      status: "rejected",
      result: { code: "validation_failed" },
    });
  });
});

describe("person.pseudonymize (SLICE-006)", () => {
  it("replaces PII, revokes devices, keeps references joinable, redacts audit before values, and replays", async () => {
    const authUserId = randomUUID();
    const targetId = await insertPerson({
      displayName: "Erika Mustermann",
      roleClass: "worker",
      authUserId,
      email: "erika@example.test",
      phone: "+49 30 123",
      pinHash: "pin-secret-hash",
      locale: "en",
    });
    const pendingDeviceId = await insertAuthDevice(targetId, "pending");
    const activeDeviceId = await insertAuthDevice(targetId, "active");
    const revokedDeviceId = await insertAuthDevice(targetId, "revoked");
    const historicalAuditId = randomUUID();
    await admin.query(
      `INSERT INTO audit_events
         (id, workspace_id, actor_type, actor_id, action, entity_type, entity_id, at)
       VALUES ($1, $2, 'person', $3, 'fixture.history', 'persons', $4, now())`,
      [historicalAuditId, workspaceId, ownerId, targetId],
    );

    const key = freshKey();
    const input = {
      person_id: targetId,
      legal_basis: { kind: "data_subject_request", note: "Requested by data subject" },
    };
    const first = await dispatch(owner, "person.pseudonymize", input, key);
    const replay = await dispatch(owner, "person.pseudonymize", input, key);
    expect(first.status).toBe("ok");
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
    expect(first.result).toEqual({ person_id: targetId });

    const placeholder = `Person ${targetId.replaceAll("-", "").slice(-6)}`;
    const person = await personRow(targetId);
    expect(person).toMatchObject({
      display_name: placeholder,
      email: null,
      phone: null,
      pin_hash: null,
      auth_user_id: null,
      locale: "de",
      status: "pseudonymized",
    });

    const deviceRows = await admin.query<{ id: string; status: string }>(
      "SELECT id, status FROM auth_devices WHERE person_id = $1 ORDER BY id",
      [targetId],
    );
    expect(deviceRows.rows).toEqual(
      expect.arrayContaining([
        { id: pendingDeviceId, status: "revoked" },
        { id: activeDeviceId, status: "revoked" },
        { id: revokedDeviceId, status: "revoked" },
      ]),
    );

    const joined = await admin.query<{ display_name: string }>(
      `SELECT p.display_name
       FROM audit_events a
       JOIN persons p ON p.id = a.entity_id
       WHERE a.id = $1`,
      [historicalAuditId],
    );
    expect(joined.rows[0]?.display_name).toBe(placeholder);

    const events = await auditEventsFor((await invocationRow(key))?.id ?? "");
    expect(events).toHaveLength(3);
    const personEvent = events.find((event) => event.entity_type === "persons");
    expect(personEvent).toMatchObject({
      action: "person.pseudonymize",
      entity_id: targetId,
      before: { cleared_fields: ["display_name", "email", "phone", "pin_hash", "auth_user_id"] },
      after: {
        display_name: placeholder,
        email: null,
        phone: null,
        pin_hash: null,
        auth_user_id: null,
        locale: "de",
        status: "pseudonymized",
      },
      extras: {
        legal_basis: { kind: "data_subject_request", note: "Requested by data subject" },
        cleared_fields: ["display_name", "email", "phone", "pin_hash", "auth_user_id"],
      },
    });

    const serializedInvocationAudit = JSON.stringify(events);
    expect(serializedInvocationAudit).not.toContain("Erika Mustermann");
    expect(serializedInvocationAudit).not.toContain("erika@example.test");
    expect(serializedInvocationAudit).not.toContain("+49 30 123");
    expect(serializedInvocationAudit).not.toContain("pin-secret-hash");
    expect(serializedInvocationAudit).not.toContain(authUserId);
    expect(events.filter((event) => event.entity_type === "auth_devices")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ entity_id: pendingDeviceId, before: { status: "pending" }, after: { status: "revoked" } }),
        expect.objectContaining({ entity_id: activeDeviceId, before: { status: "active" }, after: { status: "revoked" } }),
      ]),
    );

    await expect(dispatch(owner, "person.pseudonymize", input)).resolves.toMatchObject({
      status: "rejected",
      result: { code: "validation_failed" },
    });
  });
});

describe("person action authorization and tenancy guards (SLICE-006)", () => {
  it("rejects supervisor and worker actors on all person actions", async () => {
    const updateTargetId = await insertPerson({ displayName: "Auth Update", roleClass: "worker" });
    const deactivateTargetId = await insertPerson({ displayName: "Auth Deactivate", roleClass: "worker" });
    const pseudonymizeTargetId = await insertPerson({ displayName: "Auth Pseudo", roleClass: "worker" });
    const inviteTargetId = await insertPerson({
      displayName: "Auth Invite",
      roleClass: "manager",
      email: "auth-invite@example.test",
    });
    const cases = [
      { name: "person.create", input: { display_name: "No", role_class: "worker" } },
      { name: "person.update", input: { person_id: updateTargetId, display_name: "No" } },
      { name: "person.deactivate", input: { person_id: deactivateTargetId, reason: "No" } },
      {
        name: "person.pseudonymize",
        input: { person_id: pseudonymizeTargetId, legal_basis: { kind: "other", note: "No" } },
      },
      { name: "person.invite", input: { person_id: inviteTargetId } },
    ];

    for (const actor of [supervisor, workerActor]) {
      for (const item of cases) {
        await expect(dispatch(actor, item.name, item.input)).resolves.toMatchObject({
          status: "rejected",
          result: { code: "unauthorized" },
        });
      }
    }
  });

  it("enforces owner-only owner-role operations and human_only agent rejection", async () => {
    const targetOwnerId = await insertPerson({
      displayName: "Second Owner",
      roleClass: "owner",
      email: "second-owner@example.test",
    });
    const workerId = await insertPerson({ displayName: "Promote Me", roleClass: "worker" });

    await expect(dispatch(manager, "person.create", { display_name: "New Owner", role_class: "owner" })).resolves.toMatchObject({
      status: "rejected",
      result: { code: "unauthorized" },
    });
    await expect(dispatch(manager, "person.update", { person_id: targetOwnerId, display_name: "No" })).resolves.toMatchObject({
      status: "rejected",
      result: { code: "unauthorized" },
    });
    await expect(dispatch(manager, "person.update", { person_id: workerId, role_class: "owner" })).resolves.toMatchObject({
      status: "rejected",
      result: { code: "unauthorized" },
    });
    await expect(dispatch(manager, "person.deactivate", { person_id: targetOwnerId, reason: "No" })).resolves.toMatchObject({
      status: "rejected",
      result: { code: "unauthorized" },
    });
    await expect(
      dispatch(agent, "person.deactivate", { person_id: workerId, reason: "Agent cannot" }),
    ).resolves.toMatchObject({
      status: "rejected",
      result: { code: "unauthorized" },
    });
    await expect(
      dispatch(agent, "person.pseudonymize", {
        person_id: workerId,
        legal_basis: { kind: "other", note: "Agent cannot" },
      }),
    ).resolves.toMatchObject({
      status: "rejected",
      result: { code: "unauthorized" },
    });
  });

  it("protects the sole active owner from deactivate, pseudonymize, and demotion", async () => {
    const deactivateKey = freshKey();
    const pseudonymizeKey = freshKey();
    const demoteKey = freshKey();
    const deviceId = await insertAuthDevice(soloOwnerId, "active", {
      workspaceId: soloWorkspaceId,
      enrolledBy: soloOwnerId,
    });

    const before = await personRow(soloOwnerId);
    await expect(
      dispatch(
        soloOwner,
        "person.deactivate",
        { person_id: soloOwnerId, reason: "Cannot remove last owner" },
        deactivateKey,
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      result: { code: "last_owner_protected" },
    });
    await expectRejectedInvocationWithoutAudit(deactivateKey, "last_owner_protected");

    await expect(
      dispatch(
        soloOwner,
        "person.pseudonymize",
        {
          person_id: soloOwnerId,
          legal_basis: { kind: "other", note: "Cannot remove last owner" },
        },
        pseudonymizeKey,
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      result: { code: "last_owner_protected" },
    });
    await expectRejectedInvocationWithoutAudit(pseudonymizeKey, "last_owner_protected");

    await expect(
      dispatch(soloOwner, "person.update", { person_id: soloOwnerId, role_class: "manager" }, demoteKey),
    ).resolves.toMatchObject({
      status: "rejected",
      result: { code: "last_owner_protected" },
    });
    await expectRejectedInvocationWithoutAudit(demoteKey, "last_owner_protected");

    expect(await personRow(soloOwnerId)).toMatchObject({
      display_name: before?.display_name,
      role_class: "owner",
      email: before?.email,
      status: "active",
    });
    expect(await authDeviceStatus(deviceId)).toBe("active");
    expect(await activeOwnerCountFor(soloWorkspaceId)).toBe(1);
  });

  it("serializes concurrent active-owner removals so at least one owner remains", async () => {
    const raceWorkspaceId = randomUUID();
    await insertWorkspace(raceWorkspaceId, `${runTag}-race-${randomUUID().slice(0, 8)}`, "de");
    const ownerAId = await insertPerson({
      workspaceId: raceWorkspaceId,
      displayName: "Race Owner A",
      roleClass: "owner",
      email: "race-a@example.test",
    });
    const ownerBId = await insertPerson({
      workspaceId: raceWorkspaceId,
      displayName: "Race Owner B",
      roleClass: "owner",
      email: "race-b@example.test",
    });
    const ownerA = { type: "person", id: ownerAId, roleClass: "owner", workspaceId: raceWorkspaceId } as const satisfies Actor;
    const ownerB = { type: "person", id: ownerBId, roleClass: "owner", workspaceId: raceWorkspaceId } as const satisfies Actor;
    const keyA = freshKey();
    const keyB = freshKey();

    const [a, b] = await Promise.all([
      dispatch(ownerA, "person.deactivate", { person_id: ownerAId, reason: "Concurrent removal" }, keyA),
      dispatch(ownerB, "person.deactivate", { person_id: ownerBId, reason: "Concurrent removal" }, keyB),
    ]);

    expect([a.status, b.status].sort()).toEqual(["ok", "rejected"]);
    const rejectedKey = a.status === "rejected" ? keyA : keyB;
    const okKey = a.status === "ok" ? keyA : keyB;
    expect(a.status === "rejected" ? a.result : b.result).toEqual({ code: "last_owner_protected" });
    await expectRejectedInvocationWithoutAudit(rejectedKey, "last_owner_protected");
    expect((await auditEventsFor((await invocationRow(okKey))?.id ?? "")).length).toBe(1);
    expect(await activeOwnerCountFor(raceWorkspaceId)).toBeGreaterThanOrEqual(1);
  });

  it("uses validation_failed for cross-workspace target ids without leaking existence", async () => {
    const otherPersonId = await insertPerson({
      workspaceId: otherWorkspaceId,
      displayName: "Other Workspace",
      roleClass: "worker",
    });
    const updateKey = freshKey();
    const deactivateKey = freshKey();
    const pseudonymizeKey = freshKey();

    await expect(
      dispatch(manager, "person.update", { person_id: otherPersonId, display_name: "No leak" }, updateKey),
    ).resolves.toMatchObject({
      status: "rejected",
      result: { code: "validation_failed" },
    });
    await expectRejectedInvocationWithoutAudit(updateKey, "validation_failed");

    await expect(
      dispatch(manager, "person.deactivate", { person_id: otherPersonId, reason: "No leak" }, deactivateKey),
    ).resolves.toMatchObject({
      status: "rejected",
      result: { code: "validation_failed" },
    });
    await expectRejectedInvocationWithoutAudit(deactivateKey, "validation_failed");

    await expect(
      dispatch(
        owner,
        "person.pseudonymize",
        {
          person_id: otherPersonId,
          legal_basis: { kind: "other", note: "No leak" },
        },
        pseudonymizeKey,
      ),
    ).resolves.toMatchObject({
      status: "rejected",
      result: { code: "validation_failed" },
    });
    await expectRejectedInvocationWithoutAudit(pseudonymizeKey, "validation_failed");
    expect(await personRow(otherPersonId)).toMatchObject({
      workspace_id: otherWorkspaceId,
      display_name: "Other Workspace",
      status: "active",
    });
  });
});
