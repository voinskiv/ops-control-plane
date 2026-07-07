// Adapter boundary for Drizzle. Keeping it in core/db preserves §20.5: no
// database client imports outside this package.
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import type { Client, PoolClient } from "pg";

import type { Queryable } from "./client";
import { schemaTables } from "./schema";

export type AppDb = NodePgDatabase<typeof schemaTables> & {
  $client: Client | PoolClient;
};

export function drizzleFor(tx: Queryable): AppDb {
  return drizzle({ client: tx as Client | PoolClient, schema: schemaTables });
}
