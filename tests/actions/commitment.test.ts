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

beforeAll(async () => {
  const url = inject("databaseUrl");
  admin = await connect(url);
  kernelDb = createKernelDb(url);
  kernel = new Kernel(kernelDb, registry, noopUnlimitedResolver);

  await admin.query(
    `INSERT INTO workspaces (id, name, slug, plan_code, settings, status)
     VALUES ($1, 'Commitment Test GmbH', $2, 'pilot', '{}', 'active')`,
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
