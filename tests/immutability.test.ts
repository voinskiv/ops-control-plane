// SLICE-002 immutability enforcement (§6, §20.6, F4, F30):
// - audit_events rejects all UPDATE/DELETE (privileges revoked outright);
// - execution_records/proofs reject any non-kernel UPDATE (missing the
//   kernel-set app.kernel_op GUC) and any UPDATE touching a fact
//   (non-status) column; DELETE is revoked;
// - kernel-driven status-only transitions pass.
// Fixture rows are inserted with direct SQL as the migration owner: the action
// kernel does not exist until SLICE-003, and trigger/privilege enforcement can
// only be exercised against existing rows. This is SQL-test scaffolding, not
// seed data (DEC-004 governs db/seed only).
import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { connect, type DbClient } from "@core/db/client";

let db: DbClient;

const workspaceId = randomUUID();
const recordId = randomUUID();
const proofId = randomUUID();
const auditEventId = randomUUID();

async function setKernelOp(value: string): Promise<void> {
  await db.query("SELECT set_config('app.kernel_op', $1, false)", [value]);
}

function expectRejection(promise: Promise<unknown>, messagePart: string): Promise<void> {
  return expect(promise).rejects.toMatchObject({
    code: "42501",
    message: expect.stringContaining(messagePart) as unknown,
  });
}

beforeAll(async () => {
  db = await connect(inject("databaseUrl"));

  const clientId = randomUUID();
  const siteId = randomUUID();
  const commitmentId = randomUUID();
  const windowId = randomUUID();
  const personId = randomUUID();

  await db.query(
    "INSERT INTO plans (code, name, limits, price) VALUES ('test-immutability', 'Test', '{}', '{}')",
  );
  await db.query(
    `INSERT INTO workspaces (id, name, slug, plan_code, settings, status)
     VALUES ($1, 'Test GmbH', 'test-immutability', 'test-immutability', '{}', 'active')`,
    [workspaceId],
  );
  await db.query(
    `INSERT INTO clients (id, workspace_id, name, contact, status)
     VALUES ($1, $2, 'Client', '{}', 'active')`,
    [clientId, workspaceId],
  );
  await db.query(
    `INSERT INTO sites (id, workspace_id, client_id, name, address, settings, status)
     VALUES ($1, $2, $3, 'Site', '{}', '{}', 'active')`,
    [siteId, workspaceId, clientId],
  );
  await db.query(
    `INSERT INTO commitments (id, workspace_id, client_id, site_id, type, title, spec,
       schedule_rrule, target_qty, unit, verification, valid_from, valid_to, status)
     VALUES ($1, $2, $3, $4, 'coverage', 'Coverage', '{}', 'FREQ=DAILY', 2, 'persons',
       '{}', '2026-07-01', '2026-12-31', 'active')`,
    [commitmentId, workspaceId, clientId, siteId],
  );
  await db.query(
    `INSERT INTO execution_windows (id, workspace_id, commitment_id, site_id, date,
       starts_at, ends_at, target_qty, unit, requirements, fulfillment, status)
     VALUES ($1, $2, $3, $4, '2026-07-05', '2026-07-05T06:00:00Z', '2026-07-05T14:00:00Z',
       2, 'persons', '{}', '{}', 'open')`,
    [windowId, workspaceId, commitmentId, siteId],
  );
  await db.query(
    `INSERT INTO execution_records (id, workspace_id, window_id, kind, qty, unit,
       occurred_at, received_at, captured_by_actor, client_key, status)
     VALUES ($1, $2, $3, 'coverage_confirm', 2, 'persons', now(), now(), $4, $5, 'verified')`,
    [recordId, workspaceId, windowId, JSON.stringify({ actor_type: "person", actor_id: personId }), randomUUID()],
  );
  await db.query(
    `INSERT INTO proofs (id, workspace_id, record_id, type, storage_path, content_hash,
       captured_at, status)
     VALUES ($1, $2, $3, 'photo', $4, 'hash', now(), 'pending_upload')`,
    [proofId, workspaceId, recordId, `ws/${workspaceId}/proofs/${proofId}.jpg`],
  );
  await db.query(
    `INSERT INTO audit_events (id, workspace_id, actor_type, actor_id, action,
       entity_type, entity_id, after, at)
     VALUES ($1, $2, 'person', $3, 'record.capture', 'execution_records', $4, '{}', now())`,
    [auditEventId, workspaceId, personId, recordId],
  );

  // Everything below runs as the RLS-subject kernel role (§7, F13).
  await db.query("SET ROLE app_kernel");
  await db.query("SELECT set_config('app.workspace_id', $1, false)", [workspaceId]);
});

