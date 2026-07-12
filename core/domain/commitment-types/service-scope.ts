import { z } from "zod";

import {
  baseSpecShape,
  defaultVerification,
  type ChecklistItem,
  type CommitmentTypeDefinition,
  type FulfillmentRecord,
  type ServiceScopeFulfillment,
} from "./types";

const checklistItemSchema = z.object({ key: z.string().trim().min(1), label: z.string().trim().min(1) }).strict();

export const serviceScopeSpecSchema = z
  .object({ ...baseSpecShape, checklist: z.array(checklistItemSchema).min(1) })
  .strict()
  .refine((spec) => new Set(spec.checklist.map((item) => item.key)).size === spec.checklist.length, {
    message: "checklist keys must be unique",
    path: ["checklist"],
  });
export type ServiceScopeSpec = z.infer<typeof serviceScopeSpecSchema>;

function descendingTimestamp(left: string, right: string): number {
  return Date.parse(right) - Date.parse(left);
}

// DEC-017: the single canonical ordering comparator for SLICE-016/017 and all
// later consumers. status='verified' is the exact non-superseded/non-voided
// subset; transport arrival is only the second tie-breaker.
export function compareLatestVerifiedServiceConfirmations(left: FulfillmentRecord, right: FulfillmentRecord): number {
  return (
    descendingTimestamp(left.occurred_at, right.occurred_at) ||
    descendingTimestamp(left.received_at, right.received_at) ||
    right.id.localeCompare(left.id)
  );
}

export function latestVerifiedServiceConfirmation(records: FulfillmentRecord[]): FulfillmentRecord | null {
  return (
    records
      .filter((record) => record.status === "verified" && record.kind === "service_confirmation")
      .sort(compareLatestVerifiedServiceConfirmations)[0] ?? null
  );
}

function frozenChecklist(items: ChecklistItem[]): ChecklistItem[] {
  return items.map((item) => ({ key: item.key, label: item.label }));
}

export const serviceScopeDefinition: CommitmentTypeDefinition<ServiceScopeSpec, ServiceScopeFulfillment> = {
  type: "service_scope",
  version: 1,
  specSchema: serviceScopeSpecSchema,
  satisfyingRecordKinds: ["service_confirmation"],
  defaultVerification,
  deriveRequirements(spec, verification) {
    return { verification: structuredClone(verification), checklist: frozenChecklist(spec.checklist) };
  },
  fulfillmentRule(input) {
    const latest = latestVerifiedServiceConfirmation(input.records);
    const items = latest?.checklist?.items ?? [];
    const doneKeys = new Set(items.filter((item) => item.done).map((item) => item.key));
    const satisfied = input.spec.checklist.every((item) => doneKeys.has(item.key));
    return {
      rule: "checklist_completion",
      target_qty: input.target_qty,
      unit: input.unit,
      checklist_state: { items: structuredClone(items) },
      satisfied: latest !== null && satisfied,
      counted_record_ids: latest === null ? [] : [latest.id],
      computed_at: input.computed_at,
    };
  },
  shortfallException: "output_shortfall",
  captureUiHints: { control: "checklist", allow_person_presence: false },
};
