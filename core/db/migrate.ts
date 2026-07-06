// Sequential SQL migration runner for db/migrations (§19). Files apply in
// filename order, each inside its own transaction, tracked in
// schema_migrations so re-runs are no-ops.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { DbClient } from "./client";

export async function applyMigrations(db: DbClient, dir: string): Promise<string[]> {
  await db.query(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       version text PRIMARY KEY,
       applied_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const seen = await db.query<{ version: string }>("SELECT version FROM schema_migrations");
  const applied = new Set(seen.rows.map((r) => r.version));
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) {
      continue;
    }
    const sql = await readFile(join(dir, file), "utf8");
    try {
      await db.query("BEGIN");
      await db.query(sql);
      await db.query("INSERT INTO schema_migrations (version) VALUES ($1)", [file]);
      await db.query("COMMIT");
    } catch (error) {
      await db.query("ROLLBACK");
      throw new Error(`migration ${file} failed`, { cause: error });
    }
    ran.push(file);
  }
  return ran;
}
