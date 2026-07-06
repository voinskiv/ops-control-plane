// §5/§8: static role × action matrix. Owner inherits manager, manager
// inherits supervisor (F6). Agent actors are admitted for any action not
// classified human_only — the execute-vs-propose decision belongs to the
// threshold gate (F2).
import type { ActionDefinition, Actor, RejectionCode, RoleClass } from "./types";

const ROLE_RANK: Record<RoleClass, number> = {
  worker: 0,
  supervisor: 1,
  manager: 2,
  owner: 3,
};

export function authorize(actor: Actor, definition: ActionDefinition): RejectionCode | null {
  switch (actor.type) {
    case "person": {
      const min = definition.actors.minHumanRole;
      if (min === undefined) {
        return "unauthorized";
      }
      return ROLE_RANK[actor.roleClass] >= ROLE_RANK[min] ? null : "unauthorized";
    }
    case "system":
      return definition.actors.system ? null : "unauthorized";
    case "platform":
      return definition.actors.platform ? null : "unauthorized";
    case "agent":
      return definition.threshold !== "human_only" ? null : "unauthorized";
  }
}
