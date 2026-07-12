// DEC-016 item 18 / F-08: manager forms expose presets only. RRULE semantic
// evaluation remains owned by window.generate (SLICE-014).
export const commitmentWeekdays = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export type CommitmentWeekday = (typeof commitmentWeekdays)[number];

export type CommitmentRrulePreset = "daily" | "weekdays" | "weekly" | "biweekly";

export function commitmentRrule(preset: CommitmentRrulePreset, days: readonly CommitmentWeekday[] = []): string | null {
  if (preset === "daily") {
    return "FREQ=DAILY";
  }
  if (preset === "weekdays") {
    return "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
  }
  const selected = commitmentWeekdays.filter((day) => days.includes(day));
  if (selected.length === 0) {
    return null;
  }
  const interval = preset === "biweekly" ? ";INTERVAL=2" : "";
  return `FREQ=WEEKLY${interval};BYDAY=${selected.join(",")}`;
}
