// SLICE-003 kernel tests:
// §20.1 unknown action → typed rejection; every registered action has a Zod schema.
// §20.2 replay → one action_invocations row, one execution, byte-identical envelope.
// §20.3 property test over the registry: every executed action yields ≥1
//       audit_event committed in the same transaction.
// §21.3 pipeline effects: authorize/threshold/validation rejections, F13
//       (app_kernel + workspace GUC), F4 (kernel_op), F24/F30 (idempotency),
//       §6 (no audit → no commit).
// Test actions are registered into a test-local registry; production actions
// join the application registry from SLICE-005 onward.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";

import { noopUnlimitedResolver } from "@core/actions/entitlement";
import { handleActionsPost } from "@core/actions/http";
import { Kernel } from "@core/actions/kernel";
import { ActionRegistry } from "@core/actions/registry";
import type { Actor, ResponseEnvelope } from "@core/actions/types";
import { connect, type DbClient } from "@core/db/client";
import { createKernelDb, type KernelDb } from "@core/db/kernel";

let admin: DbClient;
let kernelDb: KernelDb;
let kernel: Kernel;
const registry = new ActionRegistry();

const workspaceId = randomUUID();
const siteId = randomUUID();
const windowId = randomUUID();
const runTag = `test-kernel-${randomUUID().slice(0, 8)}`;

const manager = { type: "person", id: randomUUID(), roleClass: "manager", workspaceId } as const satisfies Actor;
const supervisor = { type: "person", id: randomUUID(), roleClass: "supervisor", workspaceId } as const satisfies Actor;
const owner = { type: "person", id: randomUUID(), roleClass: "owner", workspaceId } as const satisfies Actor;
const agent = { type: "agent", id: randomUUID(), agentCode: "test_agent", workspaceId } as const satisfies Actor;

function freshKey(): string {
  return `test:${randomUUID()}`;
}

async function adminInsertVerifiedRecord(): Promise<string> {
  const recordId = randomUUID();
  await admin.query(
    `INSERT INTO execution_records (id, workspace_id, window_id, kind, qty, unit,
       occurred_at, received_at, captured_by_actor, client_key, status)
     VALUES ($1, $2, $3, 'coverage_confirm', 1, 'persons', now(), now(), $4, $5, 'verified')`,
    [recordId, workspaceId, windowId, JSON.stringify({ actor_type: "person", actor_id: manager.id }), randomUUID()],
  );
  return recordId;
}

async function invocationRow(
  key: string,
): Promise<{ id: string; status: string; result: ResponseEnvelope | null; input_hash: string } | null> {
  const res = await admin.query<{
    id: string;
    status: string;
    result: ResponseEnvelope | null;
    input_hash: string;
  }>("SELECT id, status, result, input_hash FROM action_invocations WHERE workspace_id = $1 AND idempotency_key = $2", [
    workspaceId,
    key,
  ]);
  return res.rows[0] ?? null;
}

async function auditEventsFor(invocationId: string): Promise<
  { actor_type: string; actor_id: string | null; action: string; entity_type: string; entity_id: string; extras: unknown }[]
> {
  const res = await admin.query<{
    actor_type: string;
    actor_id: string | null;
    action: string;
    entity_type: string;
    entity_id: string;
    extras: unknown;
  }>(
    "SELECT actor_type, actor_id, action, entity_type, entity_id, extras FROM audit_events WHERE invocation_id = $1",
    [invocationId],
  );
  return res.rows;
}

async function clientCount(clientId: string): Promise<number> {
  const res = await admin.query<{ n: string }>("SELECT count(*) AS n FROM clients WHERE id = $1", [clientId]);
  return Number(res.rows[0]?.n ?? 0);
}

registry.register({
  name: "test.client_create",
  actors: { minHumanRole: "manager", system: true },
  threshold: "autonomous_safe",
  input: z.object({ id: z.uuid(), name: z.string().min(1) }),
  async execute(ctx, input) {
    await ctx.tx.query(
      "INSERT INTO clients (id, workspace_id, name, contact, status) VALUES ($1, $2, $3, '{}', 'active')",
      [input.id, ctx.workspaceId, input.name],
    );
    return {
      result: { clientId: input.id },
      audit: [
        {
          entityType: "clients",
          entityId: input.id,
          after: { name: input.name, status: "active" },
          extras: { note: "kernel-test" },
        },
      ],
    };
  },
});

