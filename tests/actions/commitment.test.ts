import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { noopUnlimitedResolver } from "@core/actions/entitlement";
import { Kernel } from "@core/actions/kernel";
import { registry } from "@core/actions/registry";
import type { Actor, ResponseEnvelope } from "@core/actions/types";
import { completeDueCommitments, VALID_TO_COMPLETION_REASON } from "@core/actions/commitment-cron";
import { createAuthDb, type AuthDb } from "@core/db/auth";
import { connect, type DbClient } from "@core/db/client";
import { createKernelDb, type KernelDb } from "@core/db/kernel";
import { registerWindowCases } from "./window.cases";

let admin: DbClient;
let kernelDb: KernelDb;
let kernel: Kernel;
let cronDb: AuthDb;

const workspaceId = randomUUID();
const managerId = randomUUID();
const ownerId = randomUUID();
const supervisorId = randomUUID();
const clientId = randomUUID();
const activeSiteId = randomUUID();
const draftSiteId = randomUUID();
const archivedSiteId = randomUUID();
const runTag = `test-commitment-${randomUUID().slice(0, 8)}`;

const manager = { type: "person", id: managerId, roleClass: "manager", workspaceId } as const satisfies Actor;
const owner = { type: "person", id: ownerId, roleClass: "owner", workspaceId } as const satisfies Actor;
const supervisor = { type: "person", id: supervisorId, roleClass: "supervisor", workspaceId } as const satisfies Actor;

function freshKey(): string {
  return `commitment:${randomUUID()}`;
}

async function dispatch(actor: Actor, input: unknown, idempotencyKey = freshKey()): Promise<ResponseEnvelope> {
  return kernel.dispatch(actor, { name: "commitment.draft", input, idempotencyKey });
}

async function dispatchAction(
  actor: Actor,
  name: string,
  input: unknown,
  idempotencyKey = freshKey(),
): Promise<ResponseEnvelope> {
  return kernel.dispatch(actor, { name, input, idempotencyKey });
}

const common = {
  site_id: activeSiteId,
  title: "Morning commitment",
  schedule_rrule: "FREQ=DAILY",
  valid_from: "2026-07-13",
  valid_to: "2026-12-31",
};

function coverageInput(): Record<string, unknown> {
  return {
    ...common,
    type: "coverage",
    spec: { window_start_time: "08:00", window_end_time: "16:00" },
    target_qty: 5,
  };
}

function outputInput(): Record<string, unknown> {
  return {
    ...common,
    type: "output",
    spec: { window_start_time: "08:00", window_end_time: "16:00" },
    target_qty: 10.5,
    unit: "pieces",
  };
}

function serviceScopeInput(): Record<string, unknown> {
  return {
    ...common,
    type: "service_scope",
    spec: {
      window_start_time: "08:00",
      window_end_time: "16:00",
      checklist: [{ key: "floor", label: "Floor cleaned" }],
    },
  };
}

async function commitmentRow(commitmentId: string): Promise<Record<string, unknown> | null> {
  const result = await admin.query<Record<string, unknown>>(
    `SELECT id, workspace_id, client_id, site_id, type, title, spec, schedule_rrule,
       target_qty, unit, verification, valid_from::text AS valid_from,
       valid_to::text AS valid_to, status, created_at
     FROM commitments WHERE id = $1`,
    [commitmentId],
  );
  const row = result.rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    ...row,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  };
}

async function auditForKey(key: string): Promise<Record<string, unknown> | null> {
  const result = await admin.query<Record<string, unknown>>(
    `SELECT a.action, a.entity_type, a.entity_id, a.before, a.after, a.extras
     FROM audit_events a
     JOIN action_invocations i ON i.id = a.invocation_id
     WHERE i.idempotency_key = $1`,
    [key],
  );
  return result.rows[0] ?? null;
}

