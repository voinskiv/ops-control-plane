// SLICE-002 schema conformance (§3 conventions, §21.4, §21.5, §21.7, DEC-005).
// Runs against the migrated database provided by tests/helpers/global-setup.ts.
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";

import { connect, type DbClient } from "@core/db/client";
import { drizzleSchemaColumns } from "@core/db/schema";

// The 22 §3 tables.
const DOMAIN_TABLES = [
  "action_invocations",
  "agent_proposals",
  "assignments",
  "audit_events",
  "auth_devices",
  "clients",
  "commitments",
  "documents",
  "escalation_events",
  "escalation_rules",
  "exceptions",
  "execution_records",
  "execution_windows",
  "outbound_messages",
  "persons",
  "plans",
  "proofs",
  "recovery_actions",
  "report_shares",
  "reports",
  "sites",
  "workspaces",
] as const;

// Tenant tables carry workspace_id (§3): every §3 table except the global
// config table (plans) and the tenant root itself (workspaces).
const TENANT_TABLES = DOMAIN_TABLES.filter((t) => t !== "plans" && t !== "workspaces");

let db: DbClient;

beforeAll(async () => {
  db = await connect(inject("databaseUrl"));
});

afterAll(async () => {
  await db.end();
});

describe("§3 schema conventions", () => {
  it("public schema contains exactly the §3 tables plus schema_migrations", async () => {
    const res = await db.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const expected = [...DOMAIN_TABLES, "schema_migrations"].sort();
    expect(res.rows.map((r) => r.tablename)).toEqual(expected);
  });

  it("every migration in db/migrations is recorded as applied", async () => {
    const files = (await readdir(join(process.cwd(), "db", "migrations")))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const res = await db.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version",
    );
    expect(files.length).toBeGreaterThanOrEqual(3);
    expect(res.rows.map((r) => r.version)).toEqual(files);
  });

  it("every tenant table has workspace_id uuid NOT NULL (§21.5)", async () => {
    const res = await db.query<{ relname: string; attnotnull: boolean; type: string }>(
      `SELECT c.relname, a.attnotnull, format_type(a.atttypid, a.atttypmod) AS type
       FROM pg_class c
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'workspace_id'
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'`,
    );
    const byTable = new Map(res.rows.map((r) => [r.relname, r]));
    for (const table of TENANT_TABLES) {
      const col = byTable.get(table);
      expect(col, `${table}.workspace_id`).toBeDefined();
      expect(col?.attnotnull, `${table}.workspace_id NOT NULL`).toBe(true);
      expect(col?.type, `${table}.workspace_id type`).toBe("uuid");
    }
  });

  it("RLS is enabled on every table (§7)", async () => {
    const res = await db.query<{ relname: string }>(
      `SELECT relname FROM pg_class
       WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND NOT relrowsecurity`,
    );
    expect(res.rows.map((r) => r.relname)).toEqual([]);
  });

  it("every tenant table has an index leading with workspace_id (§21.5)", async () => {
    const res = await db.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
       AND EXISTS (
         SELECT 1 FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = i.indkey[0]
         WHERE i.indrelid = c.oid AND a.attname = 'workspace_id'
       )`,
    );
    const indexed = new Set(res.rows.map((r) => r.relname));
    for (const table of TENANT_TABLES) {
      expect(indexed.has(table), `${table} (workspace_id, …) index`).toBe(true);
    }
  });

  it("primary keys are uuid `id` columns without DB defaults — app-generated UUIDv7; plans keeps its text code PK (§21.4, F9)", async () => {
    const res = await db.query<{
      table_name: string;
      column_name: string;
      column_type: string;
      has_default: boolean;
    }>(
      `SELECT c.relname AS table_name, a.attname AS column_name,
              format_type(a.atttypid, a.atttypmod) AS column_type,
              a.atthasdef AS has_default
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY (i.indkey)
       WHERE i.indisprimary AND c.relnamespace = 'public'::regnamespace`,
    );
    const pks = new Map(res.rows.map((r) => [r.table_name, r]));
    for (const table of DOMAIN_TABLES) {
      const pk = pks.get(table);
      expect(pk, `${table} primary key`).toBeDefined();
      if (table === "plans") {
        expect(pk?.column_name).toBe("code");
        expect(pk?.column_type).toBe("text");
      } else {
        expect(pk?.column_name, `${table} PK column`).toBe("id");
        expect(pk?.column_type, `${table} PK type`).toBe("uuid");
        expect(pk?.has_default, `${table} PK must have no DB default`).toBe(false);
      }
    }
  });

  it("created_at timestamptz NOT NULL exists on every §3 table", async () => {
    const res = await db.query<{ relname: string }>(
      `SELECT c.relname FROM pg_class c
       WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
       AND EXISTS (
         SELECT 1 FROM pg_attribute a
         WHERE a.attrelid = c.oid AND a.attname = 'created_at' AND a.attnotnull
         AND format_type(a.atttypid, a.atttypmod) = 'timestamp with time zone'
       )`,
    );
    const withCreatedAt = new Set(res.rows.map((r) => r.relname));
    for (const table of DOMAIN_TABLES) {
      expect(withCreatedAt.has(table), `${table}.created_at`).toBe(true);
    }
  });

  it("Drizzle schema mirrors information_schema for every §3 table (SLICE-005)", async () => {
    const drizzleTables = drizzleSchemaColumns();
    expect(drizzleTables.map((table) => table.table).sort()).toEqual([...DOMAIN_TABLES].sort());

    const res = await db.query<{
      table_name: string;
      column_name: string;
      is_nullable: "YES" | "NO";
      data_type: string;
      udt_name: string;
    }>(
      `SELECT table_name, column_name, is_nullable, data_type, udt_name
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])
       ORDER BY table_name, ordinal_position`,
      [drizzleTables.map((table) => table.table)],
    );
    const byTable = new Map<string, { name: string; type: string; notNull: boolean }[]>();
    for (const row of res.rows) {
      const type = row.data_type === "USER-DEFINED" ? row.udt_name : row.data_type;
      const columns = byTable.get(row.table_name) ?? [];
      columns.push({
        name: row.column_name,
        type,
        notNull: row.is_nullable === "NO",
      });
      byTable.set(row.table_name, columns);
    }

    for (const table of drizzleTables) {
      expect(byTable.get(table.table), table.table).toEqual(table.columns);
    }
  });
});

describe("idempotency scoping (§5, §21.7, DEC-005)", () => {
  // Unique per run so the suite can rerun against a persistent database
  // (TEST_DATABASE_URL), not just the throwaway embedded one.
  const planCode = `test-schema-${randomUUID().slice(0, 8)}`;
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();

  beforeAll(async () => {
    await db.query("INSERT INTO plans (code, name, limits, price) VALUES ($1, 'Test', '{}', '{}')", [
      planCode,
    ]);
    for (const [id, slug] of [
      [workspaceA, `${planCode}-a`],
      [workspaceB, `${planCode}-b`],
    ]) {
      await db.query(
        `INSERT INTO workspaces (id, name, slug, plan_code, settings, status)
         VALUES ($1, $2, $3, $4, '{}', 'active')`,
        [id, slug, slug, planCode],
      );
    }
  });

  async function insertInvocation(
    workspaceId: string,
    idempotencyKey: string,
    actorType: "person" | "platform",
  ): Promise<void> {
    await db.query(
      `INSERT INTO action_invocations
         (id, workspace_id, idempotency_key, action_name, actor_type, input_hash, status)
       VALUES ($1, $2, $3, 'workspace.create', $4, 'hash', 'pending')`,
      [randomUUID(), workspaceId, idempotencyKey, actorType],
    );
  }

  it("unique (workspace_id, idempotency_key) and the DEC-005 partial unique index exist", async () => {
    const res = await db.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'action_invocations'",
    );
    const defs = res.rows.map((r) => r.indexdef);
    expect(
      defs.some((d) => d.includes("UNIQUE") && d.includes("(workspace_id, idempotency_key)")),
      "unique (workspace_id, idempotency_key)",
    ).toBe(true);
    expect(
      defs.some(
        (d) =>
          d.includes("UNIQUE") &&
          d.includes("(idempotency_key)") &&
          d.includes("actor_type = 'platform'"),
      ),
      "partial unique (idempotency_key) WHERE actor_type = 'platform'",
    ).toBe(true);
  });

  it("the same idempotency key in one workspace is rejected (§5 replay scoping)", async () => {
    const key = `same-workspace:${randomUUID()}`;
    await insertInvocation(workspaceA, key, "person");
    await expect(insertInvocation(workspaceA, key, "person")).rejects.toMatchObject({
      code: "23505",
      constraint: "action_invocations_workspace_idempotency_key",
    });
  });

  it("the same idempotency key in different workspaces is allowed for non-platform actors (§5 unchanged by DEC-005)", async () => {
    const key = `cross-workspace:${randomUUID()}`;
    await insertInvocation(workspaceA, key, "person");
    await insertInvocation(workspaceB, key, "person");
  });

  it("platform-actor invocations enforce global key uniqueness across workspaces (DEC-005)", async () => {
    const key = `platform:${randomUUID()}`;
    await insertInvocation(workspaceA, key, "platform");
    await expect(insertInvocation(workspaceB, key, "platform")).rejects.toMatchObject({
      code: "23505",
      constraint: "action_invocations_platform_idempotency_key",
    });
  });
});
