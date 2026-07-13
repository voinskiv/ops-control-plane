import { Temporal } from "@js-temporal/polyfill";

import type { AuthDb } from "../db/auth";
import { windowCronCommitment } from "../db/commitments";
import { dueScheduledWindows, generatableCommitments } from "../db/windows";
import { localHorizon, occurrenceDates } from "../domain/window-schedule";
import type { Kernel } from "./kernel";

function code(result: unknown): string | undefined {
  return (result as { code?: string }).code;
}

async function dispatchGeneration(kernel: Kernel, workspaceId: string, commitmentId: string, date: string): Promise<void> {
  const envelope = await kernel.dispatch(
    { type: "system", workspaceId },
    {
      name: "window.generate",
      input: { commitment_id: commitmentId, date },
      idempotencyKey: `window.generate:${commitmentId}:${date}`,
    },
  );
  if (envelope.status === "ok") return;
  // A malformed stored rule is a typed per-commitment rejection, and a pause
  // racing discovery is an expected terminal state guard. Neither crashes cron.
  if (envelope.status === "rejected" && ["validation_failed", "window_wrong_state"].includes(code(envelope.result) ?? "")) {
    return;
  }
  throw new Error("window generation failed");
}

export async function generateRollingWindows(
  db: AuthDb,
  kernel: Kernel,
  now: Temporal.Instant = Temporal.Now.instant(),
): Promise<void> {
  const discovered = await db.withClient((tx) => generatableCommitments(tx));
  for (const item of discovered) {
    const commitment = await db.withWorkspace(item.workspace_id, (tx) =>
      windowCronCommitment(tx, item.workspace_id, item.commitment_id));
    if (commitment === null) continue;

    const horizon = localHorizon(now, commitment.time_zone);
    const rangeStart = commitment.valid_from > horizon.start ? commitment.valid_from : horizon.start;
    const validEndExclusive = Temporal.PlainDate.from(commitment.valid_to).add({ days: 1 }).toString();
    const rangeEnd = validEndExclusive < horizon.endExclusive ? validEndExclusive : horizon.endExclusive;
    if (rangeStart >= rangeEnd) continue;

    let dates: string[];
    try {
      dates = occurrenceDates(commitment.schedule_rrule, commitment.valid_from, rangeStart, rangeEnd);
    } catch {
      // No occurrence can be expanded from an invalid rule. Dispatch the first
      // valid in-horizon date so window.generate records its typed rejection.
      await dispatchGeneration(kernel, item.workspace_id, item.commitment_id, rangeStart);
      continue;
    }
    await Promise.all(dates.map((date) => dispatchGeneration(kernel, item.workspace_id, item.commitment_id, date)));
  }
}

export async function openDueWindows(db: AuthDb, kernel: Kernel): Promise<void> {
  const discovered = await db.withClient((tx) => dueScheduledWindows(tx));
  for (const item of discovered) {
    const envelope = await kernel.dispatch(
      { type: "system", workspaceId: item.workspace_id },
      {
        name: "window.open",
        input: { window_id: item.window_id },
        idempotencyKey: `window.open:${item.window_id}`,
      },
    );
    if (envelope.status === "ok") continue;
    if (envelope.status === "rejected" && code(envelope.result) === "window_wrong_state") continue;
    throw new Error("due window open failed");
  }
}
