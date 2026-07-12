import { z } from "zod";

import {
  baseSpecShape,
  defaultVerification,
  verificationRequirements,
  type CommitmentTypeDefinition,
  type OutputFulfillment,
} from "./types";

export const outputSpecSchema = z.object(baseSpecShape).strict();
export type OutputSpec = z.infer<typeof outputSpecSchema>;

export const outputDefinition: CommitmentTypeDefinition<OutputSpec, OutputFulfillment> = {
  type: "output",
  version: 1,
  specSchema: outputSpecSchema,
  satisfyingRecordKinds: ["output"],
  defaultVerification,
  deriveRequirements(_spec, verification) {
    return verificationRequirements(verification);
  },
  fulfillmentRule(input) {
    const records = input.records.filter((record) => record.status === "verified" && record.kind === "output");
    const verifiedQty = records.reduce((total, record) => total + (record.qty ?? 0), 0);
    return {
      rule: "output_sum",
      target_qty: input.target_qty,
      unit: input.unit,
      verified_qty: verifiedQty,
      satisfied: input.target_qty !== null && verifiedQty >= input.target_qty,
      counted_record_ids: records.map((record) => record.id),
      computed_at: input.computed_at,
    };
  },
  shortfallException: "output_shortfall",
  captureUiHints: { control: "quantity", allow_person_presence: false },
};
