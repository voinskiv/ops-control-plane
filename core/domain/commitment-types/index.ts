import { coverageDefinition } from "./coverage";
import { outputDefinition } from "./output";
import { serviceScopeDefinition } from "./service-scope";
import type { CommitmentTypeDefinition, CommitmentTypeName, Fulfillment } from "./types";

export * from "./coverage";
export * from "./output";
export * from "./service-scope";
export * from "./types";

export const commitmentTypeDefinitions = [coverageDefinition, outputDefinition, serviceScopeDefinition] as const;

const definitions = new Map<CommitmentTypeName, CommitmentTypeDefinition<unknown, Fulfillment>>(
  commitmentTypeDefinitions.map((definition) => [
    definition.type,
    definition as CommitmentTypeDefinition<unknown, Fulfillment>,
  ]),
);

export function commitmentTypeDefinition(type: CommitmentTypeName): CommitmentTypeDefinition<unknown, Fulfillment> {
  const definition = definitions.get(type);
  if (definition === undefined) {
    throw new Error(`missing v1 commitment type definition for ${type}`);
  }
  return definition;
}
