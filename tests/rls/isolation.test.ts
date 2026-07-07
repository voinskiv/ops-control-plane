// SLICE-004 tenancy isolation suite (§7, §20.4, F13): RLS is a real backstop,
// not decoration. A workspace-A actor reading or writing workspace-B rows gets
// zero rows / denial on representative tables, with RLS active — including the
// deliberate kernel-workspace-filter-bypass case §7 names ("a deliberate bug
// that drops the kernel's own workspace filter still returns zero cross-tenant
// rows"), exercised through the real kernel dispatch path.
//
// Fixture rows are inserted with direct SQL as the migration owner: the §5
// actions for these entities ship from SLICE-005 onward. This is SQL-test
// scaffolding, not seed data (DEC-004 governs db/seed only) — the same
// precedent as the SLICE-002 immutability suite.
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { z } from "zod";

import { noopUnlimitedResolver } from "@core/actions/entitlement";
import { Kernel } from "@core/actions/kernel";
import { ActionRegistry } from "@core/actions/registry";
import type { Actor } from "@core/actions/types";
import { connect, type DbClient, type Queryable } from "@core/db/client";
import { createKernelDb, type KernelDb } from "@core/db/kernel";

let admin: DbClient;
let kernelConn: DbClient;
let kernelDb: KernelDb;
let kernel: Kernel;

// Unique per run so the suite can rerun against a persistent database
// (TEST_DATABASE_URL), not just the throwaway embedded one.
const runTag = `test-rls-${randomUUID().slice(0, 8)}`;

interface WorkspaceFixture {
  workspaceId: string;
  personId: string;
  clientId: string;
  siteId: string;
  commitmentId: string;
  windowId: string;
  recordId: string;
  auditEventId: string;
  invocationId: string;
}

function makeFixture(): WorkspaceFixture {
  return {
    workspaceId: randomUUID(),
    personId: randomUUID(),
    clientId: randomUUID(),
    siteId: randomUUID(),
    commitmentId: randomUUID(),
    windowId: randomUUID(),
    recordId: randomUUID(),
    auditEventId: randomUUID(),
    invocationId: randomUUID(),
  };
}

const a = makeFixture();
const b = makeFixture();

async function seedWorkspace(fixture: WorkspaceFixture, label: string): Promise<void> {
  const ws = fixture.workspaceId;
  await admin.query(
    `INSERT INTO workspaces (id, name, slug, plan_code, settings, status)
     VALUES ($1, $2, $3, 'pilot', '{}', 'active')`,
    [ws, `RLS ${label} GmbH`, `${runTag}-${label}`],
  );
  await admin.query(
    `INSERT INTO persons (id, workspace_id, display_name, role_class, locale, status)
     VALUES ($1, $2, $3, 'manager', 'de', 'active')`,
    [fixture.personId, ws, `Manager ${label}`],
  );
  await admin.query(
    `INSERT INTO clients (id, workspace_id, name, contact, status)
     VALUES ($1, $2, $3, '{}', 'active')`,
    [fixture.clientId, ws, `Client ${label}`],
  );
  await admin.query(
    `INSERT INTO sites (id, workspace_id, client_id, name, address, settings, status)
     VALUES ($1, $2, $3, $4, '{}', '{}', 'active')`,
    [fixture.siteId, ws, fixture.clientId, `Site ${label}`],
  );
  await admin.query(
    `INSERT INTO commitments (id, workspace_id, client_id, site_id, type, title, spec,
       schedule_rrule, target_qty, unit, verification, valid_from, valid_to, status)
     VALUES ($1, $2, $3, $4, 'coverage', $5, '{}', 'FREQ=DAILY', 1, 'persons',
       '{}', '2026-07-01', '2026-12-31', 'active')`,
    [fixture.commitmentId, ws, fixture.clientId, fixture.siteId, `Coverage ${label}`],
  );
  await admin.query(
    `INSERT INTO execution_windows (id, workspace_id, commitment_id, site_id, date,
       starts_at, ends_at, target_qty, unit, requirements, fulfillment, status)
     VALUES ($1, $2, $3, $4, '2026-07-06', '2026-07-06T06:00:00Z', '2026-07-06T14:00:00Z',
       1, 'persons', '{}', '{}', 'open')`,
    [fixture.windowId, ws, fixture.commitmentId, fixture.siteId],
  );
  await admin.query(
    `INSERT INTO execution_records (id, workspace_id, window_id, kind, qty, unit,
       occurred_at, received_at, captured_by_actor, client_key, status)
     VALUES ($1, $2, $3, 'coverage_confirm', 1, 'persons', now(), now(), $4, $5, 'verified')`,
    [
      fixture.recordId,
      ws,
      fixture.windowId,
      JSON.stringify({ actor_type: "person", actor_id: fixture.personId }),
      randomUUID(),
    ],
  );
  await admin.query(
    `INSERT INTO action_invocations
       (id, workspace_id, idempotency_key, action_name, actor_type, actor_id, input_hash, result, status)
     VALUES ($1, $2, $3, 'test.fixture', 'person', $4, 'hash', '{}', 'ok')`,
    [fixture.invocationId, ws, `${runTag}:${label}`, fixture.personId],
  );
  await admin.query(
    `INSERT INTO audit_events
       (id, workspace_id, invocation_id, actor_type, actor_id, action, entity_type, entity_id, at)
     VALUES ($1, $2, $3, 'person', $4, 'test.fixture', 'clients', $5, now())`,
    [fixture.auditEventId, ws, fixture.invocationId, fixture.personId, fixture.clientId],
  );
}

