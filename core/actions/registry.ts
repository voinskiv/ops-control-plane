// §5: code-registered action layer. §21.2 checks registry names against the
// catalog for the actions in scope through the current phase; production
// actions register here starting with SLICE-005 (workspace.create).
import type { ActionDefinition } from "./types";
import { clientArchiveAction, clientCreateAction, clientUpdateAction } from "./client";
import {
  personCreateAction,
  personDeactivateAction,
  personInviteAction,
  personLinkAuthOperation,
  personPseudonymizeAction,
  personUpdateAction,
} from "./person";
import { siteActivateAction, siteArchiveAction, siteCreateAction, siteUpdateAction } from "./site";
import { workspaceCreateAction } from "./workspace";

export class ActionRegistry {
  private readonly definitions = new Map<string, ActionDefinition>();

  register<In>(definition: ActionDefinition<In>): void {
    if (this.definitions.has(definition.name)) {
      throw new Error(`action ${definition.name} is already registered`);
    }
    this.definitions.set(definition.name, definition as ActionDefinition);
  }

  get(name: string): ActionDefinition | undefined {
    return this.definitions.get(name);
  }

  list(): ActionDefinition[] {
    return [...this.definitions.values()];
  }
}

// The application-wide registry the dispatch surface mounts.
export const registry = new ActionRegistry();
registry.register(workspaceCreateAction);
registry.register(personCreateAction);
registry.register(personUpdateAction);
registry.register(personDeactivateAction);
registry.register(personPseudonymizeAction);
registry.register(personInviteAction);
registry.register(clientCreateAction);
registry.register(clientUpdateAction);
registry.register(clientArchiveAction);
registry.register(siteCreateAction);
registry.register(siteUpdateAction);
registry.register(siteActivateAction);
registry.register(siteArchiveAction);

export const internalRegistry = new ActionRegistry();
internalRegistry.register(personLinkAuthOperation);