registry.register({
  name: "test.proposal_gated_create",
  actors: { minHumanRole: "manager" },
  threshold: "proposal_gated",
  input: z.object({ id: z.uuid() }),
  async execute(ctx, input) {
    await ctx.tx.query(
      "INSERT INTO clients (id, workspace_id, name, contact, status) VALUES ($1, $2, 'Gated', '{}', 'active')",
      [input.id, ctx.workspaceId],
    );
    return { result: null, audit: [{ entityType: "clients", entityId: input.id }] };
  },
});

registry.register({
  name: "test.env_probe",
  actors: { minHumanRole: "supervisor", system: true },
  threshold: "autonomous_safe",
  input: z.object({}),
  async execute(ctx) {
    const res = await ctx.tx.query<{ current_user: string; ws: string | null; op: string | null }>(
      "SELECT current_user, current_setting('app.workspace_id', true) AS ws, current_setting('app.kernel_op', true) AS op",
    );
    const row = res.rows[0];
    return {
      result: { currentUser: row?.current_user, workspaceGuc: row?.ws, kernelOpGuc: row?.op },
      audit: [{ entityType: "workspaces", entityId: ctx.workspaceId ?? "" }],
    };
  },
});

registry.register({
  name: "test.owner_only",
  actors: { minHumanRole: "owner" },
  threshold: "human_only",
  input: z.object({}),
  async execute(ctx) {
    return { result: null, audit: [{ entityType: "workspaces", entityId: ctx.workspaceId ?? "" }] };
  },
});

registry.register({
  name: "test.record_void",
  actors: { minHumanRole: "manager" },
  threshold: "human_only",
  input: z.object({ recordId: z.uuid() }),
  async execute(ctx, input) {
    // Proves the kernel sets app.kernel_op: this status-only UPDATE passes the
    // F4 trigger only inside a kernel transaction.
    await ctx.tx.query("UPDATE execution_records SET status = 'voided' WHERE id = $1", [input.recordId]);
    return {
      result: { recordId: input.recordId },
      audit: [
        {
          entityType: "execution_records",
          entityId: input.recordId,
          before: { status: "verified" },
          after: { status: "voided" },
          extras: { reason: "kernel-test" },
        },
      ],
    };
  },
});

registry.register({
  name: "test.fail_after_write",
  actors: { minHumanRole: "manager" },
  threshold: "autonomous_safe",
  input: z.object({ id: z.uuid() }),
  async execute(ctx, input) {
    await ctx.tx.query(
      "INSERT INTO clients (id, workspace_id, name, contact, status) VALUES ($1, $2, 'Doomed', '{}', 'active')",
      [input.id, ctx.workspaceId],
    );
    throw new Error("intentional failure after write");
  },
});

registry.register({
  name: "test.no_audit",
  actors: { minHumanRole: "manager" },
  threshold: "autonomous_safe",
  input: z.object({ id: z.uuid() }),
  async execute(ctx, input) {
    await ctx.tx.query(
      "INSERT INTO clients (id, workspace_id, name, contact, status) VALUES ($1, $2, 'Unaudited', '{}', 'active')",
      [input.id, ctx.workspaceId],
    );
    return { result: null, audit: [] };
  },
});

