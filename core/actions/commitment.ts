// SLICE-012: commitment.draft per amended §3/§5 and DEC-016 items 1–5.
// RRULE is intentionally an opaque non-empty stored string here; semantic
// parsing belongs to window.generate (SLICE-014).
import { z } from "zod";

import { createCommitmentRow, lockedActiveSite } from "../db/commitments";
import {
  commitmentTypeDefinition,
  coverageSpecSchema,
  defaultVerification,
  outputSpecSchema,
  serviceScopeSpecSchema,
  verificationSchema,
} from "../domain/commitment-types";
import { uuidv7 } from "../domain/ids";
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
