// SLICE-012: commitment.draft per amended §3/§5 and DEC-016 items 1–5.
// RRULE is intentionally an opaque non-empty stored string here; semantic
// parsing belongs to window.generate (SLICE-014).
import { z } from "zod";

import {
  commitmentHasOpenWindows,
  commitmentSiteIsActive,
  createCommitmentRow,
  lockCommitment,
  lockedActiveSite,
  updateCommitmentSpecRow,
  updateCommitmentStatusRow,
  type CommitmentSnapshot,
  type CommitmentSpecPatch,
} from "../db/commitments";
import {
  commitmentTypeDefinition,
  coverageSpecSchema,
  defaultVerification,
  outputSpecSchema,
  serviceScopeSpecSchema,
  verificationSchema,
} from "../domain/commitment-types";
import { uuidv7 } from "../domain/ids";
import { commitmentTransitionTarget, type CommitmentTransition } from "../domain/commitment-state";
import { inputHash } from "./hash";
import { outcomeRejected, type ActionDefinition, type ExecContext } from "./types";

const common = {
  site_id: z.uuid(),
  title: z.string().trim().min(1).max(200),
  schedule_rrule: z.string().trim().min(1),
  verification: verificationSchema.optional(),
  valid_from: z.iso.date(),
  valid_to: z.iso.date(),
};

const coverageDraftInput = z
  .object({
    ...common,
    type: z.literal("coverage"),
    spec: coverageSpecSchema,
    target_qty: z.number().int().min(1).max(999_999_999),
  })
  .strict();

const outputDraftInput = z
  .object({
    ...common,
    type: z.literal("output"),
    spec: outputSpecSchema,
    target_qty: z.number().positive().max(999_999_999.999),
    unit: z.string().trim().min(1),
  })
  .strict();

const serviceScopeDraftInput = z
  .object({
    ...common,
    type: z.literal("service_scope"),
    spec: serviceScopeSpecSchema,
  })
  .strict();

export const commitmentDraftInput = z
  .discriminatedUnion("type", [coverageDraftInput, outputDraftInput, serviceScopeDraftInput])
  .refine((input) => input.valid_from <= input.valid_to, { message: "valid_to must be on or after valid_from" });

type CommitmentDraftInput = z.infer<typeof commitmentDraftInput>;

function workspaceId(ctx: ExecContext): string {
  if (ctx.workspaceId === null) {
    throw new Error("commitment action executed without a workspace id");
  }
  return ctx.workspaceId;
}

export const commitmentDraftAction: ActionDefinition<CommitmentDraftInput> = {
  name: "commitment.draft",
  actors: { minHumanRole: "manager" },
  threshold: "proposal_gated",
  input: commitmentDraftInput,
  async execute(ctx, input) {
    const site = await lockedActiveSite(ctx.tx, workspaceId(ctx), input.site_id);
    if (site === null) {
      return outcomeRejected("validation_failed");
    }

    const definition = commitmentTypeDefinition(input.type);
    const verification = structuredClone(input.verification ?? defaultVerification);
    const commitment = await createCommitmentRow(ctx.tx, {
      id: uuidv7(),
      workspaceId: workspaceId(ctx),
      clientId: site.client_id,
      siteId: site.id,
      type: input.type,
      title: input.title,
      spec: input.spec,
      scheduleRrule: input.schedule_rrule,
      targetQty: "target_qty" in input ? input.target_qty : null,
      unit: "unit" in input ? input.unit : null,
      verification,
      validFrom: input.valid_from,
      validTo: input.valid_to,
    });

    return {
      result: { commitment_id: commitment.id },
      audit: [
        {
          entityType: "commitments",
          entityId: commitment.id,
          after: commitment,
          extras: { type_definition: { type: definition.type, version: definition.version } },
        },
      ],
    };
  },
};

const reasonInput = z.string().trim().min(1).max(2000);
const commitmentIdInput = z.object({ commitment_id: z.uuid() }).strict();
const commitmentReasonInput = z.object({ commitment_id: z.uuid(), reason: reasonInput }).strict();

const commitmentUpdateSpecInput = z
  .object({
    commitment_id: z.uuid(),
    title: z.string().trim().min(1).max(200).optional(),
    spec: z.unknown().optional(),
    schedule_rrule: z.string().trim().min(1).optional(),
    target_qty: z.number().positive().max(999_999_999.999).nullable().optional(),
    unit: z.string().trim().min(1).nullable().optional(),
    verification: verificationSchema.optional(),
    valid_from: z.iso.date().optional(),
    valid_to: z.iso.date().optional(),
    // Rejection-only sentinels: these fields are never written, but accepting
    // their presence lets the action return DEC-019's specific immutable-field
    // rejection instead of collapsing it into generic schema validation.
    type: z.unknown().optional(),
    site_id: z.unknown().optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).some((key) => key !== "commitment_id"), { message: "empty patch" });

type CommitmentUpdateSpecInput = z.infer<typeof commitmentUpdateSpecInput>;
type CommitmentIdInput = z.infer<typeof commitmentIdInput>;
type CommitmentReasonInput = z.infer<typeof commitmentReasonInput>;

function hasOwn(input: object, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, field);
}

