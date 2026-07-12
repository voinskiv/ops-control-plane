// DEC-016 F-09 / DEC-020 / DEC-021: tenant discovery is read-only through the
// narrow SECURITY DEFINER function; every completion still uses Kernel.dispatch.
import type { Kernel } from "./kernel";
import type { AuthDb } from "../db/auth";
import { dueCommitments } from "../db/commitments";

export const VALID_TO_COMPLETION_REASON = "valid_to_reached";

export async function completeDueCommitments(db: AuthDb, kernel: Kernel): Promise<void> {
  const due = await db.withClient((tx) => dueCommitments(tx));
  for (const item of due) {
    const envelope = await kernel.dispatch(
      { type: "system", workspaceId: item.workspace_id },
      {
        name: "commitment.complete",
        input: { commitment_id: item.commitment_id, reason: VALID_TO_COMPLETION_REASON },
        idempotencyKey: `commitment.complete:${item.commitment_id}`,
      },
    );
    // A concurrent human completion can win after discovery. That expected
    // state rejection needs no retry; every other failure keeps the cron red.
    if (envelope.status === "rejected" && (envelope.result as { code?: string }).code === "commitment_wrong_state") {
      continue;
    }
    if (envelope.status !== "ok") {
      throw new Error("due commitment completion failed");
    }
  }
}
