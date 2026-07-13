import { describe, expect, it } from "vitest";

import { commitmentTransitionTarget, type CommitmentStatus, type CommitmentTransition } from "@core/domain/commitment-state";
import { commitmentRrule } from "@core/domain/commitment-rrule-presets";

describe("Commitment state machine (§4/§21.8)", () => {
  it("contains exactly the approved transitions", () => {
    const expected = new Map<string, string>([
      ["activate:draft", "active"], ["activate:paused", "active"],
      ["pause:active", "paused"], ["complete:active", "completed"],
      ["complete:paused", "completed"], ["archive:draft", "archived"],
      ["archive:completed", "archived"],
    ]);
    const statuses: CommitmentStatus[] = ["draft", "active", "paused", "completed", "archived"];
    const commands: CommitmentTransition[] = ["activate", "pause", "complete", "archive"];
    for (const command of commands) {
      for (const status of statuses) {
        expect(commitmentTransitionTarget(status, command)).toBe(expected.get(`${command}:${status}`) ?? null);
      }
    }
  });
});

describe("manager RRULE presets (DEC-016 F-08)", () => {
  it("emits only the four approved preset shapes", () => {
    expect(commitmentRrule("daily")).toBe("FREQ=DAILY");
    expect(commitmentRrule("weekdays")).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
    expect(commitmentRrule("weekly", ["WE", "MO"])).toBe("FREQ=WEEKLY;BYDAY=MO,WE");
    expect(commitmentRrule("biweekly", ["FR"])).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=FR");
    expect(commitmentRrule("weekly", [])).toBeNull();
  });
});
