import { execFileSync } from "node:child_process";

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { connect, type DbClient } from "@core/db/client";
import { seedDemoGmbH } from "../db/seed";

let db: DbClient;

beforeAll(async () => {
  db = await connect(inject("databaseUrl"));
});

afterAll(async () => {
  await db.end();
});

async function fixtureCounts(workspaceId: string): Promise<Record<string, number>> {
  const result = await db.query<{
    persons: string;
    clients: string;
    sites: string;
    active_sites: string;
    draft_sites: string;
    commitments: string;
    windows: string;
    devices: string;
    invocations: string;
    audits: string;
  }>(
    `SELECT
       (SELECT count(*) FROM persons WHERE workspace_id = $1) AS persons,
       (SELECT count(*) FROM clients WHERE workspace_id = $1) AS clients,
       (SELECT count(*) FROM sites WHERE workspace_id = $1) AS sites,
       (SELECT count(*) FROM sites WHERE workspace_id = $1 AND status = 'active') AS active_sites,
       (SELECT count(*) FROM sites WHERE workspace_id = $1 AND status = 'draft') AS draft_sites,
       (SELECT count(*) FROM commitments WHERE workspace_id = $1) AS commitments,
       (SELECT count(*) FROM execution_windows WHERE workspace_id = $1) AS windows,
       (SELECT count(*) FROM auth_devices WHERE workspace_id = $1) AS devices,
       (SELECT count(*) FROM action_invocations WHERE workspace_id = $1) AS invocations,
       (SELECT count(*) FROM audit_events WHERE workspace_id = $1) AS audits`,
    [workspaceId],
  );
  return Object.fromEntries(Object.entries(result.rows[0]!).map(([key, value]) => [key, Number(value)]));
}

describe("SLICE-011 Demo GmbH kernel-replay seed", () => {
  it("exposes a repeat-safe migration command for an already-migrated database", () => {
    const output = execFileSync("npm", ["run", "db:migrate"], {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: inject("databaseUrl") },
    });
    expect(output).toContain("Applied 0 migration(s).");
  });

  it("creates the Phase 0 fixture and a second run adds no rows or audit events", async () => {
    const first = await seedDemoGmbH(inject("databaseUrl"));
    const firstCounts = await fixtureCounts(first.workspaceId);
    expect(firstCounts).toEqual({
      persons: 10,
      clients: 2,
      sites: 4,
      active_sites: 3,
      draft_sites: 1,
      commitments: 0,
      windows: 0,
      devices: 0,
      invocations: 20,
      audits: 20,
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

    const invocationKeys = await db.query<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM action_invocations WHERE workspace_id = $1 ORDER BY idempotency_key",
      [first.workspaceId],
    );
    expect(invocationKeys.rows).toHaveLength(20);
    expect(
      invocationKeys.rows.every(({ idempotency_key }) => idempotency_key.startsWith("seed:demo-gmbh:phase0:v1:")),
    ).toBe(true);

    const activationActors = await db.query<{ actor_id: string | null }>(
      "SELECT actor_id FROM audit_events WHERE workspace_id = $1 AND action = 'site.activate'",
      [first.workspaceId],
    );
    expect(activationActors.rows).toHaveLength(3);
    expect(activationActors.rows.every(({ actor_id }) => actor_id === first.ownerId)).toBe(true);

    const second = await seedDemoGmbH(inject("databaseUrl"));
    expect(second).toEqual(first);
    expect(await fixtureCounts(first.workspaceId)).toEqual(firstCounts);
  });
});
