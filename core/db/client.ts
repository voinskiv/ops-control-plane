// §19: core/db is the only db import site. Everything that needs a Postgres
// connection — the migration runner, the kernel, and the SQL test suites —
// goes through here (§20.5 lint gate).
import { Client, type QueryResult, type QueryResultRow } from "pg";

export type { QueryResult, QueryResultRow };

// The minimal query surface the kernel and tests program against; both
// pg.Client and pg.PoolClient satisfy it structurally.
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export type DbClient = Client;

export async function connect(connectionString: string): Promise<DbClient> {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}