beforeAll(async () => {
  const url = inject("databaseUrl");
  admin = await connect(url);
  kernelDb = createKernelDb(url);
  kernel = new Kernel(kernelDb, registry, noopUnlimitedResolver);

  const clientId = randomUUID();
  const commitmentId = randomUUID();
  await admin.query(
    `INSERT INTO workspaces (id, name, slug, plan_code, settings, status)
     VALUES ($1, 'Kernel Test GmbH', $2, 'pilot', '{}', 'active')`,
    [workspaceId, runTag],
  );
  await admin.query(
    "INSERT INTO clients (id, workspace_id, name, contact, status) VALUES ($1, $2, 'Fixture Client', '{}', 'active')",
    [clientId, workspaceId],
  );
  await admin.query(
    `INSERT INTO sites (id, workspace_id, client_id, name, address, settings, status)
     VALUES ($1, $2, $3, 'Fixture Site', '{}', '{}', 'active')`,
    [siteId, workspaceId, clientId],
  );
  await admin.query(
    `INSERT INTO commitments (id, workspace_id, client_id, site_id, type, title, spec,
       schedule_rrule, target_qty, unit, verification, valid_from, valid_to, status)
     VALUES ($1, $2, $3, $4, 'coverage', 'Fixture', '{}', 'FREQ=DAILY', 1, 'persons',
       '{}', '2026-07-01', '2026-12-31', 'active')`,
    [commitmentId, workspaceId, clientId, siteId],
  );
  await admin.query(
    `INSERT INTO execution_windows (id, workspace_id, commitment_id, site_id, date,
       starts_at, ends_at, target_qty, unit, requirements, fulfillment, status)
     VALUES ($1, $2, $3, $4, '2026-07-06', '2026-07-06T06:00:00Z', '2026-07-06T14:00:00Z',
       1, 'persons', '{}', '{}', 'open')`,
    [windowId, workspaceId, commitmentId, siteId],
  );
});

afterAll(async () => {
  await kernelDb.end();
  await admin.end();
});

describe("dispatch rejections (§20.1, §21.3)", () => {
  it("unknown action → typed rejection, persisted, replay-stable", async () => {
    const key = freshKey();
    const first = await kernel.dispatch(manager, { name: "test.does_not_exist", input: {}, idempotencyKey: key });
    expect(first).toMatchObject({ status: "rejected", result: { code: "unknown_action" } });
    const row = await invocationRow(key);
    expect(row?.status).toBe("rejected");
    const replay = await kernel.dispatch(manager, { name: "test.does_not_exist", input: {}, idempotencyKey: key });
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
  });

  it("every registered action has a Zod input schema (§20.1)", () => {
    const definitions = registry.list();
    expect(definitions.length).toBeGreaterThan(0);
    for (const definition of definitions) {
      expect(typeof definition.input.safeParse, `${definition.name} input schema`).toBe("function");
    }
  });

  it("insufficient role → unauthorized, no execution", async () => {
    const key = freshKey();
    const envelope = await kernel.dispatch(supervisor, { name: "test.owner_only", input: {}, idempotencyKey: key });
    expect(envelope).toMatchObject({ status: "rejected", result: { code: "unauthorized" } });
    const row = await invocationRow(key);
    expect(row?.status).toBe("rejected");
    expect(await auditEventsFor(row?.id ?? "")).toEqual([]);
  });

  it("owner inherits manager-level grants (F6)", async () => {
    const id = randomUUID();
    const envelope = await kernel.dispatch(owner, {
      name: "test.client_create",
      input: { id, name: "Owner Created" },
      idempotencyKey: freshKey(),
    });
    expect(envelope.status).toBe("ok");
    expect(await clientCount(id)).toBe(1);
  });

  it("invalid input → validation_failed, persisted, nothing mutated", async () => {
    const key = freshKey();
    const envelope = await kernel.dispatch(manager, {
      name: "test.client_create",
      input: { id: "not-a-uuid", name: "" },
      idempotencyKey: key,
    });
    expect(envelope).toMatchObject({ status: "rejected", result: { code: "validation_failed" } });
    expect((await invocationRow(key))?.status).toBe("rejected");
  });

  it("agent on a proposal_gated action → typed rejection, zero mutation (F2)", async () => {
    const id = randomUUID();
    const envelope = await kernel.dispatch(agent, {
      name: "test.proposal_gated_create",
      input: { id },
      idempotencyKey: freshKey(),
    });
    expect(envelope).toMatchObject({ status: "rejected", result: { code: "proposal_gating_unavailable" } });
    expect(await clientCount(id)).toBe(0);
  });

  it("proposal_gated governs agents only — humans execute directly (§5)", async () => {
    const id = randomUUID();
    const envelope = await kernel.dispatch(manager, {
      name: "test.proposal_gated_create",
      input: { id },
      idempotencyKey: freshKey(),
    });
    expect(envelope.status).toBe("ok");
    expect(await clientCount(id)).toBe(1);
  });
});

