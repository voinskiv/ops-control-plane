import type { ZodType } from "zod";

import type { Actor, ResponseEnvelope, RoleClass } from "../actions/types";
import type { Queryable } from "../db/client";

export type ReadRejectionCode =
  | "unknown_read"
  | "unauthenticated"
  | "unauthorized"
  | "validation_failed"
  | "no_dashboard_membership";

export interface ReadContext {
  tx: Queryable;
  actor: Extract<Actor, { type: "person" }>;
  now: Date;
}

export type ReadExecution<Result> =
  | { result: Result }
  | { rejected: Extract<ReadRejectionCode, "no_dashboard_membership"> };

export interface ReadDefinition<Params = unknown, Result = unknown> {
  name: string;
  actors: readonly Exclude<RoleClass, "worker">[];
  params: ZodType<Params>;
  response: ZodType<Result>;
  execute(ctx: ReadContext, params: Params): Promise<ReadExecution<Result>>;
}

export type ReadDispatchResult = { ok: true; data: unknown } | { ok: false; envelope: ResponseEnvelope };

export function readRejected(code: ReadRejectionCode): ResponseEnvelope {
  return { status: "rejected", result: { code }, warnings: [] };
}
