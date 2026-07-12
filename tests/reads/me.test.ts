import { randomUUID } from "node:crypto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { noopUnlimitedResolver } from "@core/actions/entitlement";
import { Kernel } from "@core/actions/kernel";
import { internalRegistry, registry } from "@core/actions/registry";
import type { Actor } from "@core/actions/types";
import {
  AUTH_TOKEN_COOKIE,
  DashboardAuth,
  WORKSPACE_COOKIE,
  type ActorResolution,
  type CookieChange,
} from "@core/auth/session";
import { setAuthTransportForTests, type AuthIdentity, type AuthTransport } from "@core/auth/transport";
import { createAuthDb, type AuthDb } from "@core/db/auth";
import { connect, type DbClient } from "@core/db/client";
import { createKernelDb, type KernelDb } from "@core/db/kernel";
import { handleReadsGet } from "@core/reads/http";
import { ReadKernel } from "@core/reads/kernel";
import { readJsonSchemas, readRegistry } from "@core/reads/registry";

let admin: DbClient;
let authDb: AuthDb;
let kernelDb: KernelDb;
let kernel: Kernel;
let auth: DashboardAuth;
let reads: ReadKernel;
let identities: Map<string, AuthIdentity>;

const runTag = `test-reads-${randomUUID().slice(0, 8)}`;
const workspaceId = randomUUID();
const ownerId = randomUUID();
const managerId = randomUUID();
const supervisorId = randomUUID();
const workerId = randomUUID();
const ownerAuthId = randomUUID();
const managerAuthId = randomUUID();
const supervisorAuthId = randomUUID();
const workerAuthId = randomUUID();
const fixedNow = new Date("2026-07-12T22:30:00.000Z");

const owner: Actor = { type: "person", id: ownerId, roleClass: "owner", workspaceId };

function tokenFor(identity: AuthIdentity): string {
  const token = `token:${identity.id}`;
  identities.set(token, identity);
  return token;
}

function cookieLine(changes: CookieChange[]): string {
  return changes.map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`).join("; ");
}

async function selectedResolution(authUserId: string, email: string): Promise<{ cookies: string; resolved: ActorResolution }> {
  const established = await auth.establish(tokenFor({ id: authUserId, email }), workspaceId);
  expect(established.envelope.status).toBe("ok");
  const cookies = cookieLine(established.cookies);
  return { cookies, resolved: await auth.resolveActor(cookies) };
}

async function insertPerson(params: {
  id: string;
  authUserId: string;
  displayName: string;
  roleClass: "owner" | "manager" | "supervisor" | "worker";
  email: string;
  locale: "de" | "en";
}): Promise<void> {
  await admin.query(
    `INSERT INTO persons
       (id, workspace_id, display_name, role_class, auth_user_id, email, locale, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')`,
    [params.id, workspaceId, params.displayName, params.roleClass, params.authUserId, params.email, params.locale],
  );
}

beforeAll(async () => {
  const url = inject("databaseUrl");
  admin = await connect(url);
  authDb = createAuthDb(url);
  kernelDb = createKernelDb(url);
  kernel = new Kernel(kernelDb, registry, noopUnlimitedResolver, internalRegistry);
  auth = new DashboardAuth(authDb, () => kernel);

  const observedDb: AuthDb = {
    async withClient<T>(fn: Parameters<AuthDb["withClient"]>[0]): Promise<T> {
      return authDb.withClient(fn) as Promise<T>;
    },
    async withWorkspace<T>(selectedWorkspaceId: string, fn: Parameters<AuthDb["withWorkspace"]>[1]): Promise<T> {
      return authDb.withWorkspace(selectedWorkspaceId, async (client) => {
        const probe = await client.query<{ current_user: string; workspace_id: string }>(
          "SELECT current_user, current_setting('app.workspace_id') AS workspace_id",
        );
        expect(probe.rows[0]).toEqual({ current_user: "app_kernel", workspace_id: selectedWorkspaceId });
        return fn(client);
      }) as Promise<T>;
    },
    end: async () => undefined,
  };
  reads = new ReadKernel(observedDb, readRegistry, () => fixedNow);

  await admin.query(
    `INSERT INTO workspaces (id, name, slug, plan_code, settings, status)
     VALUES ($1, 'Reads GmbH', $2, 'pilot', $3, 'active')`,
    [
      workspaceId,
      runTag,
      JSON.stringify({
        tz: "Europe/Berlin",
        default_locale: "de",
        branding: {},
        action_policies: {},
        retention_months: 24,
      }),
    ],
  );
  await insertPerson({
    id: ownerId,
    authUserId: ownerAuthId,
    displayName: "Reads Owner",
    roleClass: "owner",
    email: "reads-owner@example.test",
    locale: "de",
  });
  await insertPerson({
    id: managerId,
    authUserId: managerAuthId,
    displayName: "Reads Manager",
    roleClass: "manager",
    email: "reads-manager@example.test",
    locale: "en",
  });
  await insertPerson({
    id: supervisorId,
    authUserId: supervisorAuthId,
    displayName: "Reads Supervisor",
    roleClass: "supervisor",
    email: "reads-supervisor@example.test",
    locale: "de",
  });
  await insertPerson({
    id: workerId,
    authUserId: workerAuthId,
    displayName: "Reads Worker",
    roleClass: "worker",
    email: "reads-worker@example.test",
    locale: "de",
  });
});

