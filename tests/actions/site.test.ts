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
const ownerId = randomUUID();
const managerId = randomUUID();
const supervisorId = randomUUID();
const workerId = randomUUID();
const otherSupervisorId = randomUUID();
const inactiveSupervisorId = randomUUID();
const otherWorkspaceId = randomUUID();
const crossWorkspaceSupervisorId = randomUUID();
const runTag = `test-site-${randomUUID().slice(0, 8)}`;

const owner = { type: "person", id: ownerId, roleClass: "owner", workspaceId } as const satisfies Actor;
const manager = { type: "person", id: managerId, roleClass: "manager", workspaceId } as const satisfies Actor;
const supervisor = { type: "person", id: supervisorId, roleClass: "supervisor", workspaceId } as const satisfies Actor;
const worker = { type: "person", id: workerId, roleClass: "worker", workspaceId } as const satisfies Actor;
const agent = { type: "agent", id: randomUUID(), agentCode: "site_test_agent", workspaceId } as const satisfies Actor;

function freshKey(): string {
  return `site:${randomUUID()}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function dispatch(actor: Actor, name: string, input: unknown, idempotencyKey = freshKey()): Promise<ResponseEnvelope> {
  return kernel.dispatch(actor, { name, input, idempotencyKey });
}

async function invocationRow(key: string): Promise<{ id: string; status: string } | null> {
  const res = await admin.query<{ id: string; status: string }>(
    "SELECT id, status FROM action_invocations WHERE idempotency_key = $1",
    [key],
  );
  return res.rows[0] ?? null;
}

async function auditEventsFor(invocationId: string): Promise<{ action: string; before: unknown; after: unknown; extras: unknown }[]> {
  const res = await admin.query<{ action: string; before: unknown; after: unknown; extras: unknown }>(
    "SELECT action, before, after, extras FROM audit_events WHERE invocation_id = $1 ORDER BY created_at, id",
    [invocationId],
  );
  return res.rows;
}

async function siteRow(
  siteId: string,
): Promise<{ id: string; name: string; address: unknown; settings: unknown; status: string } | null> {
  const res = await admin.query<{ id: string; name: string; address: unknown; settings: unknown; status: string }>(
    "SELECT id, name, address, settings, status FROM sites WHERE id = $1",
    [siteId],
  );
  return res.rows[0] ?? null;
}

async function insertClient(status: "active" | "archived" = "active", ws = workspaceId): Promise<string> {
  const id = randomUUID();
  await admin.query(
    "INSERT INTO clients (id, workspace_id, name, contact, status) VALUES ($1, $2, 'Fixture Client', '{}', $3)",
    [id, ws, status],
  );
  return id;
}

async function insertSite(clientId: string, status: "draft" | "active" | "archived"): Promise<string> {
  const id = randomUUID();
  await admin.query(
    `INSERT INTO sites (id, workspace_id, client_id, name, address, settings, status)
     VALUES ($1, $2, $3, 'Fixture Site', '{}', '{}', $4)`,
    [id, workspaceId, clientId, status],
  );
  return id;
}

async function activeSiteCount(ws = workspaceId): Promise<number> {
  const res = await admin.query<{ n: string }>(
    "SELECT count(*) AS n FROM sites WHERE workspace_id = $1 AND status = 'active'",
    [ws],
  );
  return Number(res.rows[0]?.n ?? 0);
}

async function siteCountForClient(clientId: string): Promise<number> {
  const res = await admin.query<{ n: string }>("SELECT count(*) AS n FROM sites WHERE client_id = $1", [clientId]);
  return Number(res.rows[0]?.n ?? 0);
}

beforeAll(async () => {
  const url = inject("databaseUrl");
  admin = await connect(url);
  kernelDb = createKernelDb(url);
  kernel = new Kernel(kernelDb, registry, noopUnlimitedResolver);

  await admin.query(
    `INSERT INTO workspaces (id, name, slug, plan_code, settings, status)
     VALUES ($1, 'Site Test GmbH', $2, 'pilot', '{}', 'active')`,
    [workspaceId, runTag],
  );
  await admin.query(
    `INSERT INTO workspaces (id, name, slug, plan_code, settings, status)
     VALUES ($1, 'Site Test Other GmbH', $2, 'pilot', '{}', 'active')`,
    [otherWorkspaceId, `${runTag}-other`],
  );
  await admin.query(
    `INSERT INTO persons (id, workspace_id, display_name, role_class, locale, status)
     VALUES
       ($1, $2, 'Owner Actor', 'owner', 'de', 'active'),
       ($3, $2, 'Manager Actor', 'manager', 'de', 'active'),
       ($4, $2, 'Supervisor Actor', 'supervisor', 'de', 'active'),
       ($5, $2, 'Worker Actor', 'worker', 'de', 'active'),
       ($6, $2, 'Other Supervisor', 'supervisor', 'de', 'active'),
       ($7, $2, 'Inactive Supervisor', 'supervisor', 'de', 'inactive')`,
    [ownerId, workspaceId, managerId, supervisorId, workerId, otherSupervisorId, inactiveSupervisorId],
  );
  await admin.query(
    `INSERT INTO persons (id, workspace_id, display_name, role_class, locale, status)
     VALUES ($1, $2, 'Cross Workspace Supervisor', 'supervisor', 'de', 'active')`,
    [crossWorkspaceSupervisorId, otherWorkspaceId],
  );
});

afterAll(async () => {
  await kernelDb.end();
  await admin.end();
});

describe("site.create (SLICE-007, DEC-009 Q1/Q2)", () => {
  it("writes status='draft', not 'active' — the §9 meter does not count it", async () => {
    const clientId = await insertClient();
    const before = await activeSiteCount();
    const key = freshKey();
    const first = await dispatch(manager, "site.create", { client_id: clientId, name: "New Site" }, key);
    expect(first.status).toBe("ok");

    const siteId = (first.result as { site_id?: string }).site_id ?? "";
    const site = await siteRow(siteId);
    expect(site).toMatchObject({ name: "New Site", status: "draft" });
    expect(await activeSiteCount()).toBe(before);

    const events = await auditEventsFor((await invocationRow(key))?.id ?? "");
    expect(events[0]).toMatchObject({ action: "site.create" });
    expect((events[0]?.after as { status?: string } | null)?.status).toBe("draft");
  });

  it("persists valid supervisor_person_ids and round-trips them", async () => {
    const clientId = await insertClient();
    const first = await dispatch(manager, "site.create", {
      client_id: clientId,
      name: "Supervised Site",
      supervisor_person_ids: [supervisorId, otherSupervisorId],
    });
    expect(first.status).toBe("ok");
    const siteId = (first.result as { site_id?: string }).site_id ?? "";
    const site = await siteRow(siteId);
    expect((site?.settings as { supervisor_person_ids?: string[] } | null)?.supervisor_person_ids?.sort()).toEqual(
      [supervisorId, otherSupervisorId].sort(),
    );
  });

  it("rejects supervisor_person_ids that are not existing/active/in-workspace/role_class=supervisor (DEC-009 Q3)", async () => {
    const clientId = await insertClient();
    const cases = [
      { label: "unknown id", ids: [randomUUID()] },
      { label: "worker role", ids: [workerId] },
      { label: "inactive supervisor", ids: [inactiveSupervisorId] },
      { label: "cross-workspace supervisor", ids: [crossWorkspaceSupervisorId] },
    ];
    for (const { ids } of cases) {
      await expect(
        dispatch(manager, "site.create", { client_id: clientId, name: "Rejected Site", supervisor_person_ids: ids }),
      ).resolves.toMatchObject({ status: "rejected", result: { code: "validation_failed" } });
    }
  });

  it("rejects out-of-threshold actors (supervisor, worker below minHumanRole=manager)", async () => {
    const clientId = await insertClient();
    for (const actor of [supervisor, worker]) {
      await expect(dispatch(actor, "site.create", { client_id: clientId, name: "No" })).resolves.toMatchObject({
        status: "rejected",
        result: { code: "unauthorized" },
      });
    }
  });

  it("serializes site.create against an in-flight client archive status update", async () => {
    const clientId = await insertClient();
    const locker = await connect(inject("databaseUrl"));
    await locker.query("BEGIN");
    try {
      await locker.query("UPDATE clients SET status = 'archived' WHERE id = $1", [clientId]);
      let settled = false;
      const create = dispatch(manager, "site.create", { client_id: clientId, name: "Race Site" }).then((envelope) => {
        settled = true;
        return envelope;
      });

      await delay(100);
      expect(settled).toBe(false);
      await locker.query("COMMIT");

      await expect(create).resolves.toMatchObject({ status: "rejected", result: { code: "validation_failed" } });
      expect(await siteCountForClient(clientId)).toBe(0);
    } finally {
      await locker.query("ROLLBACK").catch(() => undefined);
      await locker.end();
    }
  });
});

describe("site.update (SLICE-007)", () => {
  it("patches supervisor_person_ids, replacing the array wholesale, and audits", async () => {
    const clientId = await insertClient();
    const siteId = await insertSite(clientId, "draft");
    const key = freshKey();
    const first = await dispatch(manager, "site.update", { site_id: siteId, supervisor_person_ids: [supervisorId] }, key);
    expect(first.status).toBe("ok");
    const site = await siteRow(siteId);
    expect((site?.settings as { supervisor_person_ids?: string[] } | null)?.supervisor_person_ids).toEqual([supervisorId]);
  });

  it("rejects invalid supervisor_person_ids on update too", async () => {
    const clientId = await insertClient();
    const siteId = await insertSite(clientId, "draft");
    await expect(
      dispatch(manager, "site.update", { site_id: siteId, supervisor_person_ids: [workerId] }),
    ).resolves.toMatchObject({ status: "rejected", result: { code: "validation_failed" } });
  });
});

describe("site.activate (SLICE-007, DEC-009 Q1)", () => {
  it("is human_only — agent actors are rejected", async () => {
    const clientId = await insertClient();
    const siteId = await insertSite(clientId, "draft");
    await expect(dispatch(agent, "site.activate", { site_id: siteId })).resolves.toMatchObject({
      status: "rejected",
      result: { code: "unauthorized" },
    });
    expect(await siteRow(siteId)).toMatchObject({ status: "draft" });
  });

  it("transitions draft→active, writes meter-delta audit extras, and the meter count increments by exactly one", async () => {
    const clientId = await insertClient();
    const siteId = await insertSite(clientId, "draft");
    const before = await activeSiteCount();
    const key = freshKey();

    const first = await dispatch(manager, "site.activate", { site_id: siteId }, key);
    expect(first.status).toBe("ok");
    expect(await siteRow(siteId)).toMatchObject({ status: "active" });
    expect(await activeSiteCount()).toBe(before + 1);

    const events = await auditEventsFor((await invocationRow(key))?.id ?? "");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "site.activate",
      before: { status: "draft" },
      after: { status: "active" },
      extras: { meter_delta: { metric: "active_sites", delta: 1, active_sites_after: before + 1 } },
    });
  });

  it("rejects activating a non-draft site (already active, or archived)", async () => {
    const clientId = await insertClient();
    const activeSiteId = await insertSite(clientId, "active");
    await expect(dispatch(manager, "site.activate", { site_id: activeSiteId })).resolves.toMatchObject({
      status: "rejected",
      result: { code: "validation_failed" },
    });

    const archivedSiteId = await insertSite(clientId, "archived");
    await expect(dispatch(manager, "site.activate", { site_id: archivedSiteId })).resolves.toMatchObject({
      status: "rejected",
      result: { code: "validation_failed" },
    });
  });

  it("rejects activating a draft site whose client is archived, without moving the meter", async () => {
    const clientId = await insertClient("archived");
    const siteId = await insertSite(clientId, "draft");
    const before = await activeSiteCount();
    const key = freshKey();

    await expect(dispatch(manager, "site.activate", { site_id: siteId }, key)).resolves.toMatchObject({
      status: "rejected",
      result: { code: "validation_failed" },
    });
    expect(await siteRow(siteId)).toMatchObject({ status: "draft" });
    expect(await activeSiteCount()).toBe(before);
    expect(await auditEventsFor((await invocationRow(key))?.id ?? "")).toEqual([]);
  });

  it("owner may also activate (role inheritance, F6)", async () => {
    const clientId = await insertClient();
    const siteId = await insertSite(clientId, "draft");
    await expect(dispatch(owner, "site.activate", { site_id: siteId })).resolves.toMatchObject({ status: "ok" });
  });
});

describe("site.archive (deferred, DEC-008/DEC-009)", () => {
  it("is registered (§21.2 exact catalog match) but its handler is not implemented — errors without mutating or leaking audit", async () => {
    const clientId = await insertClient();
    const siteId = await insertSite(clientId, "active");
    const key = freshKey();
    const envelope = await dispatch(manager, "site.archive", { site_id: siteId }, key);
    expect(envelope).toMatchObject({ status: "error", result: { code: "internal_error" } });
    expect(await siteRow(siteId)).toMatchObject({ status: "active" });
    const row = await invocationRow(key);
    expect(row?.status).toBe("error");
    expect(await auditEventsFor(row?.id ?? "")).toEqual([]);
  });
});
