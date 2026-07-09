import { Pool } from "pg";

import type { Queryable } from "./client";

export interface AuthDb {
  withClient<T>(fn: (client: Queryable) => Promise<T>): Promise<T>;
  withWorkspace<T>(workspaceId: string, fn: (client: Queryable) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export function createAuthDb(connectionString: string): AuthDb {
  const pool = new Pool({
    connectionString,
    options: "-c role=app_kernel",
    max: 5,
  });
  return {
    async withClient<T>(fn: (client: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    },
    async withWorkspace<T>(workspaceId: string, fn: (client: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config($1, $2, true)", ["app.workspace_id", workspaceId]);
        const result = await fn(client);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}
