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
const dayWorkspaceId = randomUUID();
const dayOwnerId = randomUUID();
const dayManagerId = randomUUID();
const daySupervisorId = randomUUID();
const daySitelessSupervisorId = randomUUID();
const dayOutsideSupervisorId = randomUUID();
const dayWorkerAId = randomUUID();
const dayWorkerBId = randomUUID();
const dayOwnerAuthId = randomUUID();
const dayManagerAuthId = randomUUID();
const daySupervisorAuthId = randomUUID();
const daySitelessAuthId = randomUUID();
const alphaSiteId = randomUUID();
const betaSiteId = randomUUID();
const gammaSiteId = randomUUID();
const draftSiteId = randomUUID();
const alphaCoverageCommitmentId = randomUUID();
const alphaServiceCommitmentId = randomUUID();
const gammaCommitmentId = randomUUID();
const draftCommitmentId = randomUUID();
const alphaCoverageWindowId = randomUUID();
const alphaServiceWindowId = randomUUID();
const alphaTomorrowWindowId = randomUUID();
const gammaWindowId = randomUUID();
const draftWindowId = randomUUID();

const owner: Actor = { type: "person", id: ownerId, roleClass: "owner", workspaceId };

function tokenFor(identity: AuthIdentity): string {
  const token = `token:${identity.id}`;
  identities.set(token, identity);
  return token;
}

function cookieLine(changes: CookieChange[]): string {
  return changes.map((cookie) => `${cookie.name}=${encodeURIComponent(cookie.value)}`).join("; ");
}

