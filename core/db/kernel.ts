// §7 (F13): kernel DB traffic runs as the dedicated app_kernel role that is
// subject to RLS. Every pooled connection assumes the role via the startup
// parameter, so no code path can accidentally run as the login user; the
// deployment grants the login role membership in app_kernel WITH SET.
import { Pool } from "pg";

import type { Queryable } from "./client";

export interface KernelDb {
  withClient<T>(fn: (client: Queryable) => Promise<T>): Promise<T>;
  end(): Promise<void>;
}

export function createKernelDb(connectionString: string): KernelDb {
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
    end: () => pool.end(),
  };
}
