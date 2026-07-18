// FIX-040 / DEC-028 / DEC-029: local-only bridge from the kernel-replay seed
// to the existing invite and link-auth actions. No seeded table is written
// outside the kernel; direct database access below is read-only discovery.
import { noopUnlimitedResolver } from "../core/actions/entitlement";
import { Kernel } from "../core/actions/kernel";
import { internalRegistry, registry } from "../core/actions/registry";
import type { Actor, ResponseEnvelope } from "../core/actions/types";
import { connect, type DbClient } from "../core/db/client";
import { createKernelDb } from "../core/db/kernel";

const DEMO_WORKSPACE_NAME = "Demo GmbH";
const DEMO_OWNER_EMAIL = "anna.becker@demo-gmbh.example";
export const LOCAL_DEV_PASSWORD = "local-dev-password";
export const LOCAL_INBUCKET_URL = "http://127.0.0.1:54324";

interface SeededOwner {
  personId: string;
  workspaceId: string;
  authUserId: string | null;
}

interface AuthAdminUser {
  id: string;
  email: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not configured`);
  }
  return value;
}

export function localUrl(name: string, value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(parsed.hostname)) {
    throw new Error(`dev:bootstrap refuses non-local ${name}`);
  }
  return parsed;
}

export function requiredLocalSupabaseUrl(): URL {
  return localUrl("SUPABASE_URL", requiredEnv("SUPABASE_URL"));
}

function requiredLocalDatabaseUrl(): string {
  const value = requiredEnv("DATABASE_URL");
  localUrl("DATABASE_URL", value);
  return value;
}

function authAdminUsersUrl(supabaseUrl: URL): string {
  return new URL("/auth/v1/admin/users", supabaseUrl).toString();
}

function authHeaders(): HeadersInit {
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  return {
    apikey: serviceRoleKey,
    authorization: `Bearer ${serviceRoleKey}`,
    "content-type": "application/json",
  };
}

async function authAdminRequest(supabaseUrl: URL, path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, { ...init, headers: { ...authHeaders(), ...init?.headers } });
  if (!response.ok) {
    throw new Error(`Supabase Auth admin request returned ${response.status}`);
  }
  return response.json().catch(() => null);
}

function authUser(value: unknown): AuthAdminUser | null {
  const candidate = value as { id?: unknown; email?: unknown; user?: unknown } | null;
  const user = candidate?.user ?? candidate;
  if (user === null || typeof user !== "object") return null;
  const { id, email } = user as { id?: unknown; email?: unknown };
  return typeof id === "string" && typeof email === "string" ? { id, email } : null;
}

async function authUserByEmail(supabaseUrl: URL, email: string): Promise<AuthAdminUser | null> {
  const usersUrl = new URL(authAdminUsersUrl(supabaseUrl));
  usersUrl.searchParams.set("page", "1");
  usersUrl.searchParams.set("per_page", "1000");
  const body = (await authAdminRequest(supabaseUrl, usersUrl.toString())) as { users?: unknown } | null;
  const users = Array.isArray(body?.users) ? body.users : [];
  return users.map(authUser).find((user): user is AuthAdminUser => user?.email.toLowerCase() === email.toLowerCase()) ?? null;
}

async function ensureAuthUser(supabaseUrl: URL, email: string): Promise<{ user: AuthAdminUser; created: boolean }> {
  const usersUrl = authAdminUsersUrl(supabaseUrl);
  let user = await authUserByEmail(supabaseUrl, email);
  const created = user === null;
  if (user === null) {
    user = authUser(
      await authAdminRequest(supabaseUrl, usersUrl, {
        method: "POST",
        body: JSON.stringify({ email, password: LOCAL_DEV_PASSWORD, email_confirm: true }),
      }),
    );
    if (user === null) {
      throw new Error("Supabase Auth admin create user response did not include a user");
    }
  }
  await authAdminRequest(supabaseUrl, `${usersUrl}/${encodeURIComponent(user.id)}`, {
    method: "PUT",
    body: JSON.stringify({ password: LOCAL_DEV_PASSWORD, email_confirm: true }),
  });
  return { user, created };
}

async function seededOwner(db: DbClient): Promise<SeededOwner> {
  const result = await db.query<{ person_id: string; workspace_id: string; auth_user_id: string | null }>(
    `SELECT p.id AS person_id, p.workspace_id, p.auth_user_id
     FROM workspaces AS w
     JOIN persons AS p ON p.workspace_id = w.id
     WHERE w.name = $1
       AND p.email = $2
       AND p.role_class = 'owner'
       AND p.status = 'active'
     LIMIT 1`,
    [DEMO_WORKSPACE_NAME, DEMO_OWNER_EMAIL],
  );
  const owner = result.rows[0];
  if (owner === undefined) {
    throw new Error(`seeded active owner ${DEMO_OWNER_EMAIL} was not found; run npm run db:seed first`);
  }
  return { personId: owner.person_id, workspaceId: owner.workspace_id, authUserId: owner.auth_user_id };
}

async function inviteExists(db: DbClient, owner: SeededOwner): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1
       FROM audit_events
       WHERE workspace_id = $1
         AND action = 'person.invite'
         AND entity_type = 'persons'
         AND entity_id = $2
         AND extras ? 'auth_invite_id'
         AND extras ? 'invited_email'
     ) AS exists`,
    [owner.workspaceId, owner.personId],
  );
  return result.rows[0]?.exists === true;
}

