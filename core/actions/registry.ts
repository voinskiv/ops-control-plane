// §5: code-registered action layer. §21.2 checks registry names against the
// catalog for the actions in scope through the current phase; production
// actions register here starting with SLICE-005 (workspace.create).
import type { ActionDefinition } from "./types";

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
