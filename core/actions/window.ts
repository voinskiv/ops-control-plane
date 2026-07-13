import { z } from "zod";

import { lockCommitment } from "../db/commitments";
import { createWindowRow, lockWindow, supervisorHasWindowSite, updateWindowStatus } from "../db/windows";
import { workspaceTimeZone } from "../db/workspaces";
import { commitmentTypeDefinition, type WindowTimesSpec } from "../domain/commitment-types";
import { uuidv7 } from "../domain/ids";
import { isRruleOccurrence, windowInstants } from "../domain/window-schedule";
import { windowTransitionTarget } from "../domain/window-state";
import { outcomeRejected, type ActionDefinition, type ExecContext } from "./types";

const windowGenerateInput = z.object({ commitment_id: z.uuid(), date: z.iso.date() }).strict();
const windowOpenInput = z.object({ window_id: z.uuid() }).strict();

function workspaceId(ctx: ExecContext): string {
  if (ctx.workspaceId === null) throw new Error("window action executed without a workspace id");
  return ctx.workspaceId;
}

export const windowGenerateAction: ActionDefinition<z.infer<typeof windowGenerateInput>> = {
  name: "window.generate",
  actors: { system: true },
  threshold: "autonomous_safe",
  input: windowGenerateInput,
  async execute(ctx, input) {
    const commitment = await lockCommitment(ctx.tx, workspaceId(ctx), input.commitment_id);
    if (commitment === null) return outcomeRejected("validation_failed");
    if (commitment.status !== "active") return outcomeRejected("window_wrong_state");
    if (input.date < commitment.valid_from || input.date > commitment.valid_to) {
      return outcomeRejected("validation_failed");
    }

    const definition = commitmentTypeDefinition(commitment.type);
    const parsedSpec = definition.specSchema.safeParse(commitment.spec);
    if (!parsedSpec.success) return outcomeRejected("validation_failed");
    try {
      if (!isRruleOccurrence(commitment.schedule_rrule, commitment.valid_from, input.date)) {
        return outcomeRejected("validation_failed");
      }
    } catch {
      return outcomeRejected("validation_failed");
    }

    const timeZone = await workspaceTimeZone(ctx.tx, workspaceId(ctx));
    if (timeZone === null) return outcomeRejected("validation_failed");
    let instants: { startsAt: string; endsAt: string };
    try {
      instants = windowInstants(input.date, parsedSpec.data as WindowTimesSpec, timeZone);
    } catch {
      return outcomeRejected("validation_failed");
    }
    const requirements = definition.deriveRequirements(parsedSpec.data, commitment.verification);
    const fulfillment = definition.fulfillmentRule({
      spec: parsedSpec.data,
      target_qty: commitment.target_qty === null ? null : Number(commitment.target_qty),
      unit: commitment.unit,
      records: [],
      computed_at: new Date().toISOString(),
    });
    const window = await createWindowRow(ctx.tx, {
      id: uuidv7(),
      workspaceId: workspaceId(ctx),
      commitmentId: commitment.id,
      siteId: commitment.site_id,
      date: input.date,
      startsAt: instants.startsAt,
      endsAt: instants.endsAt,
      targetQty: commitment.target_qty,
      unit: commitment.unit,
      requirements,
      fulfillment,
    });
    return {
      result: { window_id: window.id },
      audit: [{
        entityType: "execution_windows",
        entityId: window.id,
        after: window,
        extras: { frozen_targets: { target_qty: window.target_qty, unit: window.unit, requirements: window.requirements } },
      }],
    };
  },
};

export const windowOpenAction: ActionDefinition<z.infer<typeof windowOpenInput>> = {
  name: "window.open",
  actors: { minHumanRole: "supervisor", system: true },
  threshold: "autonomous_safe",
  input: windowOpenInput,
  async execute(ctx, input) {
    const before = await lockWindow(ctx.tx, workspaceId(ctx), input.window_id);
    if (before === null) return outcomeRejected("validation_failed");
    const target = windowTransitionTarget(before.status, "open");
    if (target === null) return outcomeRejected("window_wrong_state");
    if (
      ctx.actor.type === "person" &&
      ctx.actor.roleClass === "supervisor" &&
      !(await supervisorHasWindowSite(ctx.tx, workspaceId(ctx), before.site_id, ctx.actor.id))
    ) {
      return outcomeRejected("unauthorized");
    }
    const after = await updateWindowStatus(ctx.tx, before.id, target);
    return {
      result: { window_id: after.id },
      audit: [{ entityType: "execution_windows", entityId: after.id, before, after }],
    };
  },
};