// Runs fn as app_kernel inside one rolled-back transaction, mirroring the
// kernel's per-transaction context (§7): SET LOCAL ROLE reverts on rollback,
// set_config(..., true) is transaction-local. workspaceId=null leaves the GUC
// unset to exercise the fail-closed path.
async function asKernel<T>(
  workspaceId: string | null,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  await kernelConn.query("BEGIN");
  try {
    await kernelConn.query("SET LOCAL ROLE app_kernel");
    if (workspaceId !== null) {
      await kernelConn.query("SELECT set_config('app.workspace_id', $1, true)", [workspaceId]);
    }
    return await fn(kernelConn);
  } finally {
    await kernelConn.query("ROLLBACK");
  }
}

function expectRlsDenial(promise: Promise<unknown>, table: string): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    code: "42501",
    message: expect.stringContaining(table) as unknown,
  });
}

// The deliberate kernel-workspace-filter-bypass case (§7, §20.4): every query
// in this action is missing its workspace filter on purpose. Dispatched
// through the real kernel (app_kernel role via connection startup, GUC set by
// the pipeline), RLS alone must reduce cross-tenant visibility to zero.
const registry = new ActionRegistry();
registry.register({
  name: "test.rls_filter_bypass",
  actors: { minHumanRole: "manager", system: true },
  threshold: "autonomous_safe",
  input: z.object({ probePersonId: z.uuid(), probeClientId: z.uuid() }),
  async execute(ctx, input) {
    const seen = await ctx.tx.query<{ workspace_id: string }>(
      "SELECT workspace_id FROM persons",
    );
    const personProbe = await ctx.tx.query("SELECT id FROM persons WHERE id = $1", [
      input.probePersonId,
    ]);
    const clientProbe = await ctx.tx.query("SELECT id FROM clients WHERE id = $1", [
      input.probeClientId,
    ]);
    const write = await ctx.tx.query(
      "UPDATE persons SET display_name = 'cross-tenant write' WHERE id = $1",
      [input.probePersonId],
    );
    return {
      result: {
        workspaceIdsSeen: [...new Set(seen.rows.map((r) => r.workspace_id))],
        personRowsSeen: personProbe.rowCount,
        clientRowsSeen: clientProbe.rowCount,
        personRowsWritten: write.rowCount,
      },
      audit: [{ entityType: "workspaces", entityId: ctx.workspaceId ?? "" }],
    };
  },
});

const managerA = {
  type: "person",
  id: a.personId,
  roleClass: "manager",
  workspaceId: a.workspaceId,
} as const satisfies Actor;

beforeAll(async () => {
  const url = inject("databaseUrl");
  admin = await connect(url);
  kernelConn = await connect(url);
  kernelDb = createKernelDb(url);
  kernel = new Kernel(kernelDb, registry, noopUnlimitedResolver);
  await seedWorkspace(a, "a");
  await seedWorkspace(b, "b");
});

afterAll(async () => {
  await kernelDb.end();
  await kernelConn.end();
  await admin.end();
});

