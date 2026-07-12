// §5 action layer contracts: one kernel, one dispatch surface, no second
// write path. Every mutation flows authorize → entitlement gate → threshold
// gate → validate → execute in one transaction → append audit event.
import type { ZodType } from "zod";

import type { Queryable } from "../db/client";

export type RoleClass = "owner" | "manager" | "supervisor" | "worker";

// §5 threshold classes govern agent actors; humans are governed by the role
// matrix (F2).
export type ThresholdClass = "autonomous_safe" | "proposal_gated" | "human_only";

export type Actor =
  | { type: "person"; id: string; roleClass: RoleClass; workspaceId: string }
  | { type: "agent"; id: string; agentCode: string; workspaceId: string }
  | { type: "system"; workspaceId: string }
  // §7: platform administration is a distinct actor; it has no workspace
  // before the executed action creates one (DEC-005).
  | { type: "platform" };

export interface Invocation {
  name: string;
  input: unknown;
  idempotencyKey: string;
}

// Typed rejection codes; each has a catalog entry under errors.action.* (§15).
export type RejectionCode =
  | "unknown_action"
  | "unauthenticated"
  | "unauthorized"
  | "validation_failed"
  | "invite_ineligible"
  | "auth_already_linked"
  | "auth_email_mismatch"
  | "no_dashboard_membership"
  | "idempotency_conflict"
  | "entitlement_denied"
  | "proposal_gating_unavailable"
  | "last_owner_protected"
  // DEC-009 Q5: client.archive refuses while any of its sites is not
  // archived (reject-while-sites-active, no cascade) — same tier as
  // last_owner_protected (SLICE-006), a typed domain-guard rejection.
  | "client_has_active_sites"
  // DEC-019: commitment lifecycle/domain guard rejections.
  | "commitment_wrong_state"
  | "commitment_patch_forbidden"
  | "commitment_site_inactive"
  | "commitment_has_open_windows";

// §5: the HTTP surface returns {status, result, warnings}; the same envelope
// is stored in action_invocations.result so a replay is byte-identical (F24).
export interface ResponseEnvelope {
  status: "ok" | "rejected" | "error";
  result: unknown;
  warnings: string[];
}

export function envelopeOk(result: unknown, warnings?: string[]): ResponseEnvelope {
  return { status: "ok", result: result ?? null, warnings: warnings ?? [] };
}

export function envelopeRejected(code: RejectionCode): ResponseEnvelope {
  return { status: "rejected", result: { code }, warnings: [] };
}

export function envelopeError(): ResponseEnvelope {
  return { status: "error", result: { code: "internal_error" }, warnings: [] };
}

// One audit_events row (§6); extras carries the §5 Audit-extras payload
// (DEC-006) while before/after stay pure entity-state diffs.
export interface AuditDraft {
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  extras?: unknown;
}

export interface ExecOutcome {
  result: unknown;
  warnings?: string[];
  audit: AuditDraft[];
}

export interface ExecRejected {
  rejected: RejectionCode;
}

export type ExecResult = ExecOutcome | ExecRejected;

export function outcomeRejected(code: RejectionCode): ExecRejected {
  return { rejected: code };
}

export function isRejectedOutcome(outcome: ExecResult): outcome is ExecRejected {
  return "rejected" in outcome;
}

export interface ExecContext {
  // Transaction-scoped connection running as app_kernel with the
  // app.workspace_id and app.kernel_op GUCs set (§7, F4).
  tx: Queryable;
  actor: Actor;
  workspaceId: string | null;
  // Platform bootstrap only (DEC-005): workspace.create announces the
  // app-generated workspace id so the kernel can scope GUC, invocation row,
  // and audit events before any row is inserted.
  setWorkspaceId(id: string): Promise<void>;
}

// §8 (F6): the catalog's actor columns list the minimum required role —
// owner inherits manager, manager inherits supervisor. Agents are admitted
// by the threshold gate, not listed here (F2).
export interface AllowedActors {
  minHumanRole?: "owner" | "manager" | "supervisor";
  system?: boolean;
  platform?: boolean;
}

export interface ActionDefinition<In = unknown> {
  name: string;
  actors: AllowedActors;
  threshold: ThresholdClass;
  // §20.1: every registered action has a Zod input schema.
  input: ZodType<In>;
  // §9 entitlement gate needs, resolved centrally; Phase 0 resolver is
  // noop-unlimited (§19 Phase 0).
  gates?: string[];
  execute(ctx: ExecContext, input: In): Promise<ExecResult>;
}
