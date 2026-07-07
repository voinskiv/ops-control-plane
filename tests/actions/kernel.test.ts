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
import { ActionRegistry, registry as applicationRegistry } from "@core/actions/registry";
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

const platform = { type: "platform" } as const satisfies Actor;
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
  // Keys are unique per test, so the admin lookup needs no workspace scope —
  // platform bootstrap rows carry the created workspace's id (DEC-005), not
  // this file's fixture workspace.
  const res = await admin.query<{
    id: string;
    status: string;
    result: ResponseEnvelope | null;
    input_hash: string;
  }>("SELECT id, status, result, input_hash FROM action_invocations WHERE idempotency_key = $1", [key]);
  return res.rows[0] ?? null;
}

async function auditEventsFor(invocationId: string): Promise<
  {
    actor_type: string;
    actor_id: string | null;
    action: string;
    entity_type: string;
    entity_id: string;
    after: unknown;
    extras: unknown;
  }[]
> {
  const res = await admin.query<{
    actor_type: string;
    actor_id: string | null;
    action: string;
    entity_type: string;
    entity_id: string;
    after: unknown;
    extras: unknown;
  }>(
    "SELECT actor_type, actor_id, action, entity_type, entity_id, after, extras FROM audit_events WHERE invocation_id = $1",
    [invocationId],
  );
  return res.rows;
}

async function clientCount(clientId: string): Promise<number> {
  const res = await admin.query<{ n: string }>("SELECT count(*) AS n FROM clients WHERE id = $1", [clientId]);
  return Number(res.rows[0]?.n ?? 0);
}

async function workspaceById(workspaceId: string): Promise<{
  id: string;
  name: string;
  slug: string;
  plan_code: string;
  settings: unknown;
  status: string;
  created_at: Date;
} | null> {
  const res = await admin.query<{
    id: string;
    name: string;
    slug: string;
    plan_code: string;
    settings: unknown;
    status: string;
    created_at: Date;
  }>("SELECT id, name, slug, plan_code, settings, status, created_at FROM workspaces WHERE id = $1", [workspaceId]);
  return res.rows[0] ?? null;
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

registry.register({
  name: "test.workspace_bootstrap",
  // Shaped like workspace.create (§5 catalog: platform, human_only): the
  // kernel's DEC-005 platform flow is under test; the real action ships in
  // SLICE-005.
  actors: { platform: true },
  threshold: "human_only",
  input: z.object({ id: z.uuid(), slug: z.string().min(1) }),
  async execute(ctx, input) {
    await ctx.setWorkspaceId(input.id);
    // Widen the race window so two concurrent identical calls overlap
    // reliably in the concurrency test below.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await ctx.tx.query(
      `INSERT INTO workspaces (id, name, slug, plan_code, settings, status)
       VALUES ($1, 'Bootstrap', $2, 'pilot', '{}', 'active')`,
      [input.id, input.slug],
    );
    return {
      result: { workspaceId: input.id },
      audit: [{ entityType: "workspaces", entityId: input.id, after: { slug: input.slug }, extras: { plan: "pilot" } }],
    };
  },
});

