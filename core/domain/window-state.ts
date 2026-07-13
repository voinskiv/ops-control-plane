// §4/§21.8: the ExecutionWindow state machine is the sole authority for
// lifecycle transitions. SLICE-014 implements only scheduled -> open; the
// remaining §4 commands are typed now and deliberately unavailable until
// their owning slices register actions.
export const windowStatuses = ["scheduled", "open", "fulfilled", "shortfall", "missed", "closed"] as const;
export type WindowStatus = (typeof windowStatuses)[number];

export type WindowTransition =
  | "open"
  | "close_fulfilled"
  | "close_shortfall"
  | "miss"
  | "recompute_fulfilled"
  | "recompute_shortfall"
  | "reconcile"
  | "reopen";

export function windowTransitionTarget(status: WindowStatus, transition: WindowTransition): WindowStatus | null {
  if (transition === "open") {
    return status === "scheduled" ? "open" : null;
  }
  throw new Error(`window transition ${transition} is not implemented`);
}
