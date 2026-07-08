// SLICE-007: site.* actions per §5 catalog and DEC-009. site.create writes
// the non-billable 'draft' status (Q1/Q2); site.activate is the sole
// transition onto 'active' and therefore the sole §9 active-site meter event
// (Q1). site.archive is registered to satisfy §21.2's exact catalog match
// but stays deferred per DEC-008/DEC-009 — its handler intentionally throws
// (smallest-safe stub: reuses the existing generic "error" envelope/
// internal_error catalog string already exercised by test.fail_after_write
// in tests/actions/kernel.test.ts, no new RejectionCode or catalog string).
import { z } from "zod";

import { clientById } from "../db/clients";
import {
  activeSiteCount,
  createSiteRow,
  invalidSupervisorPersonIds,
  siteById,
  updateSiteRow,
  type AddressInfo,
  type SiteSettings,
} from "../db/sites";
import { uuidv7 } from "../domain/ids";
import { outcomeRejected, type ActionDefinition, type ExecContext } from "./types";

const nameInput = z.string().trim().min(1).max(200);
const addressInput = z
  .object({
    street: z.string().trim().max(200).optional(),
    postal_code: z.string().trim().max(20).optional(),
    city: z.string().trim().max(120).optional(),
    country: z.string().trim().max(120).optional(),
  })
  .strict();
const supervisorPersonIdsInput = z.array(z.uuid()).max(200);

const siteCreateInput = z
  .object({
    client_id: z.uuid(),
    name: nameInput,
    address: addressInput.optional(),
    supervisor_person_ids: supervisorPersonIdsInput.optional(),
  })
  .strict();

const siteUpdateInput = z
  .object({
    site_id: z.uuid(),
    name: nameInput.optional(),
    address: addressInput.optional(),
    supervisor_person_ids: supervisorPersonIdsInput.optional(),
  })
  .strict()
  .refine(
    (input) => input.name !== undefined || input.address !== undefined || input.supervisor_person_ids !== undefined,
    { message: "empty patch" },
  );

const siteActivateInput = z
  .object({
    site_id: z.uuid(),
  })
  .strict();

const siteArchiveInput = z
  .object({
    site_id: z.uuid(),
  })
  .strict();

function workspaceId(ctx: ExecContext): string {
  if (ctx.workspaceId === null) {
    throw new Error("site action executed without a workspace id");
  }
  return ctx.workspaceId;
}

// DEC-009 Q3: supervisor_person_ids is the §8/F12 authz source for
// supervisor site scope — every entry must be an existing, active,
// in-workspace person with role_class='supervisor'.
async function supervisorIdsValid(ctx: ExecContext, ids: string[] | undefined): Promise<boolean> {
  if (ids === undefined) {
    return true;
  }
  return (await invalidSupervisorPersonIds(ctx.tx, workspaceId(ctx), ids)).length === 0;
}

export const siteCreateAction: ActionDefinition<z.infer<typeof siteCreateInput>> = {
  name: "site.create",
  actors: { minHumanRole: "manager" },
  threshold: "proposal_gated",
  input: siteCreateInput,
  async execute(ctx, input) {
    // Smallest-safe reference validation, mirroring person.update's
    // exclusion of pseudonymized targets: the client must exist and be
    // active in this workspace.
    const client = await clientById(ctx.tx, workspaceId(ctx), input.client_id);
    if (client === null || client.status !== "active") {
      return outcomeRejected("validation_failed");
    }
    if (!(await supervisorIdsValid(ctx, input.supervisor_person_ids))) {
      return outcomeRejected("validation_failed");
    }

    const site = await createSiteRow(ctx.tx, {
      id: uuidv7(),
      workspaceId: workspaceId(ctx),
      clientId: input.client_id,
      name: input.name,
      address: input.address,
      supervisorPersonIds: input.supervisor_person_ids,
    });

    return {
      result: { site_id: site.id },
      audit: [{ entityType: "sites", entityId: site.id, after: site }],
    };
  },
};

export const siteUpdateAction: ActionDefinition<z.infer<typeof siteUpdateInput>> = {
  name: "site.update",
  actors: { minHumanRole: "manager" },
  threshold: "proposal_gated",
  input: siteUpdateInput,
  async execute(ctx, input) {
    const target = await siteById(ctx.tx, workspaceId(ctx), input.site_id);
    if (target === null || target.status === "archived") {
      return outcomeRejected("validation_failed");
    }
    if (!(await supervisorIdsValid(ctx, input.supervisor_person_ids))) {
      return outcomeRejected("validation_failed");
    }

    const patch: { name?: string; address?: AddressInfo; settings?: SiteSettings } = {};
    const beforeDiff: Record<string, unknown> = {};
    const afterKeys: ("name" | "address" | "settings")[] = [];
    if (input.name !== undefined) {
      patch.name = input.name;
      beforeDiff.name = target.name;
      afterKeys.push("name");
    }
    if (input.address !== undefined) {
      patch.address = input.address;
      beforeDiff.address = target.address;
      afterKeys.push("address");
    }
    if (input.supervisor_person_ids !== undefined) {
      patch.settings = { supervisor_person_ids: input.supervisor_person_ids };
      beforeDiff.settings = target.settings;
      afterKeys.push("settings");
    }

    const updated = await updateSiteRow(ctx.tx, workspaceId(ctx), target.id, patch);
    const afterDiff: Record<string, unknown> = {};
    for (const key of afterKeys) {
      afterDiff[key] = updated[key];
    }

    return {
      result: { site_id: updated.id },
      audit: [{ entityType: "sites", entityId: updated.id, before: beforeDiff, after: afterDiff }],
    };
  },
};

export const siteActivateAction: ActionDefinition<z.infer<typeof siteActivateInput>> = {
  name: "site.activate",
  actors: { minHumanRole: "manager" },
  threshold: "human_only",
  input: siteActivateInput,
  async execute(ctx, input) {
    const target = await siteById(ctx.tx, workspaceId(ctx), input.site_id);
    // §9: site.activate is the sole transition onto 'active' (DEC-009);
    // only a 'draft' site may be activated.
    if (target === null || target.status !== "draft") {
      return outcomeRejected("validation_failed");
    }

    const updated = await updateSiteRow(ctx.tx, workspaceId(ctx), target.id, { status: "active" });
    // §9 meter legibility: the extras carry both the delta and the
    // post-transition count in the same transaction, so the meter is
    // readable directly off the audit trail without re-deriving it.
    const activeSitesAfter = await activeSiteCount(ctx.tx, workspaceId(ctx));

    return {
      result: { site_id: updated.id },
      audit: [
        {
          entityType: "sites",
          entityId: updated.id,
          before: { status: "draft" },
          after: { status: "active" },
          extras: { meter_delta: { metric: "active_sites", delta: 1, active_sites_after: activeSitesAfter } },
        },
      ],
    };
  },
};

// DEC-008/DEC-009: site.archive stays deferred. Registered (per catalog, so
// §21.2's exact-match holds) but never executes — see file header.
export const siteArchiveAction: ActionDefinition<z.infer<typeof siteArchiveInput>> = {
  name: "site.archive",
  actors: { minHumanRole: "manager" },
  threshold: "human_only",
  input: siteArchiveInput,
  async execute() {
    throw new Error("site.archive is deferred per DEC-008/DEC-009 — not implemented in SLICE-007");
  },
};
