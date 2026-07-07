// SLICE-005: workspace.create (§5 catalog) creates the tenant root through the
// action kernel as a platform, human_only action and records a plan snapshot in
// audit extras.
import { z } from "zod";

import { createWorkspaceRow, planSnapshotForCode } from "../db/workspaces";
import { uuidv7 } from "../domain/ids";
import type { ActionDefinition } from "./types";

const workspaceCreateInput = z.object({
  name: z.string().min(1),
  plan_code: z.string().min(1),
}).strict();

export const workspaceCreateAction: ActionDefinition<z.infer<typeof workspaceCreateInput>> = {
  name: "workspace.create",
  actors: { platform: true },
  threshold: "human_only",
  input: workspaceCreateInput,
  async execute(ctx, input) {
    const planSnapshot = await planSnapshotForCode(ctx.tx, input.plan_code);
    if (planSnapshot === null) {
      throw new Error(`workspace.create unknown plan_code ${input.plan_code}`);
    }

    const workspaceId = uuidv7();
    await ctx.setWorkspaceId(workspaceId);
    const workspace = await createWorkspaceRow(ctx.tx, {
      id: workspaceId,
      name: input.name,
      planCode: input.plan_code,
    });

    return {
      result: { workspace_id: workspace.id },
      audit: [
        {
          entityType: "workspaces",
          entityId: workspace.id,
          after: workspace,
          extras: { plan_snapshot: planSnapshot },
        },
      ],
    };
  },
};
