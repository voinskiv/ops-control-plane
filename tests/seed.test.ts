import { execFileSync } from "node:child_process";

import { Temporal } from "@js-temporal/polyfill";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { connect, type DbClient } from "@core/db/client";
import { localHorizon, occurrenceDates } from "@core/domain/window-schedule";
import { DEMO_PHASE_1_COMMITMENT_FIXTURES, seedDemoGmbH } from "../db/seed";

let db: DbClient;

const FIXED_NOW = Temporal.Instant.from("2026-07-13T10:00:00Z");
const SHIFTED_NOW = Temporal.Instant.from("2026-07-14T10:00:00Z");
const WORKSPACE_TABLES = [
  "workspaces",
  "persons",
  "auth_devices",
  "clients",
  "sites",
  "commitments",
  "reports",
  "execution_windows",
  "assignments",
  "execution_records",
  "proofs",
  "exceptions",
  "escalation_rules",
  "escalation_events",
  "action_invocations",
  "agent_proposals",
  "recovery_actions",
  "report_shares",
  "documents",
  "audit_events",
  "outbound_messages",
] as const;

type WorkspaceTable = (typeof WORKSPACE_TABLES)[number];
type WorkspaceSnapshot = Record<WorkspaceTable, Record<string, unknown>[]>;

beforeAll(async () => {
  db = await connect(inject("databaseUrl"));
});

afterAll(async () => {
  await db.end();
});

async function workspaceSnapshot(workspaceId: string): Promise<WorkspaceSnapshot> {
  const snapshot = {} as WorkspaceSnapshot;
  for (const table of WORKSPACE_TABLES) {
    const predicate = table === "workspaces" ? "id = $1" : "workspace_id = $1";
    const selection = table === "execution_windows" ? "*, date::text AS date" : "*";
    const result = await db.query<Record<string, unknown>>(
      `SELECT ${selection} FROM ${table} WHERE ${predicate} ORDER BY id`,
      [workspaceId],
    );
    snapshot[table] = result.rows;
  }
  return snapshot;
}

function snapshotCounts(snapshot: WorkspaceSnapshot): Record<WorkspaceTable, number> {
  return Object.fromEntries(WORKSPACE_TABLES.map((table) => [table, snapshot[table].length])) as Record<
    WorkspaceTable,
    number
  >;
}

function expectedWindowPairs(commitmentIds: readonly string[], now: Temporal.Instant): string[] {
  const horizon = localHorizon(now, "Europe/Berlin");
  return DEMO_PHASE_1_COMMITMENT_FIXTURES.flatMap((fixture, index) => {
    const rangeStart = fixture.input.valid_from > horizon.start ? fixture.input.valid_from : horizon.start;
    const validEndExclusive = Temporal.PlainDate.from(fixture.input.valid_to).add({ days: 1 }).toString();
    const rangeEnd = validEndExclusive < horizon.endExclusive ? validEndExclusive : horizon.endExclusive;
    return rangeStart >= rangeEnd
      ? []
      : occurrenceDates(fixture.input.schedule_rrule, fixture.input.valid_from, rangeStart, rangeEnd).map(
          (date) => `${commitmentIds[index]}:${date}`,
        );
  }).sort();
}

function rowIds(rows: Record<string, unknown>[]): Set<unknown> {
  return new Set(rows.map((row) => row.id));
}

function existingRows(rows: Record<string, unknown>[], ids: Set<unknown>): Record<string, unknown>[] {
  return rows.filter((row) => ids.has(row.id));
}

