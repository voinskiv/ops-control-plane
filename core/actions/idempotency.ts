// §5 idempotency [FIXED]: unique (workspace_id, idempotency_key); replay
// returns the stored {status, result, warnings} envelope byte-identical with
// no re-execution (F24). The row is inserted pending and updated exactly once
// with the response inside the same kernel transaction (F30). Platform-actor
// invocations are replay-matched by (idempotency_key, actor_type='platform')
// through the SECURITY DEFINER lookup, since the tenant root does not exist
// yet (DEC-005).
import type { Queryable } from "../db/client";
import { uuidv7 } from "../domain/ids";
import type { Actor, ResponseEnvelope } from "./types";

export interface StoredInvocation {
  id: string;
  workspace_id: string;
  idempotency_key: string;
  action_name: string;
  input_hash: string;
  result: ResponseEnvelope | null;
  status: "pending" | "ok" | "rejected" | "error";
}

export async function findReplay(
  client: Queryable,
  actor: Actor,
  idempotencyKey: string,
): Promise<StoredInvocation | null> {
  if (actor.type === "platform") {
    const res = await client.query<StoredInvocation>(
      "SELECT * FROM app_platform_invocation_lookup($1)",
      [idempotencyKey],
    );
    return res.rows[0] ?? null;
  }
  const res = await client.query<StoredInvocation>(
    "SELECT * FROM action_invocations WHERE workspace_id = $1 AND idempotency_key = $2",
    [actor.workspaceId, idempotencyKey],
  );
  return res.rows[0] ?? null;
}

export async function insertPending(
  client: Queryable,
  params: {
    invocationId: string;
    workspaceId: string;
    idempotencyKey: string;
    actionName: string;
    actor: Actor;
    inputHash: string;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO action_invocations
       (id, workspace_id, idempotency_key, action_name, actor_type, actor_id, input_hash, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')`,
    [
      params.invocationId,
      params.workspaceId,
      params.idempotencyKey,
      params.actionName,
      params.actor.type,
      params.actor.type === "person" || params.actor.type === "agent" ? params.actor.id : null,
      params.inputHash,
    ],
  );
}

// Returns the envelope as stored (jsonb round trip), so the first response
// and every replay serialize the identical representation (F24).
export async function persistFinal(
  client: Queryable,
  invocationId: string,
  envelope: ResponseEnvelope,
): Promise<ResponseEnvelope> {
  const res = await client.query<{ result: ResponseEnvelope }>(
    "UPDATE action_invocations SET result = $2, status = $3 WHERE id = $1 RETURNING result",
    [invocationId, JSON.stringify(envelope), envelope.status],
  );
  const stored = res.rows[0]?.result;
  if (!stored) {
    throw new Error(`invocation ${invocationId} vanished while persisting its result`);
  }
  return stored;
}

export function newInvocationId(): string {
  return uuidv7();
}
