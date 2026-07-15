// §5 [FIXED]: one kernel, one dispatch surface, no second write path.
// Pipeline per invocation (§21.3): resolve actor → authorize → entitlement →
// threshold → validate → transaction(execute + audit) → persist invocation
// result. Idempotency wraps the pipeline: a replay returns the stored
// envelope with no re-execution (F24); the invocation row is inserted pending
// and updated exactly once inside the same kernel transaction (F30).
import type { Queryable } from "../db/client";
import type { KernelDb } from "../db/kernel";
import { writeAuditEvents } from "./audit";
import { authorize } from "./authorize";
import type { EntitlementResolver } from "./entitlement";
import { inputHash } from "./hash";
import { findReplay, insertPending, newInvocationId, persistFinal } from "./idempotency";
import { ActionRegistry } from "./registry";
import { thresholdGate } from "./threshold";
import {
  envelopeError,
  envelopeOk,
  envelopeRejected,
  isRejectedOutcome,
  type Actor,
  type ExecContext,
  type Invocation,
  type RejectionCode,
  type ResponseEnvelope,
} from "./types";

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: string }).code === "23505";
}

function isRetryableSerializationFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const code = (error as { code?: string }).code;
  return code === "40001" || code === "40P01";
}

const maxSerializationAttempts = 3;