afterAll(async () => {
  await db.end();
});

describe("audit_events is append-only (§6, §20.6)", () => {
  it("rejects UPDATE outright", async () => {
    await expectRejection(
      db.query("UPDATE audit_events SET action = 'tampered' WHERE id = $1", [auditEventId]),
      "permission denied",
    );
  });

  it("rejects DELETE outright", async () => {
    await expectRejection(
      db.query("DELETE FROM audit_events WHERE id = $1", [auditEventId]),
      "permission denied",
    );
  });
});

describe("execution_records facts are immutable (F4, §20.6)", () => {
  it("rejects a non-kernel UPDATE (app.kernel_op not set) even for a status column", async () => {
    await setKernelOp("");
    await expectRejection(
      db.query("UPDATE execution_records SET status = 'voided' WHERE id = $1", [recordId]),
      "app.kernel_op is not set",
    );
  });

  it("rejects an UPDATE touching a fact column even with kernel context", async () => {
    await setKernelOp("record.supersede");
    await expectRejection(
      db.query("UPDATE execution_records SET qty = 99 WHERE id = $1", [recordId]),
      "touches a fact column",
    );
  });

  it("rejects a mixed status+fact UPDATE with kernel context", async () => {
    await setKernelOp("record.void");
    await expectRejection(
      db.query(
        "UPDATE execution_records SET status = 'voided', occurred_at = now() WHERE id = $1",
        [recordId],
      ),
      "touches a fact column",
    );
  });

  it("rejects DELETE", async () => {
    await setKernelOp("record.void");
    await expectRejection(
      db.query("DELETE FROM execution_records WHERE id = $1", [recordId]),
      "permission denied",
    );
  });

  it("allows a kernel-driven status-only transition", async () => {
    await setKernelOp("record.void");
    await db.query("UPDATE execution_records SET status = 'voided' WHERE id = $1", [recordId]);
    const res = await db.query<{ status: string }>(
      "SELECT status FROM execution_records WHERE id = $1",
      [recordId],
    );
    expect(res.rows[0]?.status).toBe("voided");
  });
});

describe("proofs facts are immutable (F4, §20.6)", () => {
  it("rejects a non-kernel UPDATE (app.kernel_op not set) even for a status column", async () => {
    await setKernelOp("");
    await expectRejection(
      db.query("UPDATE proofs SET status = 'complete' WHERE id = $1", [proofId]),
      "app.kernel_op is not set",
    );
  });

  it("rejects an UPDATE touching a fact column even with kernel context", async () => {
    await setKernelOp("proof.complete_upload");
    await expectRejection(
      db.query("UPDATE proofs SET storage_path = 'tampered' WHERE id = $1", [proofId]),
      "touches a fact column",
    );
  });

  it("rejects DELETE", async () => {
    await setKernelOp("proof.complete_upload");
    await expectRejection(
      db.query("DELETE FROM proofs WHERE id = $1", [proofId]),
      "permission denied",
    );
  });

  it("allows a kernel-driven status-only transition", async () => {
    await setKernelOp("proof.complete_upload");
    await db.query("UPDATE proofs SET status = 'complete' WHERE id = $1", [proofId]);
    const res = await db.query<{ status: string }>("SELECT status FROM proofs WHERE id = $1", [
      proofId,
    ]);
    expect(res.rows[0]?.status).toBe("complete");
  });
});

describe("the F4 triggers bind every role, not just app_kernel", () => {
  it("rejects a non-kernel fact UPDATE even for the table owner (privileges are bypassed, triggers are not)", async () => {
    await db.query("RESET ROLE");
    await setKernelOp("");
    await expectRejection(
      db.query("UPDATE execution_records SET qty = 1 WHERE id = $1", [recordId]),
      "app.kernel_op is not set",
    );
  });
});