// §20.3 iterates *the* registry, not just test scaffolding: fold the
// application registry into the dispatched set so every production action
// registered from SLICE-005 onward needs a fixture below or this suite
// fails. Empty today — importing the future action catalog here is what
// makes it binding.
for (const definition of applicationRegistry.list()) {
  registry.register(definition);
}

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

  it("replay returns the stored envelope without re-running gates (F24)", async () => {
    // §5 [FIXED] matches replays on (workspace_id, idempotency_key) only —
    // this is why the replay lookup precedes authorize in the pipeline: a
    // gate outcome that changed since the original call must not alter a
    // byte-identical replay.
    const key = freshKey();
    const id = randomUUID();
    const first = await kernel.dispatch(manager, {
      name: "test.client_create",
      input: { id, name: "Gated Replay" },
      idempotencyKey: key,
    });
    expect(first.status).toBe("ok");
    // A fresh supervisor call would fail authorize (min role: manager); the
    // replay still returns the stored envelope with no re-evaluation.
    const replay = await kernel.dispatch(supervisor, {
      name: "test.client_create",
      input: { id, name: "Gated Replay" },
      idempotencyKey: key,
    });
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
    expect(await clientCount(id)).toBe(1);
  });

  it("platform bootstrap replays through the DEC-005 lookup: one workspace, stored envelope", async () => {
    const key = freshKey();
    const input = { id: randomUUID(), slug: `${runTag}-replay` };
    const first = await kernel.dispatch(platform, { name: "test.workspace_bootstrap", input, idempotencyKey: key });
    expect(first.status).toBe("ok");
    const replay = await kernel.dispatch(platform, { name: "test.workspace_bootstrap", input, idempotencyKey: key });
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));
    const ws = await admin.query<{ n: string }>("SELECT count(*) AS n FROM workspaces WHERE id = $1", [input.id]);
    expect(Number(ws.rows[0]?.n)).toBe(1);
  });

  it("workspace.create creates a tenant root with plan snapshot audit extras and replay stability (SLICE-005)", async () => {
    const key = freshKey();
    const input = { name: `Slice 005 ${randomUUID()}`, plan_code: "pilot" };
    const first = await kernel.dispatch(platform, { name: "workspace.create", input, idempotencyKey: key });
    const replay = await kernel.dispatch(platform, { name: "workspace.create", input, idempotencyKey: key });
    expect(first.status).toBe("ok");
    expect(JSON.stringify(replay)).toBe(JSON.stringify(first));

    const workspaceId = (first.result as { workspace_id?: string }).workspace_id;
    expect(workspaceId).toEqual(expect.any(String));
    expect(first.result).toEqual({ workspace_id: workspaceId });
    const workspace = await workspaceById(workspaceId ?? "");
    expect(workspace).toMatchObject({
      id: workspaceId,
      name: input.name,
      slug: workspaceId,
      plan_code: "pilot",
      settings: {
        tz: "Europe/Berlin",
        default_locale: "de",
        branding: {},
        action_policies: {},
        retention_months: 24,
      },
      status: "active",
    });
    expect(workspace?.created_at).toBeInstanceOf(Date);

    const invocation = await invocationRow(key);
    expect(invocation?.status).toBe("ok");
    const events = await auditEventsFor(invocation?.id ?? "");
    expect(events).toHaveLength(1);
    const after = events[0]?.after;
    expect(after).toMatchObject({
      id: workspaceId,
      name: input.name,
      slug: workspaceId,
      plan_code: "pilot",
      settings: workspace?.settings,
      status: "active",
    });
    expect(after).not.toHaveProperty("plan_snapshot");
    const afterCreatedAt =
      typeof after === "object" && after !== null ? (after as { created_at?: unknown }).created_at : undefined;
    expect(typeof afterCreatedAt).toBe("string");
    expect(new Date(afterCreatedAt as string).toISOString()).toBe(workspace?.created_at.toISOString());
    expect(events[0]).toMatchObject({
      actor_type: "platform",
      actor_id: null,
      action: "workspace.create",
      entity_type: "workspaces",
      entity_id: workspaceId,
      extras: {
        plan_snapshot: {
          code: "pilot",
          name: "Pilot",
          limits: {},
          price: {},
        },
      },
    });

    const counts = await admin.query<{ invocations: string; audits: string }>(
      `SELECT
         (SELECT count(*) FROM action_invocations WHERE idempotency_key = $1) AS invocations,
         (SELECT count(*) FROM audit_events WHERE action = 'workspace.create' AND entity_id = $2) AS audits`,
      [key, workspaceId],
    );
    expect(counts.rows[0]).toEqual({ invocations: "1", audits: "1" });
  });

  it("two concurrent identical platform bootstraps commit once and answer identically (§20.2, DEC-005)", async () => {
    // Claim-before-execute is structurally impossible for the tenant-root
    // bootstrap (the pending row FK-references the workspace the action
    // creates), so both racers may start executing; the unique indexes admit
    // one committer and the loser must resolve to the winner's stored
    // envelope via the retry → replay path.
    const key = freshKey();
    const input = { id: randomUUID(), slug: `${runTag}-race` };
    const [a, b] = await Promise.all([
      kernel.dispatch(platform, { name: "test.workspace_bootstrap", input, idempotencyKey: key }),
      kernel.dispatch(platform, { name: "test.workspace_bootstrap", input, idempotencyKey: key }),
    ]);
    expect(a.status).toBe("ok");
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const ws = await admin.query<{ n: string }>("SELECT count(*) AS n FROM workspaces WHERE id = $1", [input.id]);
    expect(Number(ws.rows[0]?.n)).toBe(1);
    const inv = await admin.query<{ n: string }>(
      "SELECT count(*) AS n FROM action_invocations WHERE idempotency_key = $1",
      [key],
    );
    expect(Number(inv.rows[0]?.n)).toBe(1);
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

describe("workspace.create authorization and validation (SLICE-005)", () => {
  it("workspace.create is platform-only", async () => {
    const key = freshKey();
    const envelope = await kernel.dispatch(manager, {
      name: "workspace.create",
      input: { name: "Not Platform", plan_code: "pilot" },
      idempotencyKey: key,
    });
    expect(envelope).toMatchObject({ status: "rejected", result: { code: "unauthorized" } });
    const row = await invocationRow(key);
    expect(row?.status).toBe("rejected");
    expect(await auditEventsFor(row?.id ?? "")).toEqual([]);
  });

  it("workspace.create rejects pass-through fields", async () => {
    const envelope = await kernel.dispatch(platform, {
      name: "workspace.create",
      input: { name: "Extra", plan_code: "pilot", slug: "not-allowed" },
      idempotencyKey: freshKey(),
    });
    expect(envelope).toMatchObject({ status: "rejected", result: { code: "validation_failed" } });
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
    "test.workspace_bootstrap": {
      actor: platform,
      input: () => ({ id: randomUUID(), slug: `${runTag}-prop-${randomUUID().slice(0, 8)}` }),
      expected: "ok",
    },
    "test.owner_only": { actor: owner, input: () => ({}), expected: "ok" },
    "test.record_void": {
      actor: manager,
      input: async () => ({ recordId: await adminInsertVerifiedRecord() }),
      expected: "ok",
    },
    "test.fail_after_write": { actor: manager, input: () => ({ id: randomUUID() }), expected: "error" },
    "test.no_audit": { actor: manager, input: () => ({ id: randomUUID() }), expected: "error" },
    "workspace.create": {
      actor: platform,
      input: () => ({ name: `Property ${randomUUID()}`, plan_code: "pilot" }),
      expected: "ok",
    },
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