describe("idempotency (§20.2, F24, F30)", () => {
  it("replay: one row, one execution, byte-identical envelope", async () => {
    const key = freshKey();
    const id = randomUUID();
    const input = { id, name: "Replayed Client" };
    const first = await kernel.dispatch(manager, { name: "test.client_create", input, idempotencyKey: key });
    const second = await kernel.dispatch(manager, { name: "test.client_create", input, idempotencyKey: key });
    expect(first.status).toBe("ok");
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(await clientCount(id)).toBe(1);
    const rows = await admin.query<{ n: string }>(
      "SELECT count(*) AS n FROM action_invocations WHERE workspace_id = $1 AND idempotency_key = $2",
      [workspaceId, key],
    );
    expect(Number(rows.rows[0]?.n)).toBe(1);
  });

  it("same key + different input_hash → typed rejection, original untouched", async () => {
    const key = freshKey();
    const id = randomUUID();
    const first = await kernel.dispatch(manager, {
      name: "test.client_create",
      input: { id, name: "Original" },
      idempotencyKey: key,
    });
    const conflicting = await kernel.dispatch(manager, {
      name: "test.client_create",
      input: { id: randomUUID(), name: "Different" },
      idempotencyKey: key,
    });
    expect(conflicting).toMatchObject({ status: "rejected", result: { code: "idempotency_conflict" } });
    const replay = await kernel.dispatch(manager, {
      name: "test.client_create",
      input: { id, name: "Original" },
      idempotencyKey: key,
    });
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
  });

  it("input hashing is key-order independent", async () => {
    const key = freshKey();
    const id = randomUUID();
    await kernel.dispatch(manager, { name: "test.client_create", input: { id, name: "Ordered" }, idempotencyKey: key });
    const replay = await kernel.dispatch(manager, {
      name: "test.client_create",
      input: { name: "Ordered", id },
      idempotencyKey: key,
    });
    expect(replay.status).toBe("ok");
    expect(await clientCount(id)).toBe(1);
  });
});

describe("kernel transaction guarantees (§6, §21.3, F13, F4)", () => {
  it("runs as app_kernel with the workspace GUC set per transaction (F13)", async () => {
    const envelope = await kernel.dispatch(supervisor, { name: "test.env_probe", input: {}, idempotencyKey: freshKey() });
    expect(envelope.result).toMatchObject({
      currentUser: "app_kernel",
      workspaceGuc: workspaceId,
      kernelOpGuc: "test.env_probe",
    });
  });

  it("kernel transactions pass the F4 trigger for status-only fact transitions", async () => {
    const recordId = await adminInsertVerifiedRecord();
    const envelope = await kernel.dispatch(manager, {
      name: "test.record_void",
      input: { recordId },
      idempotencyKey: freshKey(),
    });
    expect(envelope.status).toBe("ok");
    const res = await admin.query<{ status: string }>("SELECT status FROM execution_records WHERE id = $1", [recordId]);
    expect(res.rows[0]?.status).toBe("voided");
  });

  it("an executing action that throws rolls back its writes; the error outcome persists and replays (F30)", async () => {
    const key = freshKey();
    const id = randomUUID();
    const envelope = await kernel.dispatch(manager, { name: "test.fail_after_write", input: { id }, idempotencyKey: key });
    expect(envelope).toMatchObject({ status: "error", result: { code: "internal_error" } });
    expect(await clientCount(id)).toBe(0);
    const row = await invocationRow(key);
    expect(row?.status).toBe("error");
    const replay = await kernel.dispatch(manager, { name: "test.fail_after_write", input: { id }, idempotencyKey: key });
    expect(JSON.stringify(replay)).toBe(JSON.stringify(envelope));
    expect(await clientCount(id)).toBe(0);
  });

  it("an action that writes no audit event does not commit (§6)", async () => {
    const key = freshKey();
    const id = randomUUID();
    const envelope = await kernel.dispatch(manager, { name: "test.no_audit", input: { id }, idempotencyKey: key });
    expect(envelope.status).toBe("error");
    expect(await clientCount(id)).toBe(0);
    expect((await invocationRow(key))?.status).toBe("error");
  });

  it("audit events carry invocation link, actor, entity refs, diff, and extras (§5, §6, DEC-006)", async () => {
    const key = freshKey();
    const id = randomUUID();
    await kernel.dispatch(manager, { name: "test.client_create", input: { id, name: "Audited" }, idempotencyKey: key });
    const row = await invocationRow(key);
    const events = await auditEventsFor(row?.id ?? "");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actor_type: "person",
      actor_id: manager.id,
      action: "test.client_create",
      entity_type: "clients",
      entity_id: id,
      extras: { note: "kernel-test" },
    });
  });
});

