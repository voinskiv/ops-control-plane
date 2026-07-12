import { z } from "zod";

import {
  baseSpecShape,
  defaultVerification,
  verificationRequirements,
  type CommitmentTypeDefinition,
  type CoverageFulfillment,
} from "./types";

export const coverageSpecSchema = z.object(baseSpecShape).strict();
export type CoverageSpec = z.infer<typeof coverageSpecSchema>;

export const coverageDefinition: CommitmentTypeDefinition<CoverageSpec, CoverageFulfillment> = {
  type: "coverage",
  version: 1,
  specSchema: coverageSpecSchema,
  satisfyingRecordKinds: ["coverage_confirm", "presence"],
  defaultVerification,
  deriveRequirements(_spec, verification) {
    return verificationRequirements(verification);
  },
  fulfillmentRule(input) {
    const records = input.records.filter(
      (record) => record.status === "verified" && (record.kind === "coverage_confirm" || record.kind === "presence"),
    );
    const confirmed = records
      .filter((record) => record.kind === "coverage_confirm")
      .reduce((maximum, record) => Math.max(maximum, record.qty ?? 0), 0);
    const present = new Set(
      records
        .filter((record) => record.kind === "presence" && record.subject_person_id !== null && record.subject_person_id !== undefined)
        .map((record) => record.subject_person_id as string),
    ).size;
    const confirmedHeadcount = Math.max(confirmed, present);
    return {
      rule: "coverage_max",
      target_qty: input.target_qty,
      unit: input.unit,
      confirmed_headcount: confirmedHeadcount,
      satisfied: input.target_qty !== null && confirmedHeadcount >= input.target_qty,
      counted_record_ids: records.map((record) => record.id),
      computed_at: input.computed_at,
    };
  },
  shortfallException: "under_coverage",
  captureUiHints: { control: "headcount", allow_person_presence: true },
};