function numeric(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function validTypeMatrix(commitment: CommitmentSnapshot, patch: CommitmentSpecPatch): boolean {
  const spec = patch.spec ?? commitment.spec;
  const targetQty = patch.targetQty === undefined ? numeric(commitment.target_qty) : patch.targetQty;
  const unit = patch.unit === undefined ? commitment.unit : patch.unit;
  const validFrom = patch.validFrom ?? commitment.valid_from;
  const validTo = patch.validTo ?? commitment.valid_to;
  if (validFrom > validTo || !commitmentTypeDefinition(commitment.type).specSchema.safeParse(spec).success) {
    return false;
  }
  switch (commitment.type) {
    case "coverage":
      return targetQty !== null && Number.isInteger(targetQty) && targetQty >= 1 && targetQty <= 999_999_999 && unit === null;
    case "output":
      return targetQty !== null && targetQty > 0 && targetQty <= 999_999_999.999 && unit !== null && unit.length > 0;
    case "service_scope":
      return targetQty === null && unit === null;
  }
}

export const commitmentUpdateSpecAction: ActionDefinition<CommitmentUpdateSpecInput> = {
  name: "commitment.update_spec",
  actors: { minHumanRole: "manager" },
  threshold: "proposal_gated",
  input: commitmentUpdateSpecInput,
  async execute(ctx, input) {
    const before = await lockCommitment(ctx.tx, workspaceId(ctx), input.commitment_id);
    if (before === null) return outcomeRejected("validation_failed");
    if (before.status !== "draft" && before.status !== "active") return outcomeRejected("commitment_wrong_state");
    if (hasOwn(input, "type") || hasOwn(input, "site_id") || (before.status === "active" && hasOwn(input, "valid_from"))) {
      return outcomeRejected("commitment_patch_forbidden");
    }

    const patch: CommitmentSpecPatch = {};
    if (input.title !== undefined) patch.title = input.title;
    if (hasOwn(input, "spec")) patch.spec = input.spec;
    if (input.schedule_rrule !== undefined) patch.scheduleRrule = input.schedule_rrule;
    if (hasOwn(input, "target_qty")) patch.targetQty = input.target_qty;
    if (hasOwn(input, "unit")) patch.unit = input.unit;
    if (input.verification !== undefined) patch.verification = input.verification;
    if (input.valid_from !== undefined) patch.validFrom = input.valid_from;
    if (input.valid_to !== undefined) patch.validTo = input.valid_to;
    if (!validTypeMatrix(before, patch)) return outcomeRejected("validation_failed");

    const after = await updateCommitmentSpecRow(ctx.tx, before.id, patch);
    return {
      result: { commitment_id: after.id },
      audit: [{ entityType: "commitments", entityId: after.id, before, after }],
    };
  },
};

function frozenSpecHash(commitment: CommitmentSnapshot): string {
  return inputHash({
    type: commitment.type,
    spec: commitment.spec,
    schedule_rrule: commitment.schedule_rrule,
    target_qty: commitment.target_qty,
    unit: commitment.unit,
    verification: commitment.verification,
    valid_from: commitment.valid_from,
    valid_to: commitment.valid_to,
  });
}

async function transition(
  ctx: ExecContext,
  commitmentId: string,
  command: CommitmentTransition,
  options: { requireActiveSite?: boolean; requireClosedWindows?: boolean; frozenHash?: boolean; reason?: string } = {},
) {
  const before = await lockCommitment(ctx.tx, workspaceId(ctx), commitmentId);
  if (before === null) return outcomeRejected("validation_failed");
  const target = commitmentTransitionTarget(before.status, command);
  if (target === null) return outcomeRejected("commitment_wrong_state");
  if (options.requireActiveSite && !(await commitmentSiteIsActive(ctx.tx, workspaceId(ctx), before.site_id))) {
    return outcomeRejected("commitment_site_inactive");
  }
  if (options.requireClosedWindows && (await commitmentHasOpenWindows(ctx.tx, workspaceId(ctx), before.id))) {
    return outcomeRejected("commitment_has_open_windows");
  }
  const after = await updateCommitmentStatusRow(ctx.tx, before.id, target);
  return {
    result: { commitment_id: after.id },
    audit: [
      {
        entityType: "commitments",
        entityId: after.id,
        before,
        after,
        ...(options.frozenHash || options.reason !== undefined
          ? {
              extras: {
                ...(options.frozenHash ? { frozen_spec_hash: frozenSpecHash(before) } : {}),
                ...(options.reason !== undefined ? { reason: options.reason } : {}),
              },
            }
          : {}),
      },
    ],
  };
}

export const commitmentActivateAction: ActionDefinition<CommitmentIdInput> = {
  name: "commitment.activate",
  actors: { minHumanRole: "manager" },
  threshold: "human_only",
  input: commitmentIdInput,
  execute: (ctx, input) => transition(ctx, input.commitment_id, "activate", { requireActiveSite: true, frozenHash: true }),
};

export const commitmentPauseAction: ActionDefinition<CommitmentReasonInput> = {
  name: "commitment.pause",
  actors: { minHumanRole: "manager" },
  threshold: "human_only",
  input: commitmentReasonInput,
  execute: (ctx, input) => transition(ctx, input.commitment_id, "pause", { reason: input.reason }),
};

export const commitmentCompleteAction: ActionDefinition<CommitmentReasonInput> = {
  name: "commitment.complete",
  actors: { minHumanRole: "manager", system: true },
  threshold: "human_only",
  input: commitmentReasonInput,
  execute: (ctx, input) => transition(ctx, input.commitment_id, "complete", { reason: input.reason }),
};

export const commitmentArchiveAction: ActionDefinition<CommitmentReasonInput> = {
  name: "commitment.archive",
  actors: { minHumanRole: "manager" },
  threshold: "human_only",
  input: commitmentReasonInput,
  execute: (ctx, input) =>
    transition(ctx, input.commitment_id, "archive", { requireClosedWindows: true, reason: input.reason }),
};