async function serializationRetryBackoff(attempt: number): Promise<void> {
  // DEC-027: short exponential backoff with 0–4ms jitter before retries.
  const milliseconds = 5 * 2 ** (attempt - 1) + Math.floor(Math.random() * 5);
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function setGuc(client: Queryable, name: string, value: string): Promise<void> {
  // set_config(..., true) is transaction-local (§7).
  await client.query("SELECT set_config($1, $2, true)", [name, value]);
}

export class Kernel {
  constructor(
    private readonly db: KernelDb,
    private readonly registry: ActionRegistry,
    private readonly entitlements: EntitlementResolver,
    private readonly internalRegistry: ActionRegistry = new ActionRegistry(),
  ) {}

  async dispatch(actor: Actor, invocation: Invocation): Promise<ResponseEnvelope> {
    return this.db.withClient((client) => this.run(this.registry, client, actor, invocation, 1, false));
  }

  async dispatchInternal(actor: Actor, invocation: Invocation): Promise<ResponseEnvelope> {
    return this.db.withClient((client) => this.run(this.internalRegistry, client, actor, invocation, 1, false));
  }

  private async run(
    registry: ActionRegistry,
    client: Queryable,
    actor: Actor,
    invocation: Invocation,
    serializationAttempt: number,
    uniqueRestarted: boolean,
  ): Promise<ResponseEnvelope> {
    const hash = inputHash(invocation.input);
    let workspaceId: string | null = actor.type === "platform" ? null : actor.workspaceId;
    try {
      await client.query("BEGIN");
      if (workspaceId !== null) {
        await setGuc(client, "app.workspace_id", workspaceId);
      }
      // F4: only kernel transactions may drive protected-table status updates.
      await setGuc(client, "app.kernel_op", invocation.name);

      const prior = await findReplay(client, actor, invocation.idempotencyKey);
      if (prior !== null) {
        await client.query("ROLLBACK");
        if (prior.input_hash !== hash) {
          // F24: same key, different input — typed rejection, no execution.
          // Never persisted: the key belongs to the original invocation.
          return envelopeRejected("idempotency_conflict");
        }
        if (prior.result === null) {
          // Unreachable by design (pending + response commit atomically);
          // fail loudly rather than re-execute a possibly in-flight key.
          return envelopeError();
        }
        return prior.result;
      }

      const definition = registry.get(invocation.name);
      if (definition === undefined) {
        return await this.finishRejected(client, actor, workspaceId, invocation, hash, "unknown_action");
      }

      const authz = authorize(actor, definition);
      if (authz !== null) {
        return await this.finishRejected(client, actor, workspaceId, invocation, hash, authz);
      }

      const entitlement = await this.entitlements.check(actor, definition);
      if (entitlement !== null) {
        return await this.finishRejected(client, actor, workspaceId, invocation, hash, entitlement);
      }

      const gate = thresholdGate(actor, definition);
      if (gate.kind === "reject") {
        return await this.finishRejected(client, actor, workspaceId, invocation, hash, gate.code);
      }

      const parsed = definition.input.safeParse(invocation.input);
      if (!parsed.success) {
        return await this.finishRejected(client, actor, workspaceId, invocation, hash, "validation_failed");
      }

      const invocationId = newInvocationId();
      let pendingInserted = false;
      const insertPendingRow = async (): Promise<void> => {
        if (pendingInserted || workspaceId === null) {
          return;
        }
        await insertPending(client, {
          invocationId,
          workspaceId,
          idempotencyKey: invocation.idempotencyKey,
          actionName: invocation.name,
          actor,
          inputHash: hash,
        });
        pendingInserted = true;
      };

      const ctx: ExecContext = {
        tx: client,
        actor,
        get workspaceId() {
          return workspaceId;
        },
        setWorkspaceId: async (id: string): Promise<void> => {
          if (actor.type !== "platform") {
            throw new Error("setWorkspaceId is reserved for platform bootstrap (DEC-005)");
          }
          if (workspaceId !== null) {
            throw new Error("workspace id is already set for this invocation");
          }
          workspaceId = id;
          await setGuc(client, "app.workspace_id", id);
        },
      };

      // F30: pending row and response update live in this same transaction.
      // For platform bootstrap the insert waits until the executed action has
      // announced the app-generated workspace id — claim-before-execute is
      // structurally impossible there (workspace_id is NOT NULL with an FK to
      // the workspace the action itself creates; DEC-005 Option A). Two
      // concurrent same-key platform calls may therefore both start
      // executing, but each one's effects commit atomically with its pending
      // row, the DEC-005 partial unique index admits one committer, and the
      // loser rolls back completely and retries into the replay path.
      await insertPendingRow();
      const outcome = await definition.execute(ctx, parsed.data);
      if (isRejectedOutcome(outcome)) {
        if (workspaceId === null) {
          await client.query("ROLLBACK");
          return envelopeRejected(outcome.rejected);
        }
        await insertPendingRow();
        const stored = await persistFinal(client, invocationId, envelopeRejected(outcome.rejected));
        await client.query("COMMIT");
        return stored;
      }
      if (workspaceId === null) {
        throw new Error(`${invocation.name} completed without a workspace id`);
      }
      await insertPendingRow();

      // §6: an action that cannot write its audit event does not commit.
      await writeAuditEvents(client, {
        workspaceId,
        invocationId,
        actor,
        action: invocation.name,
        drafts: outcome.audit,
      });

      const stored = await persistFinal(client, invocationId, envelopeOk(outcome.result, outcome.warnings));
      await client.query("COMMIT");
      return stored;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (isUniqueViolation(error) && !uniqueRestarted) {
        // Any unique violation may be a same-key race whose winner has now
        // committed — including a *domain* unique (e.g. the workspace PK/slug
        // during platform bootstrap, where the loser collides on the winner's
        // rows before reaching the invocation index. Postgres makes the loser
        // wait on the winner's in-flight insert, so by the time the 23505
        // surfaces the winner has committed). The retry's replay lookup
        // disambiguates: same key + same hash → the winner's stored envelope;
        // same key + different hash → typed idempotency_conflict; fresh key →
        // a genuine domain conflict that re-executes once and lands in the
        // error path below.
        return this.run(registry, client, actor, invocation, serializationAttempt, true);
      }
      if (isRetryableSerializationFailure(error) && serializationAttempt < maxSerializationAttempts) {
        await serializationRetryBackoff(serializationAttempt);
        // DEC-027: each serialization attempt gets its own DEC-005 restart.
        return this.run(registry, client, actor, invocation, serializationAttempt + 1, false);
      }
      return this.persistError(client, actor, workspaceId, invocation, hash);
    }
  }

  // Rejections persist as status='rejected' invocation rows so their replays
  // are byte-identical too (§3 status list). Platform pre-execution
  // rejections cannot persist — no tenant root exists to scope the NOT NULL
  // workspace_id — and are returned as deterministic envelopes instead.
  private async finishRejected(
    client: Queryable,
    actor: Actor,
    workspaceId: string | null,
    invocation: Invocation,
    hash: string,
    code: RejectionCode,
  ): Promise<ResponseEnvelope> {
    const envelope = envelopeRejected(code);
    if (workspaceId === null) {
      await client.query("ROLLBACK");
      return envelope;
    }
    const invocationId = newInvocationId();
    await insertPending(client, {
      invocationId,
      workspaceId,
      idempotencyKey: invocation.idempotencyKey,
      actionName: invocation.name,
      actor,
      inputHash: hash,
    });
    const stored = await persistFinal(client, invocationId, envelope);
    await client.query("COMMIT");
    return stored;
  }

  // The failed transaction rolled back (including its pending row); the error
  // outcome is persisted in a fresh small transaction so the key still
  // replays deterministically (F30: insert pending + update, one transaction).
  private async persistError(
    client: Queryable,
    actor: Actor,
    workspaceId: string | null,
    invocation: Invocation,
    hash: string,
  ): Promise<ResponseEnvelope> {
    const envelope = envelopeError();
    if (workspaceId === null) {
      return envelope;
    }
    try {
      await client.query("BEGIN");
      await setGuc(client, "app.workspace_id", workspaceId);
      const invocationId = newInvocationId();
      await insertPending(client, {
        invocationId,
        workspaceId,
        idempotencyKey: invocation.idempotencyKey,
        actionName: invocation.name,
        actor,
        inputHash: hash,
      });
      const stored = await persistFinal(client, invocationId, envelope);
      await client.query("COMMIT");
      return stored;
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      return envelope;
    }
  }
}
