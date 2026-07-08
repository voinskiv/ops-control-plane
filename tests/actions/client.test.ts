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
const managerId = randomUUID();
const supervisorId = randomUUID();
const workerId = randomUUID();
const runTag = `test-client-${randomUUID().slice(0, 8)}`;

const manager = { type: "person", id: managerId, roleClass: "manager", workspaceId } as const satisfies Actor;
const supervisor = { type: "person", id: supervisorId, roleClass: "supervisor", workspaceId } as const satisfies Actor;
const worker = { type: "person", id: workerId, roleClass: "worker", workspaceId } as const satisfies Actor;

function freshKey(): string {
  return `client:${randomUUID()}`;
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

async function clientRow(clientId: string): Promise<{ id: string; name: string; contact: unknown; status: string } | null> {
  const res = await admin.query<{ id: string; name: string; contact: unknown; status: string }>(
    "SELECT id, name, contact, status FROM clients WHERE id = $1",
    [clientId],
  );
  return res.rows[0] ?? null;
}

async function insertClient(status: "active" | "archived" = "active"): Promise<string> {
  const id = randomUUID();
  await admin.query(
    "INSERT INTO clients (id, workspace_id, name, contact, status) VALUES ($1, $2, 'Fixture Client', '{}', $3)",
    [id, workspaceId, status],
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

beforeAll(async () => {
  const url = inject("databaseUrl");
  admin = await connect(url);
  kernelDb = createKernelDb(url);
  kernel = new Kernel(kernelDb, registry, noopUnlimitedResolver);

  await admin.query(
    `INSERT INTO workspaces (id, name, slug, plan_code, settings, status)
     VALUES ($1, 'Client Test GmbH', $2, 'pilot', '{}', 'active')`,
    [workspaceId, runTag],
  );
  await admin.query(
    `INSERT INTO persons (id, workspace_id, display_name, role_class, locale, status)
     VALUES ($1, $2, 'Manager Actor', 'manager', 'de', 'active'),
            ($3, $2, 'Supervisor Actor', 'supervisor', 'de', 'active'),
            ($4, $2, 'Worker Actor', 'worker', 'de', 'active')`,
    [managerId, workspaceId, supervisorId, workerId],
  );
});

afterAll(async () => {
  await kernelDb.end();
  await admin.end();
});

describe("client.create (SLICE-007)", () => {
  it("creates an active client with contact, audits, and replays byte-identically", async () => {
    const key = freshKey();
    const input = { name: "  Ada Client  ", contact: { email: "hi@example.test" } };
    const first = await dispatch(manager, "client.create", input, key);
    const replay = await dispatch(manager, "client.create", input, key);
    expect(first.status).toBe("ok");
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));

    const clientId = (first.result as { client_id?: string }).client_id ?? "";
    const client = await clientRow(clientId);
    expect(client).toMatchObject({ name: "Ada Client", status: "active" });

    const events = await auditEventsFor((await invocationRow(key))?.id ?? "");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: "client.create" });
  });

  it("rejects out-of-threshold actors (supervisor, worker below minHumanRole=manager)", async () => {
    for (const actor of [supervisor, worker]) {
      await expect(dispatch(actor, "client.create", { name: "No" })).resolves.toMatchObject({
        status: "rejected",
        result: { code: "unauthorized" },
      });
    }
  });
});

describe("client.update (SLICE-007)", () => {
  it("patches only present fields and audits", async () => {
    const clientId = await insertClient();
    const key = freshKey();
    const input = { client_id: clientId, name: "Renamed Client" };
    const first = await dispatch(manager, "client.update", input, key);
    expect(first.status).toBe("ok");
    expect(await clientRow(clientId)).toMatchObject({ name: "Renamed Client" });

    const events = await auditEventsFor((await invocationRow(key))?.id ?? "");
    expect(events[0]).toMatchObject({ action: "client.update", before: { name: "Fixture Client" }, after: { name: "Renamed Client" } });
  });

  it("rejects an empty patch", async () => {
    const clientId = await insertClient();
    await expect(dispatch(manager, "client.update", { client_id: clientId })).resolves.toMatchObject({
      status: "rejected",
      result: { code: "validation_failed" },
    });
  });
});

describe("client.archive (SLICE-007, DEC-009 Q5)", () => {
  it("archives a client with no sites", async () => {
    const clientId = await insertClient();
    const key = freshKey();
    const first = await dispatch(manager, "client.archive", { client_id: clientId }, key);
    expect(first.status).toBe("ok");
    expect(await clientRow(clientId)).toMatchObject({ status: "archived" });
  });

  it("archives a client whose sites are all archived", async () => {
    const clientId = await insertClient();
    await insertSite(clientId, "archived");
    const first = await dispatch(manager, "client.archive", { client_id: clientId });
    expect(first.status).toBe("ok");
  });

  it("rejects when the client has a non-archived (draft or active) site — no cascade", async () => {
    const draftClientId = await insertClient();
    await insertSite(draftClientId, "draft");
    const draftKey = freshKey();
    await expect(dispatch(manager, "client.archive", { client_id: draftClientId }, draftKey)).resolves.toMatchObject({
      status: "rejected",
      result: { code: "client_has_active_sites" },
    });
    expect(await clientRow(draftClientId)).toMatchObject({ status: "active" });
    expect(await auditEventsFor((await invocationRow(draftKey))?.id ?? "")).toEqual([]);

    const activeClientId = await insertClient();
    await insertSite(activeClientId, "active");
    await expect(dispatch(manager, "client.archive", { client_id: activeClientId })).resolves.toMatchObject({
      status: "rejected",
      result: { code: "client_has_active_sites" },
    });
    expect(await clientRow(activeClientId)).toMatchObject({ status: "active" });
  });
});
