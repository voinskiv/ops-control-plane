// §4/§21.8: the Commitment state machine is the sole authority for lifecycle
// transitions. Persistence callers may write only the target returned here.
export const commitmentStatuses = ["draft", "active", "paused", "completed", "archived"] as const;
export type CommitmentStatus = (typeof commitmentStatuses)[number];

export type CommitmentTransition = "activate" | "pause" | "complete" | "archive";

const transitions: Record<CommitmentTransition, Partial<Record<CommitmentStatus, CommitmentStatus>>> = {
  activate: { draft: "active", paused: "active" },
  pause: { active: "paused" },
  complete: { active: "completed", paused: "completed" },
  archive: { draft: "archived", completed: "archived" },
};

export function commitmentTransitionTarget(
  status: CommitmentStatus,
  transition: CommitmentTransition,
): CommitmentStatus | null {
  return transitions[transition][status] ?? null;
}