async function selectedResolution(
  authUserId: string,
  email: string,
  selectedWorkspaceId = workspaceId,
): Promise<{ cookies: string; resolved: ActorResolution }> {
  const established = await auth.establish(tokenFor({ id: authUserId, email }), selectedWorkspaceId);
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
  workspaceId?: string;
}): Promise<void> {
  await admin.query(
    `INSERT INTO persons
       (id, workspace_id, display_name, role_class, auth_user_id, email, locale, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')`,
    [
      params.id,
      params.workspaceId ?? workspaceId,
      params.displayName,
      params.roleClass,
      params.authUserId,
      params.email,
      params.locale,
    ],
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

  await admin.query(
    `INSERT INTO workspaces (id, name, slug, plan_code, settings, status)
     VALUES ($1, 'Day Pack GmbH', $2, 'pilot', $3, 'active')`,
    [
      dayWorkspaceId,
      `${runTag}-day-pack`,
      JSON.stringify({
        tz: "Europe/Berlin",
        default_locale: "de",
        branding: {},
        action_policies: {},
        retention_months: 24,
      }),
    ],
  );
  for (const person of [
    { id: dayOwnerId, authUserId: dayOwnerAuthId, displayName: "Day Owner", roleClass: "owner", email: "day-owner@example.test" },
    { id: dayManagerId, authUserId: dayManagerAuthId, displayName: "Day Manager", roleClass: "manager", email: "day-manager@example.test" },
    { id: daySupervisorId, authUserId: daySupervisorAuthId, displayName: "Day Supervisor", roleClass: "supervisor", email: "day-supervisor@example.test" },
    { id: daySitelessSupervisorId, authUserId: daySitelessAuthId, displayName: "Siteless Supervisor", roleClass: "supervisor", email: "siteless@example.test" },
  ] as const) {
    await insertPerson({ ...person, locale: "de", workspaceId: dayWorkspaceId });
  }
  await admin.query(
    `INSERT INTO persons (id, workspace_id, display_name, role_class, locale, status)
     VALUES ($1, $4, 'Zara Worker', 'worker', 'de', 'active'),
            ($2, $4, 'Adam Worker', 'worker', 'de', 'inactive'),
            ($3, $4, 'Outside Supervisor', 'supervisor', 'de', 'active')`,
    [dayWorkerAId, dayWorkerBId, dayOutsideSupervisorId, dayWorkspaceId],
  );
  const dayClientId = randomUUID();
  await admin.query(
    "INSERT INTO clients (id, workspace_id, name, contact, status) VALUES ($1, $2, 'Day Client', '{}', 'active')",
    [dayClientId, dayWorkspaceId],
  );
  await admin.query(
    `INSERT INTO sites (id, workspace_id, client_id, name, address, settings, status)
     VALUES ($1, $5, $6, 'Alpha Site', '{}', $7, 'active'),
            ($2, $5, $6, 'Beta Empty Site', '{}', $7, 'active'),
            ($3, $5, $6, 'Gamma Outside Site', '{}', $8, 'active'),
            ($4, $5, $6, 'Draft Site', '{}', $7, 'draft')`,
    [
      alphaSiteId,
      betaSiteId,
      gammaSiteId,
      draftSiteId,
      dayWorkspaceId,
      dayClientId,
      { supervisor_person_ids: [daySupervisorId] },
      { supervisor_person_ids: [dayOutsideSupervisorId] },
    ],
  );
  for (const commitment of [
    { id: alphaCoverageCommitmentId, siteId: alphaSiteId, title: "Coverage Window", type: "coverage", target: "99", unit: null },
    { id: alphaServiceCommitmentId, siteId: alphaSiteId, title: "Service Window", type: "service_scope", target: null, unit: null },
    { id: gammaCommitmentId, siteId: gammaSiteId, title: "Outside Window", type: "output", target: "1", unit: "box" },
    { id: draftCommitmentId, siteId: draftSiteId, title: "Draft Window", type: "coverage", target: "1", unit: null },
  ] as const) {
    await admin.query(
      `INSERT INTO commitments
         (id, workspace_id, client_id, site_id, type, title, spec, schedule_rrule,
          target_qty, unit, verification, valid_from, valid_to, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'FREQ=DAILY', $8, $9,
               '{"proof":{"required":false}}', '2026-01-01', '2026-12-31', 'active')`,
      [
        commitment.id,
        dayWorkspaceId,
        dayClientId,
        commitment.siteId,
        commitment.type,
        commitment.title,
        commitment.type === "service_scope"
          ? { window_start_time: "08:00", window_end_time: "10:00", checklist: [{ key: "floor", label: "Floor" }] }
          : { window_start_time: "06:00", window_end_time: "07:00" },
        commitment.target,
        commitment.unit,
      ],
    );
  }
  const noProofRequirements = { verification: { proof: { required: false } } };
  const coverageFulfillment = {
    rule: "coverage_max", target_qty: 4, unit: null, confirmed_headcount: 0,
    satisfied: false, counted_record_ids: [], computed_at: fixedNow.toISOString(),
  };
  const serviceRequirements = {
    verification: { proof: { required: false } },
    checklist: [{ key: "floor", label: "Floor" }],
  };
  const serviceFulfillment = {
    rule: "checklist_completion", target_qty: null, unit: null,
    checklist_state: { items: [] }, satisfied: false, counted_record_ids: [],
    computed_at: fixedNow.toISOString(),
  };
  for (const window of [
    { id: alphaCoverageWindowId, commitmentId: alphaCoverageCommitmentId, siteId: alphaSiteId, date: "2026-07-13", starts: "2026-07-13T04:00:00Z", ends: "2026-07-13T05:00:00Z", target: "4", unit: null, requirements: noProofRequirements, fulfillment: coverageFulfillment, status: "open" },
    { id: alphaServiceWindowId, commitmentId: alphaServiceCommitmentId, siteId: alphaSiteId, date: "2026-07-13", starts: "2026-07-13T06:00:00Z", ends: "2026-07-13T08:00:00Z", target: null, unit: null, requirements: serviceRequirements, fulfillment: serviceFulfillment, status: "scheduled" },
    { id: alphaTomorrowWindowId, commitmentId: alphaCoverageCommitmentId, siteId: alphaSiteId, date: "2026-07-14", starts: "2026-07-14T04:00:00Z", ends: "2026-07-14T05:00:00Z", target: "4", unit: null, requirements: noProofRequirements, fulfillment: coverageFulfillment, status: "scheduled" },
    { id: gammaWindowId, commitmentId: gammaCommitmentId, siteId: gammaSiteId, date: "2026-07-13", starts: "2026-07-13T04:00:00Z", ends: "2026-07-13T05:00:00Z", target: "1", unit: "box", requirements: noProofRequirements, fulfillment: { rule: "output_sum", target_qty: 1, unit: "box", verified_qty: 0, satisfied: false, counted_record_ids: [], computed_at: fixedNow.toISOString() }, status: "open" },
    { id: draftWindowId, commitmentId: draftCommitmentId, siteId: draftSiteId, date: "2026-07-13", starts: "2026-07-13T04:00:00Z", ends: "2026-07-13T05:00:00Z", target: "1", unit: null, requirements: noProofRequirements, fulfillment: { ...coverageFulfillment, target_qty: 1 }, status: "open" },
  ] as const) {
    await admin.query(
      `INSERT INTO execution_windows
         (id, workspace_id, commitment_id, site_id, date, starts_at, ends_at,
          target_qty, unit, requirements, fulfillment, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [window.id, dayWorkspaceId, window.commitmentId, window.siteId, window.date, window.starts, window.ends, window.target, window.unit, window.requirements, window.fulfillment, window.status],
    );
  }
  await admin.query(
    `INSERT INTO assignments (id, workspace_id, window_id, person_id, role, status)
     VALUES ($1, $3, $4, $5, 'worker', 'planned'),
            ($2, $3, $4, $6, 'worker', 'removed')`,
    [randomUUID(), randomUUID(), dayWorkspaceId, alphaCoverageWindowId, dayWorkerAId, dayWorkerBId],
  );
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

describe("SLICE-015 populated day-pack", () => {
  it("orders equal-start windows by id across repeated reads", async () => {
    const firstWindowId = "00000000-0000-7000-8000-000000000001";
    const secondWindowId = "00000000-0000-7000-8000-000000000002";
    const sameStart = "2026-07-13T05:00:00Z";
    const sameEnd = "2026-07-13T06:00:00Z";
    const requirements = { verification: { proof: { required: false } } };
    const fulfillment = {
      rule: "coverage_max",
      target_qty: 4,
      unit: null,
      confirmed_headcount: 0,
      satisfied: false,
      counted_record_ids: [],
      computed_at: fixedNow.toISOString(),
    };
    await admin.query(
      `INSERT INTO execution_windows
         (id, workspace_id, commitment_id, site_id, date, starts_at, ends_at,
          target_qty, unit, requirements, fulfillment, status)
       VALUES ($1, $3, $4, $5, '2026-07-13', $6, $7, '4', NULL, $8, $9, 'open'),
              ($2, $3, $4, $5, '2026-07-13', $6, $7, '4', NULL, $8, $9, 'open')`,
      [
        firstWindowId,
        secondWindowId,
        dayWorkspaceId,
        alphaCoverageCommitmentId,
        alphaSiteId,
        sameStart,
        sameEnd,
        requirements,
        fulfillment,
      ],
    );

    try {
      const { resolved } = await selectedResolution(
        daySupervisorAuthId,
        "day-supervisor@example.test",
        dayWorkspaceId,
      );
      const observedOrders: string[][] = [];
      for (let read = 0; read < 2; read += 1) {
        const response = await handleReadsGet(reads, resolved, "me", {});
        expect(response.httpStatus).toBe(200);
        const body = response.body as {
          sites: Array<{ site_id: string; windows: Array<{ window_id: string }> }>;
        };
        observedOrders.push(
          body.sites
            .find((site) => site.site_id === alphaSiteId)
            ?.windows.map((window) => window.window_id)
            .filter((windowId) => windowId === firstWindowId || windowId === secondWindowId) ?? [],
        );
      }
      expect(observedOrders).toEqual([
        [firstWindowId, secondWindowId],
        [firstWindowId, secondWindowId],
      ]);
    } finally {
      await admin.query("DELETE FROM execution_windows WHERE id = ANY($1::uuid[])", [
        [firstWindowId, secondWindowId],
      ]);
    }
  });

  it("returns exactly the supervisor's active F12 sites, today's ordered windows, frozen values, assignments, and roster", async () => {
    const { resolved } = await selectedResolution(
      daySupervisorAuthId,
      "day-supervisor@example.test",
      dayWorkspaceId,
    );
    const response = await handleReadsGet(reads, resolved, "me", {});
    expect(response.httpStatus).toBe(200);
    const body = response.body as {
      date: string;
      sites: Array<{ site_id: string; name: string; windows: Array<Record<string, unknown>> }>;
      persons: Array<{ person_id: string; display_name: string; role_class: string }>;
    };
    expect(body.date).toBe("2026-07-13");
    expect(body.sites.map((site) => ({ id: site.site_id, name: site.name }))).toEqual([
      { id: alphaSiteId, name: "Alpha Site" },
      { id: betaSiteId, name: "Beta Empty Site" },
    ]);
    expect(body.sites[1]?.windows).toEqual([]);
    expect(body.sites[0]?.windows.map((window) => window.window_id)).toEqual([
      alphaCoverageWindowId,
      alphaServiceWindowId,
    ]);
    expect(body.sites[0]?.windows[0]).toMatchObject({
      commitment_id: alphaCoverageCommitmentId,
      title: "Coverage Window",
      type: "coverage",
      starts_at: "2026-07-13T04:00:00.000Z",
      ends_at: "2026-07-13T05:00:00.000Z",
      target_qty: 4,
      unit: null,
      requirements: { verification: { proof: { required: false } } },
      fulfillment: { rule: "coverage_max", confirmed_headcount: 0, target_qty: 4 },
      status: "open",
      assignments: [
        { person_id: dayWorkerBId, display_name: "Adam Worker", status: "removed" },
        { person_id: dayWorkerAId, display_name: "Zara Worker", status: "planned" },
      ],
    });
    expect(body.sites[0]?.windows[1]).toMatchObject({
      requirements: {
        verification: { proof: { required: false } },
        checklist: [{ key: "floor", label: "Floor" }],
      },
      fulfillment: { checklist_state: { items: [] } },
    });
    expect(body.persons).toEqual([
      { person_id: dayWorkerBId, display_name: "Adam Worker", role_class: "worker" },
      { person_id: dayWorkerAId, display_name: "Zara Worker", role_class: "worker" },
    ]);
  });

  it("returns all and only active workspace sites to managers and owners", async () => {
    for (const [authUserId, email] of [
      [dayManagerAuthId, "day-manager@example.test"],
      [dayOwnerAuthId, "day-owner@example.test"],
    ] as const) {
      const { resolved } = await selectedResolution(authUserId, email, dayWorkspaceId);
      const response = await handleReadsGet(reads, resolved, "me", {});
      expect(response).toMatchObject({ httpStatus: 200 });
      const body = response.body as { sites: Array<{ site_id: string }> };
      expect(body.sites.map((site) => site.site_id)).toEqual([alphaSiteId, betaSiteId, gammaSiteId]);
    }
  });

  it("resolves supervisor_person_ids fresh on every request", async () => {
    const { resolved } = await selectedResolution(
      daySupervisorAuthId,
      "day-supervisor@example.test",
      dayWorkspaceId,
    );
    await admin.query("UPDATE sites SET settings = $1 WHERE id = $2", [
      { supervisor_person_ids: [dayOutsideSupervisorId] },
      alphaSiteId,
    ]);
    await admin.query("UPDATE sites SET settings = $1 WHERE id = $2", [
      { supervisor_person_ids: [daySupervisorId] },
      gammaSiteId,
    ]);
    try {
      const response = await handleReadsGet(reads, resolved, "me", {});
      const body = response.body as { sites: Array<{ site_id: string }> };
      expect(body.sites.map((site) => site.site_id)).toEqual([betaSiteId, gammaSiteId]);
    } finally {
      await admin.query("UPDATE sites SET settings = $1 WHERE id = $2", [
        { supervisor_person_ids: [daySupervisorId] },
        alphaSiteId,
      ]);
      await admin.query("UPDATE sites SET settings = $1 WHERE id = $2", [
        { supervisor_person_ids: [dayOutsideSupervisorId] },
        gammaSiteId,
      ]);
    }
  });

  it("returns the canonical empty-day shape for a siteless supervisor", async () => {
    const { resolved } = await selectedResolution(daySitelessAuthId, "siteless@example.test", dayWorkspaceId);
    await expect(handleReadsGet(reads, resolved, "me", {})).resolves.toEqual({
      httpStatus: 200,
      body: {
        date: "2026-07-13",
        generated_at: fixedNow.toISOString(),
        sites: [],
        persons: [],
        labels: { title: "Erfassung" },
        person_id: daySitelessSupervisorId,
        display_name: "Siteless Supervisor",
        role_class: "supervisor",
        workspace_id: dayWorkspaceId,
        workspace_display_name: "Day Pack GmbH",
      },
    });
  });
});
