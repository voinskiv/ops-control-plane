// Provisions the empty Postgres the SQL suites run against and applies the
// db/migrations chain to it once (SLICE-002 done-when: "migrations apply on an
// empty local Supabase", §20.12 partial).
//
// Set TEST_DATABASE_URL to run against a disposable external database (e.g. a
// local `supabase start` stack); without it, a real embedded PostgreSQL 17
// server is booted per test run — this sandbox and CI have no Docker daemon
// for the Supabase stack.
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import EmbeddedPostgres from "embedded-postgres";
import type { TestProject } from "vitest/node";

import { connect } from "@core/db/client";
import { applyMigrations } from "@core/db/migrate";

declare module "vitest" {
  interface ProvidedContext {
    databaseUrl: string;
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not allocate a free port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let databaseUrl: string;
  let teardown: () => Promise<void>;

  const external = process.env.TEST_DATABASE_URL;
  if (external) {
    databaseUrl = external;
    teardown = async () => {};
  } else {
    const databaseDir = await mkdtemp(join(tmpdir(), "ocp-pg-"));
    const port = await freePort();
    // Expected trigger rejections land on postgres stderr; keep test output
    // clean unless explicitly debugging (failures still throw).
    const quiet = process.env.PG_VERBOSE ? undefined : () => {};
    const server = new EmbeddedPostgres({
      databaseDir,
      user: "postgres",
      password: "postgres",
      port,
      persistent: false,
      ...(quiet ? { onLog: quiet, onError: quiet } : {}),
    });
    await server.initialise();
    await server.start();
    await server.createDatabase("ops_control_plane_test");
    databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/ops_control_plane_test`;
    teardown = async () => {
      await server.stop();
      await rm(databaseDir, { recursive: true, force: true });
    };
  }

  const db = await connect(databaseUrl);
  try {
    await applyMigrations(db, join(process.cwd(), "db", "migrations"));
    // The suites assume the harness user can SET ROLE app_kernel. A true
    // superuser (embedded server) can already; on a Supabase stack the
    // `postgres` user is not superuser and PG16+ role semantics require an
    // explicit membership grant with the SET option (the migration's CREATE
    // ROLE leaves the creator with ADMIN, which suffices to self-grant).
    const who = await db.query<{ user: string }>("SELECT current_user AS user");
    await db.query(`GRANT app_kernel TO "${who.rows[0]!.user}" WITH SET TRUE`);
  } finally {
    await db.end();
  }

  project.provide("databaseUrl", databaseUrl);
  return teardown;
}
