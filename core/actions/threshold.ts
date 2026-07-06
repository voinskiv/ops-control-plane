// §5 threshold gate: governs agent actors only — humans, system, and
// platform pass through (their gate is the role matrix).
import type { ActionDefinition, Actor, RejectionCode } from "./types";

export type ThresholdDecision = { kind: "execute" } | { kind: "reject"; code: RejectionCode };

export function thresholdGate(actor: Actor, definition: ActionDefinition): ThresholdDecision {
  if (actor.type !== "agent") {
    return { kind: "execute" };
  }
  switch (definition.threshold) {
    case "autonomous_safe":
      return { kind: "execute" };
    case "proposal_gated":
      // F2: an agent invocation of a proposal_gated action converts into an
      // AgentProposal and mutates nothing. Proposal conversion ships with the
      // agent plumbing (SLICE-034, Phase 4); until then the invocation is a
      // typed rejection — equally mutation-free.
      return { kind: "reject", code: "proposal_gating_unavailable" };
    case "human_only":
      // Unreachable in practice: authorize() already rejects agents on
      // human_only actions (F2).
      return { kind: "reject", code: "unauthorized" };
  }
}
