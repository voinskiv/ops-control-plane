import { z } from "zod";

export const commitmentTypeNames = ["coverage", "output", "service_scope"] as const;
export type CommitmentTypeName = (typeof commitmentTypeNames)[number];

export const proofTypeSchema = z.enum(["photo", "signature"]);
export type ProofType = z.infer<typeof proofTypeSchema>;

const noProofRequirementSchema = z
  .object({
    proof: z.object({ required: z.literal(false) }).strict(),
  })
  .strict();

const requiredProofRequirementSchema = z
  .object({
    proof: z
      .object({
        required: z.literal(true),
        types: z.array(proofTypeSchema).min(1).refine((types) => new Set(types).size === types.length),
        min_count: z.number().int().min(1),
      })
      .strict(),
  })
  .strict();

// DEC-017: omitted verification persists with only required=false. Proof kind
// and min_count exist only when the draft explicitly opts into proof gating.
export const verificationSchema = z.union([noProofRequirementSchema, requiredProofRequirementSchema]);
export type Verification = z.infer<typeof verificationSchema>;

export const defaultVerification: Verification = { proof: { required: false } };

export const localWallClockSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/);

export const baseSpecShape = {
  window_start_time: localWallClockSchema,
  window_end_time: localWallClockSchema,
};

export interface WindowTimesSpec {
  window_start_time: string;
  window_end_time: string;
}

// DEC-016 F-11: equality and an earlier end time both mean next-day end.
export function windowEndDayOffset(spec: WindowTimesSpec): 0 | 1 {
  return spec.window_end_time <= spec.window_start_time ? 1 : 0;
}

export interface ChecklistItem {
  key: string;
  label: string;
}

export interface ChecklistProofItem {
  key: string;
  done: boolean;
  note?: string;
}

export interface VerificationRequirements {
  verification: Verification;
  checklist?: ChecklistItem[];
}

export type SatisfyingRecordKind = "coverage_confirm" | "presence" | "output" | "service_confirmation";
export type ShortfallExceptionType = "under_coverage" | "output_shortfall";

export interface FulfillmentRecord {
  id: string;
  kind: "presence" | "coverage_confirm" | "output" | "service_confirmation" | "note";
  status: "recorded" | "verified" | "superseded" | "voided";
  qty?: number | null;
  subject_person_id?: string | null;
  occurred_at: string;
  received_at: string;
  checklist?: { items: ChecklistProofItem[] } | null;
}

interface FulfillmentBase {
  target_qty: number | null;
  unit: string | null;
  satisfied: boolean;
  counted_record_ids: string[];
  computed_at: string;
}

export interface CoverageFulfillment extends FulfillmentBase {
  rule: "coverage_max";
  confirmed_headcount: number;
}

export interface OutputFulfillment extends FulfillmentBase {
  rule: "output_sum";
  verified_qty: number;
}

export interface ServiceScopeFulfillment extends FulfillmentBase {
  rule: "checklist_completion";
  checklist_state: { items: ChecklistProofItem[] };
}

export type Fulfillment = CoverageFulfillment | OutputFulfillment | ServiceScopeFulfillment;

export interface FulfillmentInput<Spec> {
  spec: Spec;
  target_qty: number | null;
  unit: string | null;
  records: FulfillmentRecord[];
  computed_at: string;
}

// F-05: hints are internal build-time TypeScript data. No schema or read
// exports them, and consumers must not persist or serialize them.
export interface CaptureUiHints {
  control: "headcount" | "quantity" | "checklist";
  allow_person_presence: boolean;
}

export interface CommitmentTypeDefinition<Spec, Result extends Fulfillment> {
  type: CommitmentTypeName;
  version: 1;
  specSchema: z.ZodType<Spec>;
  satisfyingRecordKinds: readonly SatisfyingRecordKind[];
  defaultVerification: Verification;
  deriveRequirements(spec: Spec, verification: Verification): VerificationRequirements;
  fulfillmentRule(input: FulfillmentInput<Spec>): Result;
  shortfallException: ShortfallExceptionType;
  captureUiHints: CaptureUiHints;
}

export function verificationRequirements(verification: Verification): VerificationRequirements {
  return { verification: structuredClone(verification) };
}
