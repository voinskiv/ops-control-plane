import { z } from "zod";

import { meRead } from "./me";
import type { ReadDefinition } from "./types";

export class ReadRegistry {
  private readonly definitions = new Map<string, ReadDefinition>();

  register(definition: ReadDefinition): void {
    if (this.definitions.has(definition.name)) {
      throw new Error(`duplicate read definition: ${definition.name}`);
    }
    this.definitions.set(definition.name, definition);
  }

  get(name: string): ReadDefinition | undefined {
    return this.definitions.get(name);
  }

  list(): ReadDefinition[] {
    return [...this.definitions.values()];
  }

  // §5: both parameter and response schemas are exported as JSON Schema;
  // this object is importable by the build-time API/MCP schema exporter.
  jsonSchemas(): Record<string, { params: object; response: object }> {
    return Object.fromEntries(
      this.list().map((definition) => [
        definition.name,
        {
          params: z.toJSONSchema(definition.params),
          response: z.toJSONSchema(definition.response),
        },
      ]),
    );
  }
}

export const readRegistry = new ReadRegistry();
readRegistry.register(meRead);

export const readJsonSchemas = readRegistry.jsonSchemas();
