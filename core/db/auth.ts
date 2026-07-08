import { Pool } from "pg";

import type { Queryable } from "./client";

export interface AuthDb {
  withClient<T>(fn: (client: Queryable) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export function createAuthDb(connectionString: string): AuthDb {
  const pool = new Pool({ connectionString, max: 5 });
  return {
    async withClient<T>(fn: (client: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    },
    end: () => pool.end(),
  };
}