async function insertCommitment(
  status: "draft" | "active" | "paused" | "completed" | "archived",
  options: {
    siteId?: string;
    type?: "coverage" | "output" | "service_scope";
    validTo?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const type = options.type ?? "coverage";
  const siteId = options.siteId ?? activeSiteId;
  const site = await admin.query<{ client_id: string }>("SELECT client_id FROM sites WHERE id = $1", [siteId]);
  const spec = type === "service_scope"
    ? { window_start_time: "08:00", window_end_time: "16:00", checklist: [{ key: "floor", label: "Floor" }] }
    : { window_start_time: "08:00", window_end_time: "16:00" };
  await admin.query(
    `INSERT INTO commitments (id, workspace_id, client_id, site_id, type, title, spec,
       schedule_rrule, target_qty, unit, verification, valid_from, valid_to, status)
     VALUES ($1, $2, $3, $4, $5, 'Fixture Commitment', $6, 'FREQ=DAILY', $7, $8,
       '{"proof":{"required":false}}', '2026-01-01', $9, $10)`,
    [
      id,
      workspaceId,
      site.rows[0]?.client_id,
      siteId,
      type,
      spec,
      type === "service_scope" ? null : 5,
      type === "output" ? "pieces" : null,
      options.validTo ?? "2026-12-31",
      status,
    ],
  );
  return id;
}

beforeAll(async () => {
  const url = inject("databaseUrl");
  admin = await connect(url);
  kernelDb = createKernelDb(url);
  kernel = new Kernel(kernelDb, registry, noopUnlimitedResolver);
  cronDb = createAuthDb(url);

  await admin.query(
    `INSERT INTO workspaces (id, name, slug, plan_code, settings, status)
     VALUES ($1, 'Commitment Test GmbH', $2, 'pilot', '{"tz":"Europe/Berlin"}', 'active')`,
    [workspaceId, runTag],
  );
  await admin.query(
    `INSERT INTO persons (id, workspace_id, display_name, role_class, locale, status)
     VALUES
       ($1, $2, 'Manager Actor', 'manager', 'de', 'active'),
       ($3, $2, 'Owner Actor', 'owner', 'de', 'active'),
       ($4, $2, 'Supervisor Actor', 'supervisor', 'de', 'active')`,
    [managerId, workspaceId, ownerId, supervisorId],
  );
  await admin.query(
    `INSERT INTO clients (id, workspace_id, name, contact, status)
     VALUES ($1, $2, 'Fixture Client', '{}', 'active')`,
    [clientId, workspaceId],
  );
  await admin.query(
    `INSERT INTO sites (id, workspace_id, client_id, name, address, settings, status)
     VALUES
       ($1, $2, $3, 'Active Site', '{}', '{}', 'active'),
       ($4, $2, $3, 'Draft Site', '{}', '{}', 'draft'),
       ($5, $2, $3, 'Archived Site', '{}', '{}', 'archived')`,
    [activeSiteId, workspaceId, clientId, draftSiteId, archivedSiteId],
  );
});

afterAll(async () => {
  await cronDb.end();
  await kernelDb.end();
  await admin.end();
});

describe("commitment.draft persistence and audit (§3/§5, DEC-016/017/018)", () => {
  it("persists draft status, derived client, default verification, and full-row audit", async () => {
    const key = freshKey();
    const envelope = await dispatch(manager, coverageInput(), key);
    expect(envelope.status).toBe("ok");
    const commitmentId = (envelope.result as { commitment_id?: string }).commitment_id ?? "";
    const row = await commitmentRow(commitmentId);
    expect(row).toMatchObject({
      client_id: clientId,
      site_id: activeSiteId,
      type: "coverage",
      target_qty: "5",
      unit: null,
      verification: { proof: { required: false } },
      status: "draft",
    });

    const audit = await auditForKey(key);
    expect(audit).toMatchObject({
      action: "commitment.draft",
      entity_type: "commitments",
      entity_id: commitmentId,
      before: null,
      after: row,
      extras: { type_definition: { type: "coverage", version: 1 } },
    });
  });

  it("round-trips an explicit proof requirement", async () => {
    const input = outputInput();
    input.verification = { proof: { required: true, types: ["photo", "signature"], min_count: 2 } };
    const envelope = await dispatch(manager, input);
    expect(envelope.status).toBe("ok");
    const row = await commitmentRow((envelope.result as { commitment_id?: string }).commitment_id ?? "");
    expect(row?.verification).toEqual({ proof: { required: true, types: ["photo", "signature"], min_count: 2 } });
  });

  it("accepts opaque non-empty RRULE and overnight local times", async () => {
    const input = coverageInput();
    input.schedule_rrule = "semantic validation belongs to SLICE-014";
    input.spec = { window_start_time: "22:30", window_end_time: "06:00" };
    const envelope = await dispatch(owner, input);
    expect(envelope.status).toBe("ok");
    const row = await commitmentRow((envelope.result as { commitment_id?: string }).commitment_id ?? "");
    expect(row).toMatchObject({ schedule_rrule: input.schedule_rrule, spec: input.spec });
  });

  it("rejects draft and archived sites with the typed validation rejection", async () => {
    for (const siteId of [draftSiteId, archivedSiteId]) {
      const input = coverageInput();
      input.site_id = siteId;
      await expect(dispatch(manager, input)).resolves.toMatchObject({
        status: "rejected",
        result: { code: "validation_failed" },
      });
    }
  });

  it("rejects supervisors below the manager role", async () => {
    await expect(dispatch(supervisor, coverageInput())).resolves.toMatchObject({
      status: "rejected",
      result: { code: "unauthorized" },
    });
  });
});

describe("commitment.draft exact per-type matrix (DEC-016 item 5)", () => {
  const matrix = [
    { type: "coverage", create: coverageInput, required: [...Object.keys(common), "type", "spec", "target_qty"], forbidden: ["unit"] },
    { type: "output", create: outputInput, required: [...Object.keys(common), "type", "spec", "target_qty", "unit"], forbidden: [] },
    { type: "service_scope", create: serviceScopeInput, required: [...Object.keys(common), "type", "spec"], forbidden: ["target_qty", "unit"] },
  ] as const;

  for (const entry of matrix) {
    for (const field of entry.required) {
      it(`rejects ${entry.type} when required ${field} is missing`, async () => {
        const input = entry.create();
        delete input[field];
        await expect(dispatch(manager, input)).resolves.toMatchObject({
          status: "rejected",
          result: { code: "validation_failed" },
        });
      });
    }
    for (const field of entry.forbidden) {
      it(`rejects ${entry.type} when forbidden ${field} is present`, async () => {
        const input = entry.create();
        input[field] = field === "unit" ? "people" : 1;
        await expect(dispatch(manager, input)).resolves.toMatchObject({
          status: "rejected",
          result: { code: "validation_failed" },
        });
      });
    }
  }

  it("rejects valid_to before valid_from", async () => {
    const input = coverageInput();
    input.valid_to = "2026-07-12";
    await expect(dispatch(manager, input)).resolves.toMatchObject({
      status: "rejected",
      result: { code: "validation_failed" },
    });
  });

  it("rejects empty RRULE, invalid wall clocks, and type-invalid spec fields", async () => {
    const cases = [
      { ...coverageInput(), schedule_rrule: " " },
      { ...coverageInput(), spec: { window_start_time: "25:00", window_end_time: "06:00" } },
      {
        ...coverageInput(),
        spec: { window_start_time: "08:00", window_end_time: "16:00", checklist: [] },
      },
      {
        ...serviceScopeInput(),
        spec: { window_start_time: "08:00", window_end_time: "16:00" },
      },
    ];
    for (const input of cases) {
      await expect(dispatch(manager, input)).resolves.toMatchObject({
        status: "rejected",
        result: { code: "validation_failed" },
      });
    }
  });

  it("enforces the explicit-proof required/forbidden field matrix from DEC-017", async () => {
    const invalidVerification = [
      { proof: { required: true, min_count: 1 } },
      { proof: { required: true, types: ["photo"] } },
      { proof: { required: false, types: ["photo"] } },
      { proof: { required: false, min_count: 1 } },
    ];
    for (const verification of invalidVerification) {
      const input = coverageInput();
      input.verification = verification;
      await expect(dispatch(manager, input)).resolves.toMatchObject({
        status: "rejected",
        result: { code: "validation_failed" },
      });
    }
  });
});

describe("commitment.update_spec patch matrix (DEC-016 item 6, DEC-019)", () => {
  const draftPatches = [
    { title: "Renamed" },
    { spec: { window_start_time: "09:00", window_end_time: "17:00" } },
    { schedule_rrule: "FREQ=WEEKLY;BYDAY=MO" },
    { target_qty: 7 },
    { verification: { proof: { required: true, types: ["photo"], min_count: 1 } } },
    { valid_from: "2026-02-01" },
    { valid_to: "2027-01-01" },
  ];

  for (const patch of draftPatches) {
    it(`allows draft patch ${Object.keys(patch)[0]}`, async () => {
      const id = await insertCommitment("draft");
      await expect(dispatchAction(manager, "commitment.update_spec", { commitment_id: id, ...patch })).resolves.toMatchObject({ status: "ok" });
    });
  }

  for (const patch of draftPatches.filter((candidate) => !("valid_from" in candidate))) {
    it(`allows active patch ${Object.keys(patch)[0]}`, async () => {
      const id = await insertCommitment("active");
      await expect(dispatchAction(manager, "commitment.update_spec", { commitment_id: id, ...patch })).resolves.toMatchObject({ status: "ok" });
    });
  }

  it("allows output unit patch and revalidates the complete type matrix", async () => {
    const outputId = await insertCommitment("active", { type: "output" });
    await expect(dispatchAction(manager, "commitment.update_spec", { commitment_id: outputId, unit: "hours" })).resolves.toMatchObject({ status: "ok" });
    await expect(dispatchAction(manager, "commitment.update_spec", { commitment_id: outputId, target_qty: null })).resolves.toMatchObject({
      status: "rejected", result: { code: "validation_failed" },
    });
    const serviceId = await insertCommitment("draft", { type: "service_scope" });
    await expect(dispatchAction(manager, "commitment.update_spec", { commitment_id: serviceId, target_qty: 1 })).resolves.toMatchObject({
      status: "rejected", result: { code: "validation_failed" },
    });
  });

  it("rejects active valid_from and immutable type/site fields with commitment_patch_forbidden", async () => {
    const activeId = await insertCommitment("active");
    for (const patch of [{ valid_from: "2026-02-01" }, { type: "output" }, { site_id: activeSiteId }]) {
      await expect(dispatchAction(manager, "commitment.update_spec", { commitment_id: activeId, ...patch })).resolves.toMatchObject({
        status: "rejected", result: { code: "commitment_patch_forbidden" },
      });
    }
  });

  it("rejects update_spec from paused/completed/archived and empty patches", async () => {
    for (const status of ["paused", "completed", "archived"] as const) {
      const id = await insertCommitment(status);
      await expect(dispatchAction(manager, "commitment.update_spec", { commitment_id: id, title: "No" })).resolves.toMatchObject({
        status: "rejected", result: { code: "commitment_wrong_state" },
      });
    }
    await expect(dispatchAction(manager, "commitment.update_spec", { commitment_id: await insertCommitment("draft") })).resolves.toMatchObject({
      status: "rejected", result: { code: "validation_failed" },
    });
  });

  it("writes full-row before/after audit and leaves existing windows untouched", async () => {
    const id = await insertCommitment("active");
    const windowId = randomUUID();
    await admin.query(
      `INSERT INTO execution_windows (id, workspace_id, commitment_id, site_id, date, starts_at, ends_at,
         target_qty, unit, requirements, fulfillment, status)
       VALUES ($1, $2, $3, $4, '2026-07-20', '2026-07-20T06:00:00Z', '2026-07-20T14:00:00Z',
         5, NULL, '{}', '{}', 'scheduled')`,
      [windowId, workspaceId, id, activeSiteId],
    );
    const key = freshKey();
    await expect(dispatchAction(manager, "commitment.update_spec", { commitment_id: id, target_qty: 9 }, key)).resolves.toMatchObject({ status: "ok" });
    const audit = await auditForKey(key);
    expect(audit).toMatchObject({
      action: "commitment.update_spec",
      before: { id, target_qty: "5", status: "active" },
      after: { id, target_qty: "9", status: "active" },
    });
    const frozen = await admin.query<{ target_qty: string }>("SELECT target_qty FROM execution_windows WHERE id = $1", [windowId]);
    expect(frozen.rows[0]?.target_qty).toBe("5");
  });
});

describe("commitment lifecycle state machine and guards (§4/§5/§21.8)", () => {
  const invalidStates = {
    "commitment.activate": ["active", "completed", "archived"],
    "commitment.pause": ["draft", "paused", "completed", "archived"],
    "commitment.complete": ["draft", "completed", "archived"],
    "commitment.archive": ["active", "paused", "archived"],
  } as const;

  for (const [action, states] of Object.entries(invalidStates)) {
    for (const status of states) {
      it(`rejects ${action} from ${status}`, async () => {
        const id = await insertCommitment(status);
        const input = action === "commitment.activate" ? { commitment_id: id } : { commitment_id: id, reason: "matrix" };
        await expect(dispatchAction(manager, action, input)).resolves.toMatchObject({
          status: "rejected", result: { code: "commitment_wrong_state" },
        });
      });
    }
  }

  it("executes draft→active→paused→active→completed→archived with full-row audits", async () => {
    const id = await insertCommitment("draft");
    const sequence = [
      { action: "commitment.activate", input: { commitment_id: id }, from: "draft", to: "active" },
      { action: "commitment.pause", input: { commitment_id: id, reason: "pause" }, from: "active", to: "paused" },
      { action: "commitment.activate", input: { commitment_id: id }, from: "paused", to: "active" },
      { action: "commitment.complete", input: { commitment_id: id, reason: "done" }, from: "active", to: "completed" },
      { action: "commitment.archive", input: { commitment_id: id, reason: "archive" }, from: "completed", to: "archived" },
    ];
    for (const item of sequence) {
      const key = freshKey();
      await expect(dispatchAction(manager, item.action, item.input, key)).resolves.toMatchObject({ status: "ok" });
      const audit = await auditForKey(key);
      expect(audit).toMatchObject({ action: item.action, before: { id, status: item.from }, after: { id, status: item.to } });
      if (item.action === "commitment.activate") {
        expect((audit?.extras as { frozen_spec_hash?: string }).frozen_spec_hash).toMatch(/^[a-f0-9]{64}$/u);
      }
      if ("reason" in item.input) {
        expect(audit?.extras).toEqual({ reason: item.input.reason });
      }
    }
  });

  it("rejects activation when the commitment site is no longer active", async () => {
    const id = await insertCommitment("draft", { siteId: archivedSiteId });
    await expect(dispatchAction(manager, "commitment.activate", { commitment_id: id })).resolves.toMatchObject({
      status: "rejected", result: { code: "commitment_site_inactive" },
    });
  });

  it("blocks archive while any attached window is not closed and allows closed-only history", async () => {
    const blockedId = await insertCommitment("completed");
    await admin.query(
      `INSERT INTO execution_windows (id, workspace_id, commitment_id, site_id, date, starts_at, ends_at,
         requirements, fulfillment, status)
       VALUES ($1, $2, $3, $4, '2026-07-21', '2026-07-21T06:00:00Z', '2026-07-21T14:00:00Z', '{}', '{}', 'scheduled')`,
      [randomUUID(), workspaceId, blockedId, activeSiteId],
    );
    await expect(dispatchAction(manager, "commitment.archive", { commitment_id: blockedId, reason: "archive" })).resolves.toMatchObject({
      status: "rejected", result: { code: "commitment_has_open_windows" },
    });

    const allowedId = await insertCommitment("completed");
    await admin.query(
      `INSERT INTO execution_windows (id, workspace_id, commitment_id, site_id, date, starts_at, ends_at,
         requirements, fulfillment, status)
       VALUES ($1, $2, $3, $4, '2026-07-22', '2026-07-22T06:00:00Z', '2026-07-22T14:00:00Z', '{}', '{}', 'closed')`,
      [randomUUID(), workspaceId, allowedId, activeSiteId],
    );
    await expect(dispatchAction(manager, "commitment.archive", { commitment_id: allowedId, reason: "archive" })).resolves.toMatchObject({ status: "ok" });
  });

  it("requires reason for pause, complete, and archive", async () => {
    for (const action of ["commitment.pause", "commitment.complete", "commitment.archive"]) {
      await expect(dispatchAction(manager, action, { commitment_id: await insertCommitment("active") })).resolves.toMatchObject({
        status: "rejected", result: { code: "validation_failed" },
      });
    }
  });
});

describe("valid-to system auto-completion (DEC-016 F-09, DEC-020/021)", () => {
  it("discovers due ids through the narrow function and dispatches the canonical natural-key action", async () => {
    const id = await insertCommitment("active", { validTo: "2000-01-01" });
    await completeDueCommitments(cronDb, kernel);
    const row = await commitmentRow(id);
    expect(row?.status).toBe("completed");
    const invocation = await admin.query<{ idempotency_key: string; actor_type: string; extras: unknown }>(
      `SELECT i.idempotency_key, i.actor_type, a.extras
       FROM action_invocations i
       JOIN audit_events a ON a.invocation_id = i.id
       WHERE i.workspace_id = $1 AND i.idempotency_key = $2`,
      [workspaceId, `commitment.complete:${id}`],
    );
    expect(invocation.rows[0]).toMatchObject({
      idempotency_key: `commitment.complete:${id}`,
      actor_type: "system",
      extras: { reason: VALID_TO_COMPLETION_REASON },
    });
    await completeDueCommitments(cronDb, kernel);
    const events = await admin.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events a
       JOIN action_invocations i ON i.id = a.invocation_id
       WHERE i.workspace_id = $1 AND i.idempotency_key = $2`,
      [workspaceId, `commitment.complete:${id}`],
    );
    expect(events.rows[0]?.count).toBe("1");
  });
});

registerWindowCases();
