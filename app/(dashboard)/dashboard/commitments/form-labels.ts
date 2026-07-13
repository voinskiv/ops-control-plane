import type { CommitmentWeekday } from "@core/domain/commitment-rrule-presets";

export interface CommitmentFormLabels {
  draftTitle: string;
  manageTitle: string;
  siteId: string;
  commitmentId: string;
  type: string;
  types: Record<"coverage" | "output" | "service_scope", string>;
  title: string;
  windowStart: string;
  windowEnd: string;
  schedule: string;
  schedules: Record<"daily" | "weekdays" | "weekly" | "biweekly", string>;
  selectedDays: string;
  weekdays: Record<CommitmentWeekday, string>;
  targetQty: string;
  unit: string;
  checklistKey: string;
  checklistLabel: string;
  validFrom: string;
  validTo: string;
  create: string;
  update: string;
  updateTitle: string;
  action: string;
  actions: Record<"activate" | "pause" | "complete" | "archive", string>;
  reason: string;
  applyAction: string;
  success: string;
  failed: string;
  errors: Record<string, string>;
}