describe("cross-tenant reads return zero rows (§20.4)", () => {
  // One entry per tenant table that has fixture rows in both workspaces; each
  // is probed by workspace-B primary key with the workspace-A GUC set.
  const targets: { table: string; bRowId: string }[] = [
    { table: "persons", bRowId: b.personId },
    { table: "clients", bRowId: b.clientId },
    { table: "sites", bRowId: b.siteId },
    { table: "commitments", bRowId: b.commitmentId },
    { table: "execution_windows", bRowId: b.windowId },
    { table: "execution_records", bRowId: b.recordId },
    { table: "audit_events", bRowId: b.auditEventId },
    { table: "action_invocations", bRowId: b.invocationId },
  ];

  for (const { table, bRowId } of targets) {
    it(`${table}: workspace-B row invisible by exact id; unfiltered scan yields only workspace-A rows`, async () => {
      await asKernel(a.workspaceId, async (tx) => {
        const probe = await tx.query(`SELECT * FROM ${table} WHERE id = $1`, [bRowId]);
        expect(probe.rowCount).toBe(0);

        // The row exists and is readable in its own workspace (positive
        // control — zero rows above means isolation, not broken grants).
        const scan = await tx.query<{ workspace_id: string }>(
          `SELECT workspace_id FROM ${table}`,
        );
        expect(scan.rows.length).toBeGreaterThan(0);
        expect(new Set(scan.rows.map((r) => r.workspace_id))).toEqual(new Set([a.workspaceId]));
      });
      await asKernel(b.workspaceId, async (tx) => {
        const own = await tx.query(`SELECT id FROM ${table} WHERE id = $1`, [bRowId]);
        expect(own.rowCount).toBe(1);
      });
    });
  }

  it("workspaces (tenant root): only the GUC workspace itself is visible", async () => {
    await asKernel(a.workspaceId, async (tx) => {
      const scan = await tx.query<{ id: string }>("SELECT id FROM workspaces");
      expect(scan.rows.map((r) => r.id)).toEqual([a.workspaceId]);
      const probe = await tx.query("SELECT id FROM workspaces WHERE id = $1", [b.workspaceId]);
      expect(probe.rowCount).toBe(0);
    });
  });
});