describe("audit-per-executed-action property test (§20.3)", () => {
  // Every registered action must have a fixture here; SLICE-005+ extend this
  // map as production actions join the registry.
  const fixtures: Record<
    string,
    { actor: Actor; input: () => Promise<unknown> | unknown; expected: "ok" | "error" }
  > = {
    "test.client_create": { actor: manager, input: () => ({ id: randomUUID(), name: "Property" }), expected: "ok" },
    "test.proposal_gated_create": { actor: manager, input: () => ({ id: randomUUID() }), expected: "ok" },
    "test.env_probe": { actor: supervisor, input: () => ({}), expected: "ok" },
    "test.owner_only": { actor: owner, input: () => ({}), expected: "ok" },
    "test.record_void": {
      actor: manager,
      input: async () => ({ recordId: await adminInsertVerifiedRecord() }),
      expected: "ok",
    },
    "test.fail_after_write": { actor: manager, input: () => ({ id: randomUUID() }), expected: "error" },
    "test.no_audit": { actor: manager, input: () => ({ id: randomUUID() }), expected: "error" },
  };

  it("every executed action yields ≥1 audit event in the same transaction; failures yield none", async () => {
    for (const definition of registry.list()) {
      const fixture = fixtures[definition.name];
      expect(fixture, `missing §20.3 fixture for ${definition.name}`).toBeDefined();
      if (!fixture) {
        continue;
      }
      const key = freshKey();
      const envelope = await kernel.dispatch(fixture.actor, {
        name: definition.name,
        input: await fixture.input(),
        idempotencyKey: key,
      });
      expect(envelope.status, definition.name).toBe(fixture.expected);
      const row = await invocationRow(key);
      expect(row, definition.name).not.toBeNull();
      const events = await auditEventsFor(row?.id ?? "");
      if (fixture.expected === "ok") {
        expect(events.length, `${definition.name} must audit`).toBeGreaterThanOrEqual(1);
      } else {
        expect(events, `${definition.name} must not leak audit events`).toEqual([]);
      }
    }
  });
});

describe("HTTP surface (§5)", () => {
  it("no actor → 401 unauthenticated envelope (auth ships in SLICE-008/009)", async () => {
    const { httpStatus, envelope } = await handleActionsPost(
      () => kernel,
      null,
      { name: "test.env_probe", input: {}, idempotency_key: freshKey() },
    );
    expect(httpStatus).toBe(401);
    expect(envelope).toMatchObject({ status: "rejected", result: { code: "unauthenticated" } });
  });

  it("malformed body → 400 validation_failed envelope", async () => {
    const { httpStatus, envelope } = await handleActionsPost(() => kernel, supervisor, { name: "" });
    expect(httpStatus).toBe(400);
    expect(envelope).toMatchObject({ status: "rejected", result: { code: "validation_failed" } });
  });

  it("dispatches {name, input, idempotency_key} and returns the envelope (§5)", async () => {
    const { httpStatus, envelope } = await handleActionsPost(() => kernel, supervisor, {
      name: "test.env_probe",
      input: {},
      idempotency_key: freshKey(),
    });
    expect(httpStatus).toBe(200);
    expect(envelope.status).toBe("ok");
  });
});
