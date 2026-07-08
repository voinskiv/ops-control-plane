// SLICE-007: client.* actions per §5 catalog and DEC-009 (Q4, Q5).
import { z } from "zod";

import { clientById, createClientRow, hasNonArchivedSites, updateClientRow, type ContactInfo } from "../db/clients";
import { uuidv7 } from "../domain/ids";
import { outcomeRejected, type ActionDefinition, type ExecContext } from "./types";

const nameInput = z.string().trim().min(1).max(200);
const contactInput = z
  .object({
    email: z.string().trim().max(254).optional(),
    phone: z.string().trim().max(50).optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();

const clientCreateInput = z
  .object({
    name: nameInput,
    contact: contactInput.optional(),
  })
  .strict();

const clientUpdateInput = z
  .object({
    client_id: z.uuid(),
    name: nameInput.optional(),
    contact: contactInput.optional(),
  })
  .strict()
  .refine((input) => input.name !== undefined || input.contact !== undefined, { message: "empty patch" });

const clientArchiveInput = z
  .object({
    client_id: z.uuid(),
  })
  .strict();

function workspaceId(ctx: ExecContext): string {
  if (ctx.workspaceId === null) {
    throw new Error("client action executed without a workspace id");
  }
  return ctx.workspaceId;
}

export const clientCreateAction: ActionDefinition<z.infer<typeof clientCreateInput>> = {
  name: "client.create",
  actors: { minHumanRole: "manager" },
  threshold: "proposal_gated",
  input: clientCreateInput,
  async execute(ctx, input) {
    const client = await createClientRow(ctx.tx, {
      id: uuidv7(),
      workspaceId: workspaceId(ctx),
      name: input.name,
      contact: input.contact,
    });

    return {
      result: { client_id: client.id },
      audit: [{ entityType: "clients", entityId: client.id, after: client }],
    };
  },
};

export const clientUpdateAction: ActionDefinition<z.infer<typeof clientUpdateInput>> = {
  name: "client.update",
  actors: { minHumanRole: "manager" },
  threshold: "proposal_gated",
  input: clientUpdateInput,
  async execute(ctx, input) {
    const target = await clientById(ctx.tx, workspaceId(ctx), input.client_id);
    if (target === null || target.status !== "active") {
      return outcomeRejected("validation_failed");
    }

    const patch: { name?: string; contact?: ContactInfo } = {};
    const beforeDiff: Record<string, unknown> = {};
    const afterKeys: ("name" | "contact")[] = [];
    if (input.name !== undefined) {
      patch.name = input.name;
      beforeDiff.name = target.name;
      afterKeys.push("name");
    }
    if (input.contact !== undefined) {
      patch.contact = input.contact;
      beforeDiff.contact = target.contact;
      afterKeys.push("contact");
    }

    const updated = await updateClientRow(ctx.tx, workspaceId(ctx), target.id, patch);
    const afterDiff: Record<string, unknown> = {};
    for (const key of afterKeys) {
      afterDiff[key] = updated[key];
    }

    return {
      result: { client_id: updated.id },
      audit: [{ entityType: "clients", entityId: updated.id, before: beforeDiff, after: afterDiff }],
    };
  },
};

export const clientArchiveAction: ActionDefinition<z.infer<typeof clientArchiveInput>> = {
  name: "client.archive",
  actors: { minHumanRole: "manager" },
  threshold: "proposal_gated",
  input: clientArchiveInput,
  async execute(ctx, input) {
    const target = await clientById(ctx.tx, workspaceId(ctx), input.client_id);
    if (target === null || target.status !== "active") {
      return outcomeRejected("validation_failed");
    }
    // DEC-009 Q5: reject-while-sites-active — no cascade.
    if (await hasNonArchivedSites(ctx.tx, workspaceId(ctx), target.id)) {
      return outcomeRejected("client_has_active_sites");
    }

    const updated = await updateClientRow(ctx.tx, workspaceId(ctx), target.id, { status: "archived" });
    return {
      result: { client_id: updated.id },
      audit: [
        {
          entityType: "clients",
          entityId: updated.id,
          before: { status: "active" },
          after: { status: "archived" },
        },
      ],
    };
  },
};