describe("cross-tenant writes are denied (§20.4)", () => {
  it("INSERT with a workspace-B id under the workspace-A GUC raises 42501 (persons, clients, execution_records, audit_events, action_invocations)", async () => {
    await asKernel(a.workspaceId, async (tx) => {
      await expectRlsDenial(
        tx.query(
          `INSERT INTO persons (id, workspace_id, display_name, role_class, locale, status)
           VALUES ($1, $2, 'Intruder', 'manager', 'de', 'active')`,
          [randomUUID(), b.workspaceId],
        ),
        "persons",
      );
    });
    await asKernel(a.workspaceId, async (tx) => {
      await expectRlsDenial(
        tx.query(
          "INSERT INTO clients (id, workspace_id, name, contact, status) VALUES ($1, $2, 'Intruder', '{}', 'active')",
          [randomUUID(), b.workspaceId],
        ),
        "clients",
      );
    });
    await asKernel(a.workspaceId, async (tx) => {
      await expectRlsDenial(
        tx.query(
          `INSERT INTO execution_records (id, workspace_id, window_id, kind, qty, unit,
             occurred_at, received_at, captured_by_actor, client_key, status)
           VALUES ($1, $2, $3, 'note', 1, 'persons', now(), now(), '{}', $4, 'recorded')`,
          [randomUUID(), b.workspaceId, b.windowId, randomUUID()],
        ),
        "execution_records",
      );
    });
    await asKernel(a.workspaceId, async (tx) => {
      await expectRlsDenial(
        tx.query(
          `INSERT INTO audit_events (id, workspace_id, actor_type, actor_id, action, entity_type, entity_id, at)
           VALUES ($1, $2, 'person', $3, 'test.forged', 'clients', $4, now())`,
          [randomUUID(), b.workspaceId, a.personId, b.clientId],
        ),
        "audit_events",
      );
    });
    await asKernel(a.workspaceId, async (tx) => {
      await expectRlsDenial(
        tx.query(
          `INSERT INTO action_invocations
             (id, workspace_id, idempotency_key, action_name, actor_type, input_hash, status)
           VALUES ($1, $2, $3, 'test.forged', 'person', 'hash', 'pending')`,
          [randomUUID(), b.workspaceId, `${runTag}:forged`],
        ),
        "action_invocations",
      );
    });
  });

  it("UPDATE targeting workspace-B rows by exact id affects zero rows; the same statement works in-tenant", async () => {
    await asKernel(a.workspaceId, async (tx) => {
      const cross = await tx.query("UPDATE persons SET display_name = 'x' WHERE id = $1", [
        b.personId,
      ]);
      expect(cross.rowCount).toBe(0);
      const own = await tx.query("UPDATE persons SET display_name = 'x' WHERE id = $1", [
        a.personId,
      ]);
      expect(own.rowCount).toBe(1);

      const crossInvocation = await tx.query(
        "UPDATE action_invocations SET status = 'error' WHERE id = $1",
        [b.invocationId],
      );
      expect(crossInvocation.rowCount).toBe(0);

      const crossWorkspace = await tx.query("UPDATE workspaces SET name = 'x' WHERE id = $1", [
        b.workspaceId,
      ]);
      expect(crossWorkspace.rowCount).toBe(0);
      const ownWorkspace = await tx.query("UPDATE workspaces SET name = 'x' WHERE id = $1", [
        a.workspaceId,
      ]);
      expect(ownWorkspace.rowCount).toBe(1);
    });
  });

  it("kernel-style status transition on execution_records stays in-tenant even with app.kernel_op set (F4 + §7 compose)", async () => {
    await asKernel(a.workspaceId, async (tx) => {
      await tx.query("SELECT set_config('app.kernel_op', 'test.rls', true)");
      const cross = await tx.query(
        "UPDATE execution_records SET status = 'voided' WHERE id = $1",
        [b.recordId],
      );
      expect(cross.rowCount).toBe(0);
      const own = await tx.query("UPDATE execution_records SET status = 'voided' WHERE id = $1", [
        a.recordId,
      ]);
      expect(own.rowCount).toBe(1);
    });
  });
});

describe("unset workspace GUC fails closed (§7, 0002 policy design)", () => {
  it("no app.workspace_id → zero rows on tenant tables and the tenant root", async () => {
    await asKernel(null, async (tx) => {
      for (const table of ["persons", "clients", "execution_records", "audit_events", "workspaces"]) {
        const scan = await tx.query(`SELECT 1 FROM ${table}`);
        expect(scan.rowCount, `${table} must be empty without a workspace GUC`).toBe(0);
      }
    });
  });

  it("no app.workspace_id → INSERT denied even for a row naming a real workspace", async () => {
    await asKernel(null, async (tx) => {
      await expectRlsDenial(
        tx.query(
          "INSERT INTO clients (id, workspace_id, name, contact, status) VALUES ($1, $2, 'Orphan', '{}', 'active')",
          [randomUUID(), a.workspaceId],
        ),
        "clients",
      );
    });
  });

  it("plans (global config) stays readable in any tenant context — fail-closed is tenancy, not dead grants", async () => {
    await asKernel(null, async (tx) => {
      const res = await tx.query("SELECT code FROM plans");
      expect(res.rows.length).toBeGreaterThan(0);
    });
  });
});

describe("deliberate kernel-workspace-filter-bypass through real dispatch (§7, §20.4)", () => {
  it("an action that drops every workspace filter still sees and writes zero cross-tenant rows", async () => {
    const envelope = await kernel.dispatch(managerA, {
      name: "test.rls_filter_bypass",
      input: { probePersonId: b.personId, probeClientId: b.clientId },
      idempotencyKey: `${runTag}:bypass`,
    });

    expect(envelope.status).toBe("ok");
    expect(envelope.result).toEqual({
      workspaceIdsSeen: [a.workspaceId],
      personRowsSeen: 0,
      clientRowsSeen: 0,
      personRowsWritten: 0,
    });

    // The cross-tenant write really did nothing: workspace B's row is intact.
    const bPerson = await admin.query<{ display_name: string }>(
      "SELECT display_name FROM persons WHERE id = $1",
      [b.personId],
    );
    expect(bPerson.rows[0]?.display_name).toBe("Manager b");
  });
});