describe("SLICE-014A Demo GmbH kernel-replay seed extension", () => {
  it("exposes a repeat-safe migration command for an already-migrated database", () => {
    const output = execFileSync("npm", ["run", "db:migrate"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: inject("databaseUrl") },
    });
    expect(output).toContain("Applied 0 migration(s).");
  });

  it("creates the pinned Phase 0/1 fixture, rolls forward, and remains replay-safe", async () => {
    const first = await seedDemoGmbH(inject("databaseUrl"), FIXED_NOW);
    const firstExpectedPairs = expectedWindowPairs(first.commitmentIds, FIXED_NOW);
    const firstSnapshot = await workspaceSnapshot(first.workspaceId);
    expect(snapshotCounts(firstSnapshot)).toEqual({
      workspaces: 1,
      persons: 10,
      auth_devices: 0,
      clients: 2,
      sites: 4,
      commitments: 3,
      reports: 0,
      execution_windows: firstExpectedPairs.length,
      assignments: 0,
      execution_records: 0,
      proofs: 0,
      exceptions: 0,
      escalation_rules: 0,
      escalation_events: 0,
      action_invocations: 26 + firstExpectedPairs.length,
      agent_proposals: 0,
      recovery_actions: 0,
      report_shares: 0,
      documents: 0,
      audit_events: 26 + firstExpectedPairs.length,
      outbound_messages: 0,
    });

    const workspace = await db.query<{ name: string; settings: unknown }>(
      "SELECT name, settings FROM workspaces WHERE id = $1",
      [first.workspaceId],
    );
    expect(workspace.rows[0]).toEqual({
      name: "Demo GmbH",
      settings: {
        tz: "Europe/Berlin",
        default_locale: "de",
        branding: {},
        action_policies: {},
        retention_months: 24,
      },
    });

    const people = await db.query<{
      role_class: string;
      email: string | null;
      auth_user_id: string | null;
    }>("SELECT role_class, email, auth_user_id FROM persons WHERE workspace_id = $1", [first.workspaceId]);
    expect(people.rows.filter((person) => person.role_class === "worker")).toHaveLength(6);
    expect(people.rows.filter((person) => person.role_class === "worker").every((person) => person.email === null)).toBe(
      true,
    );
    expect(people.rows.filter((person) => person.role_class !== "worker").every((person) => person.email !== null)).toBe(
      true,
    );
    expect(people.rows.every((person) => person.auth_user_id === null)).toBe(true);

    const siteRows = await db.query<{ address: unknown; settings: unknown; status: string }>(
      "SELECT address, settings, status FROM sites WHERE workspace_id = $1 ORDER BY name",
      [first.workspaceId],
    );
    expect(siteRows.rows.every((site) => (site.address as { country?: string }).country === "DE")).toBe(true);
    expect(
      siteRows.rows.every(
        (site) => ((site.settings as { supervisor_person_ids?: string[] }).supervisor_person_ids?.length ?? 0) > 0,
      ),
    ).toBe(true);

    const commitmentRows = await db.query<{
      id: string;
      site_id: string;
      type: string;
      title: string;
      spec: unknown;
      schedule_rrule: string;
      target_qty: string | null;
      unit: string | null;
      verification: unknown;
      valid_from: string;
      valid_to: string;
      status: string;
    }>(
      `SELECT id, site_id, type, title, spec, schedule_rrule, target_qty, unit, verification,
         valid_from::text, valid_to::text, status
       FROM commitments WHERE workspace_id = $1 ORDER BY id`,
      [first.workspaceId],
    );
    expect(new Set(commitmentRows.rows.map(({ site_id }) => site_id))).toEqual(new Set(first.siteIds.slice(0, 3)));
    expect(commitmentRows.rows.some(({ site_id }) => site_id === first.siteIds[3])).toBe(false);
    for (const [index, fixture] of DEMO_PHASE_1_COMMITMENT_FIXTURES.entries()) {
      expect(commitmentRows.rows.find(({ id }) => id === first.commitmentIds[index])).toMatchObject({
        site_id: first.siteIds[fixture.siteIndex],
        type: fixture.input.type,
        title: fixture.input.title,
        spec: fixture.input.spec,
        schedule_rrule: fixture.input.schedule_rrule,
        target_qty: "target_qty" in fixture.input ? String(fixture.input.target_qty) : null,
        unit: "unit" in fixture.input ? fixture.input.unit : null,
        verification:
          "verification" in fixture.input ? fixture.input.verification : { proof: { required: false } },
        valid_from: "2026-07-01",
        valid_to: "2027-12-31",
        status: "active",
      });
    }

    const firstWindowPairs = firstSnapshot.execution_windows
      .map((row) => `${row.commitment_id}:${row.date}`)
      .sort();
    expect(firstWindowPairs).toEqual(firstExpectedPairs);
    const tomorrow = Temporal.PlainDate.from(localHorizon(FIXED_NOW, "Europe/Berlin").start).add({ days: 1 }).toString();
    expect(firstSnapshot.execution_windows.some((row) => row.date === tomorrow)).toBe(true);

    const overnightWindow = firstSnapshot.execution_windows.find(
      (row) => row.commitment_id === first.commitmentIds[1],
    );
    expect(overnightWindow).toBeDefined();
    const overnightDate = Temporal.PlainDate.from(String(overnightWindow!.date));
    expect(
      Temporal.Instant.from(new Date(overnightWindow!.ends_at as string | Date).toISOString())
        .toZonedDateTimeISO("Europe/Berlin")
        .toPlainDate()
        .equals(overnightDate.add({ days: 1 })),
    ).toBe(true);

    const invocationKeys = await db.query<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM action_invocations WHERE workspace_id = $1 ORDER BY idempotency_key",
      [first.workspaceId],
    );
    expect(invocationKeys.rows).toHaveLength(26 + firstExpectedPairs.length);
    expect(invocationKeys.rows.filter(({ idempotency_key }) => idempotency_key.startsWith("seed:demo-gmbh:phase0:v1:"))).toHaveLength(20);
    expect(invocationKeys.rows.filter(({ idempotency_key }) => idempotency_key.startsWith("seed:demo-gmbh:phase1:v1:"))).toHaveLength(6);
    expect(invocationKeys.rows.filter(({ idempotency_key }) => idempotency_key.startsWith("window.generate:"))).toHaveLength(firstExpectedPairs.length);

    const activationActors = await db.query<{ actor_id: string | null }>(
      "SELECT actor_id FROM audit_events WHERE workspace_id = $1 AND action = 'site.activate'",
      [first.workspaceId],
    );
    expect(activationActors.rows).toHaveLength(3);
    expect(activationActors.rows.every(({ actor_id }) => actor_id === first.ownerId)).toBe(true);

    const second = await seedDemoGmbH(inject("databaseUrl"), FIXED_NOW);
    expect(second).toEqual(first);
    expect(await workspaceSnapshot(first.workspaceId)).toEqual(firstSnapshot);

    const shiftedExpectedPairs = expectedWindowPairs(first.commitmentIds, SHIFTED_NOW);
    const newlyExpectedPairs = shiftedExpectedPairs.filter((pair) => !firstExpectedPairs.includes(pair));
    const third = await seedDemoGmbH(inject("databaseUrl"), SHIFTED_NOW);
    expect(third).toEqual(first);
    const thirdSnapshot = await workspaceSnapshot(first.workspaceId);
    expect(snapshotCounts(thirdSnapshot)).toEqual({
      ...snapshotCounts(firstSnapshot),
      execution_windows: firstExpectedPairs.length + newlyExpectedPairs.length,
      action_invocations: firstSnapshot.action_invocations.length + newlyExpectedPairs.length,
      audit_events: firstSnapshot.audit_events.length + newlyExpectedPairs.length,
    });

    const appendOnlyTables = new Set<WorkspaceTable>(["execution_windows", "action_invocations", "audit_events"]);
    for (const table of WORKSPACE_TABLES) {
      if (!appendOnlyTables.has(table)) expect(thirdSnapshot[table]).toEqual(firstSnapshot[table]);
    }
    for (const table of appendOnlyTables) {
      expect(existingRows(thirdSnapshot[table], rowIds(firstSnapshot[table]))).toEqual(firstSnapshot[table]);
    }

    const firstWindowIds = rowIds(firstSnapshot.execution_windows);
    const appendedWindows = thirdSnapshot.execution_windows.filter((row) => !firstWindowIds.has(row.id));
    expect(appendedWindows.map((row) => `${row.commitment_id}:${row.date}`).sort()).toEqual(newlyExpectedPairs);

    const firstInvocationIds = rowIds(firstSnapshot.action_invocations);
    const appendedInvocations = thirdSnapshot.action_invocations.filter((row) => !firstInvocationIds.has(row.id));
    expect(appendedInvocations.every((row) => row.action_name === "window.generate")).toBe(true);
    expect(appendedInvocations.map((row) => row.idempotency_key).sort()).toEqual(
      newlyExpectedPairs.map((pair) => `window.generate:${pair}`).sort(),
    );

    const firstAuditIds = rowIds(firstSnapshot.audit_events);
    const appendedAudits = thirdSnapshot.audit_events.filter((row) => !firstAuditIds.has(row.id));
    expect(appendedAudits).toHaveLength(newlyExpectedPairs.length);
    expect(appendedAudits.every((row) => row.action === "window.generate")).toBe(true);
  });
});
