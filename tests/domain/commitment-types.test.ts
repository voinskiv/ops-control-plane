import { describe, expect, it } from "vitest";

import {
  commitmentTypeDefinitions,
  compareLatestVerifiedServiceConfirmations,
  coverageDefinition,
  latestVerifiedServiceConfirmation,
  outputDefinition,
  serviceScopeDefinition,
  serviceScopeSpecSchema,
  windowEndDayOffset,
  type FulfillmentRecord,
} from "@core/domain/commitment-types";

const computedAt = "2026-07-13T10:00:00.000Z";

function record(overrides: Partial<FulfillmentRecord> & Pick<FulfillmentRecord, "id" | "kind">): FulfillmentRecord {
  return {
    status: "verified",
    occurred_at: "2026-07-13T08:00:00.000Z",
    received_at: "2026-07-13T08:01:00.000Z",
    ...overrides,
  };
}

describe("v1 commitment type registry (§3 F10)", () => {
  it("registers exactly coverage, output, and service_scope at version 1", () => {
    expect(commitmentTypeDefinitions.map(({ type, version }) => ({ type, version }))).toEqual([
      { type: "coverage", version: 1 },
      { type: "output", version: 1 },
      { type: "service_scope", version: 1 },
    ]);
  });

  it("validates HH:MM local wall clocks and treats end <= start as overnight", () => {
    expect(windowEndDayOffset({ window_start_time: "22:00", window_end_time: "06:00" })).toBe(1);
    expect(windowEndDayOffset({ window_start_time: "08:00", window_end_time: "08:00" })).toBe(1);
    expect(windowEndDayOffset({ window_start_time: "08:00", window_end_time: "16:00" })).toBe(0);
    expect(coverageDefinition.specSchema.safeParse({ window_start_time: "24:00", window_end_time: "06:00" }).success).toBe(false);
  });

  it("freezes unique service checklist keys into derived requirements", () => {
    const spec = serviceScopeSpecSchema.parse({
      window_start_time: "08:00",
      window_end_time: "16:00",
      checklist: [{ key: "floor", label: "Floor cleaned" }],
    });
    const requirements = serviceScopeDefinition.deriveRequirements(spec, { proof: { required: false } });
    expect(requirements).toEqual({
      verification: { proof: { required: false } },
      checklist: [{ key: "floor", label: "Floor cleaned" }],
    });
    expect(
      serviceScopeSpecSchema.safeParse({
        window_start_time: "08:00",
        window_end_time: "16:00",
        checklist: [
          { key: "floor", label: "One" },
          { key: "floor", label: "Two" },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("commitment fulfillment rules (§3 F10, DEC-016 items 3–4)", () => {
  it("coverage uses max(confirm qty, distinct presence persons), never a sum", () => {
    const result = coverageDefinition.fulfillmentRule({
      spec: { window_start_time: "08:00", window_end_time: "16:00" },
      target_qty: 5,
      unit: null,
      records: [
        record({ id: "a", kind: "coverage_confirm", qty: 4 }),
        record({ id: "b", kind: "coverage_confirm", qty: 5 }),
        record({ id: "c", kind: "presence", subject_person_id: "person-1" }),
        record({ id: "d", kind: "presence", subject_person_id: "person-1" }),
        record({ id: "e", kind: "presence", subject_person_id: "person-2" }),
      ],
      computed_at: computedAt,
    });
    expect(result).toMatchObject({ rule: "coverage_max", confirmed_headcount: 5, satisfied: true });
  });

  it("output sums only verified output quantities", () => {
    const result = outputDefinition.fulfillmentRule({
      spec: { window_start_time: "08:00", window_end_time: "16:00" },
      target_qty: 10,
      unit: "pieces",
      records: [
        record({ id: "a", kind: "output", qty: 4 }),
        record({ id: "b", kind: "output", qty: 6 }),
        record({ id: "c", kind: "output", qty: 100, status: "voided" }),
        record({ id: "d", kind: "note" }),
      ],
      computed_at: computedAt,
    });
    expect(result).toMatchObject({ rule: "output_sum", verified_qty: 10, satisfied: true });
    expect(result.counted_record_ids).toEqual(["a", "b"]);
  });

  it("service_scope requires every frozen key on the latest verified checklist proof", () => {
    const spec = {
      window_start_time: "08:00",
      window_end_time: "16:00",
      checklist: [
        { key: "floor", label: "Floor" },
        { key: "bins", label: "Bins" },
      ],
    };
    const result = serviceScopeDefinition.fulfillmentRule({
      spec,
      target_qty: null,
      unit: null,
      records: [
        record({
          id: "a",
          kind: "service_confirmation",
          occurred_at: "2026-07-13T08:00:00.000Z",
          checklist: { items: [{ key: "floor", done: true }] },
        }),
        record({
          id: "b",
          kind: "service_confirmation",
          occurred_at: "2026-07-13T09:00:00.000Z",
          checklist: { items: [{ key: "floor", done: true }, { key: "bins", done: true }] },
        }),
      ],
      computed_at: computedAt,
    });
    expect(result).toMatchObject({ rule: "checklist_completion", satisfied: true, counted_record_ids: ["b"] });
    expect(serviceScopeDefinition.shortfallException).toBe("output_shortfall");
  });
});

describe("DEC-017 latest verified service confirmation comparator", () => {
  it("orders by occurred_at DESC before transport arrival", () => {
    const earlierDomain = record({
      id: "a",
      kind: "service_confirmation",
      occurred_at: "2026-07-13T08:00:00.000Z",
      received_at: "2026-07-13T10:00:00.000Z",
    });
    const laterDomain = record({
      id: "b",
      kind: "service_confirmation",
      occurred_at: "2026-07-13T09:00:00.000Z",
      received_at: "2026-07-13T09:01:00.000Z",
    });
    expect([earlierDomain, laterDomain].sort(compareLatestVerifiedServiceConfirmations)[0]?.id).toBe("b");
  });

  it("ties occurred_at with received_at DESC", () => {
    const first = record({ id: "a", kind: "service_confirmation", received_at: "2026-07-13T09:00:00.000Z" });
    const second = record({ id: "b", kind: "service_confirmation", received_at: "2026-07-13T09:01:00.000Z" });
    expect([first, second].sort(compareLatestVerifiedServiceConfirmations)[0]?.id).toBe("b");
  });

  it("ties occurred_at and received_at with UUIDv7 id DESC and excludes non-verified rows", () => {
    const lower = record({ id: "0190f000-0000-7000-8000-000000000001", kind: "service_confirmation" });
    const higher = record({ id: "0190f000-0000-7000-8000-000000000002", kind: "service_confirmation" });
    const voided = record({ id: "0190f000-0000-7000-8000-000000000003", kind: "service_confirmation", status: "voided" });
    expect(latestVerifiedServiceConfirmation([lower, voided, higher])?.id).toBe(higher.id);
  });
});
