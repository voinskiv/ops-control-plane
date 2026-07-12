import type { Actor, ResponseEnvelope } from "../actions/types";
import { envelopeError } from "../actions/types";
import type { AuthDb } from "../db/auth";
import type { ReadRegistry } from "./registry";
import { readRejected, type ReadDispatchResult } from "./types";

export class ReadKernel {
  constructor(
    private readonly db: AuthDb,
    private readonly registry: ReadRegistry,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async dispatch(actor: Actor, name: string, params: unknown): Promise<ReadDispatchResult> {
    const definition = this.registry.get(name);
    if (definition === undefined) {
      return { ok: false, envelope: readRejected("unknown_read") };
    }
    if (actor.type !== "person" || actor.roleClass === "worker" || !definition.actors.includes(actor.roleClass)) {
      return { ok: false, envelope: readRejected("unauthorized") };
    }
    const parsed = definition.params.safeParse(params);
    if (!parsed.success) {
      return { ok: false, envelope: readRejected("validation_failed") };
    }

    try {
      return await this.db.withWorkspace(actor.workspaceId, async (tx) => {
        const execution = await definition.execute({ tx, actor, now: this.clock() }, parsed.data);
        if ("rejected" in execution) {
          return { ok: false, envelope: readRejected(execution.rejected) };
        }
        const response = definition.response.safeParse(execution.result);
        if (!response.success) {
          return { ok: false, envelope: envelopeError() };
        }
        return { ok: true, data: response.data };
      });
    } catch {
      return { ok: false, envelope: envelopeError() };
    }
  }
}

export function readHttpStatus(envelope: ResponseEnvelope): number {
  if (envelope.status === "error") {
    return 500;
  }
  const code = (envelope.result as { code?: string } | null)?.code;
  if (code === "unauthenticated") {
    return 401;
  }
  if (code === "unauthorized" || code === "no_dashboard_membership") {
    return 403;
  }
  return 400;
}
