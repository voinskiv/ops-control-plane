// §19: core/db is the only db import site. Everything that needs a Postgres
// connection — today the migration runner and the SQL test suites, later the
// kernel — goes through here (§20.5 lint gate).
import { Client } from "pg";

export type DbClient = Client;

export async function connect(connectionString: string): Promise<DbClient> {
  const client = new Client({ connectionString });
  await client.connect();
  return client;
}