beforeEach(() => {
  identities = new Map<string, AuthIdentity>();
  const transport: AuthTransport = {
    async sendInvite() {
      throw new Error("not used");
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
  await authDb.end();
  await kernelDb.end();
  await admin.end();
});

describe("SLICE-010 read layer", () => {
  it("registers only me and exports JSON Schemas for both params and response", () => {
    expect(readRegistry.list().map((definition) => definition.name)).toEqual(["me"]);
    expect(readJsonSchemas.me).toBeDefined();
    expect(readJsonSchemas.me?.params).toMatchObject({ type: "object", additionalProperties: false });
    expect(readJsonSchemas.me?.response).toMatchObject({
      type: "object",
      required: expect.arrayContaining([
        "date",
        "generated_at",
        "sites",
        "persons",
        "labels",
        "person_id",
        "display_name",
        "role_class",
        "workspace_id",
        "workspace_display_name",
      ]),
    });
  });

  it("returns the empty DEC-016 item 8 shell for an authenticated supervisor", async () => {
    const { resolved } = await selectedResolution(
      supervisorAuthId,
      "reads-supervisor@example.test",
    );
    const response = await handleReadsGet(reads, resolved, "me", {});
    expect(response).toEqual({
      httpStatus: 200,
      body: {
        date: "2026-07-13",
        generated_at: fixedNow.toISOString(),
        sites: [],
        persons: [],
        labels: { title: "Erfassung" },
        person_id: supervisorId,
        display_name: "Reads Supervisor",
        role_class: "supervisor",
        workspace_id: workspaceId,
        workspace_display_name: "Reads GmbH",
      },
    });
  });

  it("returns fresh manager identity context and the person's English capture labels", async () => {
    const { resolved } = await selectedResolution(managerAuthId, "reads-manager@example.test");
    const response = await handleReadsGet(reads, resolved, "me", {});
    expect(response).toMatchObject({
      httpStatus: 200,
      body: {
        labels: { title: "Capture" },
        person_id: managerId,
        display_name: "Reads Manager",
        role_class: "manager",
        workspace_id: workspaceId,
        workspace_display_name: "Reads GmbH",
      },
    });
  });

  it("allows an owner session to call the self-scoped me read", async () => {
    const { resolved } = await selectedResolution(ownerAuthId, "reads-owner@example.test");
    await expect(handleReadsGet(reads, resolved, "me", {})).resolves.toMatchObject({
      httpStatus: 200,
      body: { role_class: "owner", person_id: ownerId },
    });
  });

  it("mirrors the actions rejection envelope for an unknown read name", async () => {
    const { resolved } = await selectedResolution(supervisorAuthId, "reads-supervisor@example.test");
    await expect(handleReadsGet(reads, resolved, "not_registered", {})).resolves.toEqual({
      httpStatus: 400,
      body: { status: "rejected", result: { code: "unknown_read" }, warnings: [] },
    });
  });

  it("returns existing typed rejections for unauthenticated and ineligible-role requests", async () => {
    const unauthenticated = await auth.resolveActor(null);
    await expect(handleReadsGet(reads, unauthenticated, "me", {})).resolves.toEqual({
      httpStatus: 401,
      body: { status: "rejected", result: { code: "unauthenticated" }, warnings: [] },
    });

    const workerToken = tokenFor({ id: workerAuthId, email: "reads-worker@example.test" });
    const worker = await auth.resolveActor(
      `${AUTH_TOKEN_COOKIE}=${encodeURIComponent(workerToken)}; ${WORKSPACE_COOKIE}=${workspaceId}`,
    );
    await expect(handleReadsGet(reads, worker, "me", {})).resolves.toEqual({
      httpStatus: 403,
      body: { status: "rejected", result: { code: "no_dashboard_membership" }, warnings: [] },
    });
  });

  it("reflects deactivation on the next read request", async () => {
    const personId = randomUUID();
    const authUserId = randomUUID();
    const email = `deactivated-${personId}@example.test`;
    await insertPerson({
      id: personId,
      authUserId,
      displayName: "Soon Inactive Supervisor",
      roleClass: "supervisor",
      email,
      locale: "de",
    });
    const session = await selectedResolution(authUserId, email);
    await expect(handleReadsGet(reads, session.resolved, "me", {})).resolves.toMatchObject({ httpStatus: 200 });

    await expect(
      kernel.dispatch(owner, {
        name: "person.deactivate",
        input: { person_id: personId, reason: "offboarded" },
        idempotencyKey: randomUUID(),
      }),
    ).resolves.toMatchObject({ status: "ok" });

    const nextResolution = await auth.resolveActor(session.cookies);
    await expect(handleReadsGet(reads, nextResolution, "me", {})).resolves.toEqual({
      httpStatus: 403,
      body: { status: "rejected", result: { code: "no_dashboard_membership" }, warnings: [] },
    });
  });

  it("rejects undeclared me params through its Zod params schema", async () => {
    const { resolved } = await selectedResolution(supervisorAuthId, "reads-supervisor@example.test");
    await expect(handleReadsGet(reads, resolved, "me", { date: "2026-07-13" })).resolves.toEqual({
      httpStatus: 400,
      body: { status: "rejected", result: { code: "validation_failed" }, warnings: [] },
    });
  });
});
