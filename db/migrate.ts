import { join } from "node:path";

import { connect } from "../core/db/client";
import { applyMigrations } from "../core/db/migrate";

function requiredDatabaseUrl(): string {
  const value = process.env.DATABASE_URL;
  if (value === undefined || value === "") {
    throw new Error("DATABASE_URL is not configured");
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

async function main(): Promise<void> {
  const db = await connect(requiredDatabaseUrl());
  try {
    const ran = await applyMigrations(db, join(process.cwd(), "db", "migrations"));

    // Local Supabase's postgres login is not a superuser. PG16+ requires an
    // explicit SET membership before the kernel connection can assume the
    // RLS-bound app_kernel role; this is the same setup used by the SQL tests.
    const current = await db.query<{ user: string }>("SELECT current_user AS user");
    const loginRole = current.rows[0]?.user;
    if (loginRole === undefined) {
      throw new Error("could not resolve the database login role");
    }
    await db.query(`GRANT app_kernel TO ${quoteIdentifier(loginRole)} WITH SET TRUE, INHERIT FALSE`);

    process.stdout.write(`Applied ${ran.length} migration(s).\n`);
  } finally {
    await db.end();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
