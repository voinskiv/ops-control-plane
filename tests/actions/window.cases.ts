// Imported by commitment.test.ts so Phase-1 commitment/window integration
// shares one database test worker instead of competing with the seed gate.
import { randomUUID } from "node:crypto";

import { Temporal } from "@js-temporal/polyfill";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";

import { noopUnlimitedResolver } from "@core/actions/entitlement";
import { Kernel } from "@core/actions/kernel";
import { registry } from "@core/actions/registry";
import type { Actor, ResponseEnvelope } from "@core/actions/types";
import { generateRollingWindows, openDueWindows } from "@core/actions/window-cron";
import { createAuthDb, type AuthDb } from "@core/db/auth";
import { connect, type DbClient, type QueryResult, type QueryResultRow, type Queryable } from "@core/db/client";
import { createKernelDb, type KernelDb } from "@core/db/kernel";
import { GET as generateCron } from "../../app/api/cron/windows/generate/route";
import { GET as openCron } from "../../app/api/cron/windows/open/route";

export function registerWindowCases(): void {
describe("SLICE-014 window integration", () => {
let admin: DbClient;
let kernelDb: KernelDb;
let cronDb: AuthDb;
let kernel: Kernel;

const workspaceId = randomUUID();
const clientId = randomUUID();
const siteId = randomUUID();
const managerId = randomUUID();
const supervisorInId = randomUUID();
const supervisorOutId = randomUUID();
const runTag = `test-window-${randomUUID().slice(0, 8)}`;
const manager = { type: "person", id: managerId, roleClass: "manager", workspaceId } as const satisfies Actor;
const supervisorIn = { type: "person", id: supervisorInId, roleClass: "supervisor", workspaceId } as const satisfies Actor;
const supervisorOut = { type: "person", id: supervisorOutId, roleClass: "supervisor", workspaceId } as const satisfies Actor;
const system = { type: "system", workspaceId } as const satisfies Actor;
const originalCronSecret = process.env.CRON_SECRET;

function key(prefix = "window"): string {
  return `${prefix}:${randomUUID()}`;
}

function scopedDiscoveryDb(options: { commitmentIds?: string[]; windowIds?: string[] }): AuthDb {
  const discovery: Queryable = {
    async query<R extends QueryResultRow>(text: string): Promise<QueryResult<R>> {
      const rows = text.includes("app_generatable_commitments")
        ? (options.commitmentIds ?? []).map((commitment_id) => ({ workspace_id: workspaceId, commitment_id }))
        : (options.windowIds ?? []).map((window_id) => ({ workspace_id: workspaceId, window_id }));
      return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows: rows as unknown as R[] };
    },
  };
  return {
    withClient: (fn) => fn(discovery),
    withWorkspace: (id, fn) => cronDb.withWorkspace(id, fn),
    end: async () => undefined,
  };
}

async function dispatch(
  actor: Actor,
  name: "window.generate" | "window.open" | "commitment.update_spec",
  input: unknown,
  idempotencyKey = key(),
): Promise<ResponseEnvelope> {
  return kernel.dispatch(actor, { name, input, idempotencyKey });
}

async function insertCommitment(options: {
  status?: "draft" | "active" | "paused" | "completed";
  type?: "coverage" | "output" | "service_scope";
  rrule?: string;
  start?: string;
  end?: string;
  validFrom?: string;
  validTo?: string;
  target?: number;
} = {}): Promise<string> {
  const id = randomUUID();
  const type = options.type ?? "coverage";
  const spec = type === "service_scope"
    ? {
        window_start_time: options.start ?? "08:00",
        window_end_time: options.end ?? "16:00",
        checklist: [{ key: "floor", label: "Floor cleaned" }],
      }
    : { window_start_time: options.start ?? "08:00", window_end_time: options.end ?? "16:00" };
  await admin.query(
    `INSERT INTO commitments (id, workspace_id, client_id, site_id, type, title, spec,
       schedule_rrule, target_qty, unit, verification, valid_from, valid_to, status)
     VALUES ($1, $2, $3, $4, $5, 'Window fixture', $6, $7, $8, $9,
       '{"proof":{"required":false}}', $10, $11, $12)`,
    [
      id,
      workspaceId,
      clientId,
      siteId,
      type,
      spec,
      options.rrule ?? "FREQ=DAILY",
      type === "service_scope" ? null : (options.target ?? 5),
      type === "output" ? "pieces" : null,
      options.validFrom ?? "2026-01-01",
      options.validTo ?? "2026-12-31",
      options.status ?? "active",
    ],
  );
  return id;
}

async function insertWindow(
  status: "scheduled" | "open" = "scheduled",
  startsAt = "2026-01-01T08:00:00Z",
): Promise<string> {
  const commitmentId = await insertCommitment();
  const id = randomUUID();
  await admin.query(
    `INSERT INTO execution_windows (id, workspace_id, commitment_id, site_id, date,
       starts_at, ends_at, target_qty, requirements, fulfillment, status)
     VALUES ($1, $2, $3, $4, '2026-01-01', $5, '2026-01-01T16:00:00Z', 5,
       '{"verification":{"proof":{"required":false}}}', '{}', $6)`,
    [id, workspaceId, commitmentId, siteId, startsAt, status],
  );
  return id;
}

async function windowRow(windowId: string): Promise<Record<string, unknown>> {
  const result = await admin.query<Record<string, unknown>>(
    `SELECT id, workspace_id, commitment_id, site_id, date::text AS date,
       starts_at, ends_at, target_qty, unit, requirements, fulfillment,
       closed_by, closed_at, report_id, status, created_at
     FROM execution_windows WHERE id = $1`,
    [windowId],
  );
  return result.rows[0]!;
}

async function generatedWindowId(envelope: ResponseEnvelope): Promise<string> {
  expect(envelope.status).toBe("ok");
  return (envelope.result as { window_id: string }).window_id;
}

beforeAll(async () => {
  const url = inject("databaseUrl");
  admin = await connect(url);
  kernelDb = createKernelDb(url);
  cronDb = createAuthDb(url);
  kernel = new Kernel(kernelDb, registry, noopUnlimitedResolver);
  await admin.query(
    `INSERT INTO workspaces (id, name, slug, plan_code, settings, status)
     VALUES ($1, 'Window Test GmbH', $2, 'pilot', '{"tz":"Europe/Berlin"}', 'active')`,
    [workspaceId, runTag],
  );
  await admin.query(
    `INSERT INTO persons (id, workspace_id, display_name, role_class, locale, status)
     VALUES ($1, $3, 'Manager', 'manager', 'de', 'active'),
            ($2, $3, 'Supervisor in', 'supervisor', 'de', 'active'),
            ($4, $3, 'Supervisor out', 'supervisor', 'de', 'active')`,
    [managerId, supervisorInId, workspaceId, supervisorOutId],
  );
  await admin.query(
    "INSERT INTO clients (id, workspace_id, name, contact, status) VALUES ($1, $2, 'Window Client', '{}', 'active')",
    [clientId, workspaceId],
  );
  await admin.query(
    `INSERT INTO sites (id, workspace_id, client_id, name, address, settings, status)
     VALUES ($1, $2, $3, 'Window Site', '{}', $4, 'active')`,
    [siteId, workspaceId, clientId, { supervisor_person_ids: [supervisorInId] }],
  );
});

afterAll(async () => {
  await cronDb.end();
  await kernelDb.end();
  await admin.end();
});

afterEach(() => {
  if (originalCronSecret === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = originalCronSecret;
});

describe("window cron HTTP mounts (§21.17)", () => {
  it("both fail closed without the exact CRON_SECRET bearer", async () => {
    for (const [path, handler] of [
      ["generate", generateCron],
      ["open", openCron],
    ] as const) {
      delete process.env.CRON_SECRET;
      await expect(handler(new Request(`http://localhost/api/cron/windows/${path}`))).resolves.toMatchObject({ status: 401 });
      process.env.CRON_SECRET = "window-test-secret";
      await expect(handler(new Request(`http://localhost/api/cron/windows/${path}`, {
        headers: { authorization: "Bearer wrong" },
      }))).resolves.toMatchObject({ status: 401 });
    }
  });
});

describe("window.generate (§4/§5/§21.9)", () => {
  it("freezes targets, type-derived requirements, and timezone-correct instants", async () => {
    const commitmentId = await insertCommitment({ type: "service_scope", start: "02:30", end: "04:00" });
    const auditKey = key("generate-audit");
    const windowId = await generatedWindowId(await dispatch(system, "window.generate", {
      commitment_id: commitmentId,
      date: "2026-10-25",
    }, auditKey));
    expect(await windowRow(windowId)).toMatchObject({
      commitment_id: commitmentId,
      starts_at: new Date("2026-10-25T00:30:00Z"),
      ends_at: new Date("2026-10-25T03:00:00Z"),
      target_qty: null,
      unit: null,
      requirements: {
        verification: { proof: { required: false } },
        checklist: [{ key: "floor", label: "Floor cleaned" }],
      },
      status: "scheduled",
    });
    const audit = await admin.query<{ extras: unknown }>(
      `SELECT a.extras FROM audit_events a JOIN action_invocations i ON i.id = a.invocation_id
       WHERE i.idempotency_key = $1`,
      [auditKey],
    );
    expect(audit.rows[0]?.extras).toEqual({
      frozen_targets: {
        target_qty: null,
        unit: null,
        requirements: {
          verification: { proof: { required: false } },
          checklist: [{ key: "floor", label: "Floor cleaned" }],
        },
      },
    });
  });

  it("rejects inactive commitments by state and invalid dates/RRULEs by validation", async () => {
    const paused = await insertCommitment({ status: "paused" });
    await expect(dispatch(system, "window.generate", { commitment_id: paused, date: "2026-07-13" }))
      .resolves.toMatchObject({ status: "rejected", result: { code: "window_wrong_state" } });
    const active = await insertCommitment({ rrule: "FREQ=WEEKLY;BYDAY=MO", validFrom: "2026-07-01" });
    await expect(dispatch(system, "window.generate", { commitment_id: active, date: "2026-07-14" }))
      .resolves.toMatchObject({ status: "rejected", result: { code: "validation_failed" } });
    const invalid = await insertCommitment({ rrule: "broken" });
    await expect(dispatch(system, "window.generate", { commitment_id: invalid, date: "2026-07-13" }))
      .resolves.toMatchObject({ status: "rejected", result: { code: "validation_failed" } });
  });

  it("leaves a generated window byte-unchanged after active commitment.update_spec (§20.11)", async () => {
    const commitmentId = await insertCommitment({ target: 5 });
    const windowId = await generatedWindowId(await dispatch(system, "window.generate", {
      commitment_id: commitmentId,
      date: "2026-11-02",
    }, `window.generate:${commitmentId}:2026-11-02`));
    const before = JSON.stringify(await windowRow(windowId));
    await expect(dispatch(manager, "commitment.update_spec", { commitment_id: commitmentId, target_qty: 9 }))
      .resolves.toMatchObject({ status: "ok" });
    expect(JSON.stringify(await windowRow(windowId))).toBe(before);
  });
});

describe("rolling generation cron (DEC-023)", () => {
  it("is duplicate-free on same-day reruns and a shifted next-day horizon", async () => {
    const commitmentId = await insertCommitment({ validFrom: "2020-01-01", validTo: "2100-12-31" });
    const dayOne = Temporal.Instant.from("2026-07-13T10:00:00Z");
    const db = scopedDiscoveryDb({ commitmentIds: [commitmentId] });
    await generateRollingWindows(db, kernel, dayOne);
    await generateRollingWindows(db, kernel, dayOne);
    await generateRollingWindows(db, kernel, dayOne.add({ hours: 24 }));
    const rows = await admin.query<{ date: string }>(
      "SELECT date::text AS date FROM execution_windows WHERE commitment_id = $1 ORDER BY date",
      [commitmentId],
    );
    expect(rows.rows.map((row) => row.date)).toEqual([
      "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16",
      "2026-07-17", "2026-07-18", "2026-07-19", "2026-07-20",
    ]);
  });

  it("records malformed stored RRULE as validation_failed without crashing cron", async () => {
    const commitmentId = await insertCommitment({ rrule: "not-an-rrule", validFrom: "2020-01-01", validTo: "2100-12-31" });
    await expect(generateRollingWindows(
      scopedDiscoveryDb({ commitmentIds: [commitmentId] }),
      kernel,
      Temporal.Instant.from("2026-07-13T10:00:00Z"),
    )).resolves.toBeUndefined();
    const invocation = await admin.query<{ status: string; result: unknown }>(
      "SELECT status, result FROM action_invocations WHERE workspace_id = $1 AND idempotency_key = $2",
      [workspaceId, `window.generate:${commitmentId}:2026-07-13`],
    );
    expect(invocation.rows[0]).toMatchObject({ status: "rejected", result: { status: "rejected", result: { code: "validation_failed" } } });
  });
});

describe("window.open state and supervisor scope (§4/§8/F12)", () => {
  it("allows an in-scope supervisor and rejects an out-of-scope supervisor", async () => {
    const allowed = await insertWindow();
    await expect(dispatch(supervisorIn, "window.open", { window_id: allowed })).resolves.toMatchObject({ status: "ok" });
    const denied = await insertWindow();
    await expect(dispatch(supervisorOut, "window.open", { window_id: denied }))
      .resolves.toMatchObject({ status: "rejected", result: { code: "unauthorized" } });
    expect(await windowRow(denied)).toMatchObject({ status: "scheduled" });
    await admin.query(
      "UPDATE sites SET settings = $1 WHERE id = $2",
      [{ supervisor_person_ids: [supervisorInId, supervisorOutId] }, siteId],
    );
    await expect(dispatch(supervisorOut, "window.open", { window_id: denied }))
      .resolves.toMatchObject({ status: "ok" });
  });

  it("permits workspace-wide managers and rejects non-scheduled states", async () => {
    const scheduled = await insertWindow();
    await expect(dispatch(manager, "window.open", { window_id: scheduled })).resolves.toMatchObject({ status: "ok" });
    await expect(dispatch(manager, "window.open", { window_id: scheduled }))
      .resolves.toMatchObject({ status: "rejected", result: { code: "window_wrong_state" } });
    const open = await insertWindow("open");
    await expect(dispatch(system, "window.open", { window_id: open }))
      .resolves.toMatchObject({ status: "rejected", result: { code: "window_wrong_state" } });
  });

  it("makes an early-open/cron race terminal as success/replay or window_wrong_state", async () => {
    const windowId = await insertWindow("scheduled", "2026-01-01T08:00:00Z");
    const [human] = await Promise.all([
      dispatch(supervisorIn, "window.open", { window_id: windowId }, key("early-open")),
      openDueWindows(scopedDiscoveryDb({ windowIds: [windowId] }), kernel),
    ]);
    expect(
      human.status === "ok" ||
      (human.status === "rejected" && (human.result as { code?: string }).code === "window_wrong_state"),
    ).toBe(true);
    expect(await windowRow(windowId)).toMatchObject({ status: "open" });
    const events = await admin.query<{ n: string }>(
      "SELECT count(*) AS n FROM audit_events WHERE entity_type = 'execution_windows' AND entity_id = $1 AND action = 'window.open'",
      [windowId],
    );
    expect(Number(events.rows[0]?.n)).toBe(1);
  });
});
});
}