function actionFailure(name: string, envelope: ResponseEnvelope): Error {
  return new Error(`${name} failed with ${JSON.stringify(envelope)}`);
}

async function main(): Promise<void> {
  // FIX-040: this guard must run before any database read, Auth call, or action dispatch.
  const supabaseUrl = requiredLocalSupabaseUrl();
  const databaseUrl = requiredLocalDatabaseUrl();
  const db = await connect(databaseUrl);
  const kernelDb = createKernelDb(databaseUrl);
  const kernel = new Kernel(kernelDb, registry, noopUnlimitedResolver, internalRegistry);

  try {
    let owner = await seededOwner(db);
    if (owner.authUserId !== null) {
      process.stdout.write(`Demo owner is already linked: ${DEMO_OWNER_EMAIL}\n`);
      process.stdout.write(`Inbucket: ${LOCAL_INBUCKET_URL}\n`);
      return;
    }

    if (await inviteExists(db, owner)) {
      process.stdout.write(`Demo owner invite already present: ${DEMO_OWNER_EMAIL}\n`);
    } else {
      const ownerActor = {
        type: "person",
        id: owner.personId,
        roleClass: "owner",
        workspaceId: owner.workspaceId,
      } as const satisfies Actor;
      const invitation = await kernel.dispatch(ownerActor, {
        name: "person.invite",
        input: { person_id: owner.personId },
        idempotencyKey: `dev:bootstrap:person.invite:${owner.personId}`,
      });
      if (invitation.status !== "ok") throw actionFailure("person.invite", invitation);
      process.stdout.write(`Demo owner invite created: ${DEMO_OWNER_EMAIL}\n`);
    }

    const auth = await ensureAuthUser(supabaseUrl, DEMO_OWNER_EMAIL);
    process.stdout.write(`Local Supabase auth user ${auth.created ? "created" : "already present"}: ${DEMO_OWNER_EMAIL}\n`);

    owner = await seededOwner(db);
    if (owner.authUserId !== null) {
      process.stdout.write(`Demo owner is already linked: ${DEMO_OWNER_EMAIL}\n`);
    } else {
      const linked = await kernel.dispatchInternal(
        { type: "system", workspaceId: owner.workspaceId },
        {
          name: "person.link_auth",
          input: { person_id: owner.personId, auth_user_id: auth.user.id, email: DEMO_OWNER_EMAIL },
          idempotencyKey: `dev:bootstrap:person.link_auth:${owner.personId}:${auth.user.id}`,
        },
      );
      if (linked.status !== "ok") throw actionFailure("person.link_auth", linked);
      process.stdout.write(`Demo owner linked: ${DEMO_OWNER_EMAIL}\n`);
    }

    process.stdout.write(`Sign in with: ${DEMO_OWNER_EMAIL}\n`);
    process.stdout.write(`Local fallback password: ${LOCAL_DEV_PASSWORD}\n`);
    process.stdout.write(`Inbucket: ${LOCAL_INBUCKET_URL}\n`);
  } finally {
    await Promise.all([db.end(), kernelDb.end()]);
  }
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("db/dev-bootstrap.ts")) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
