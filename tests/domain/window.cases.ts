// Imported by commitment-state.test.ts: the two §4 machines share one domain
// test worker while retaining separate describes.
import { describe, expect, it } from "vitest";

import { isRruleOccurrence, occurrenceDates, windowInstants } from "@core/domain/window-schedule";
import { windowTransitionTarget, type WindowStatus, type WindowTransition } from "@core/domain/window-state";

describe("ExecutionWindow state machine (§4/§21.8)", () => {
  it("implements only scheduled -> open in SLICE-014", () => {
    const statuses: WindowStatus[] = ["scheduled", "open", "fulfilled", "shortfall", "missed", "closed"];
    for (const status of statuses) {
      expect(windowTransitionTarget(status, "open")).toBe(status === "scheduled" ? "open" : null);
    }
  });

  it("types later §4 transitions but keeps them unavailable until their slices", () => {
    const later: Exclude<WindowTransition, "open">[] = [
      "close_fulfilled", "close_shortfall", "miss", "recompute_fulfilled",
      "recompute_shortfall", "reconcile", "reopen",
    ];
    for (const transition of later) {
      expect(() => windowTransitionTarget("open", transition)).toThrow(`window transition ${transition} is not implemented`);
    }
  });
});

describe("window RRULE dates (DEC-023)", () => {
  it("anchors interval rules to valid_from and expands a half-open horizon", () => {
    expect(occurrenceDates("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO", "2026-07-06", "2026-07-13", "2026-07-28"))
      .toEqual(["2026-07-20"]);
    expect(isRruleOccurrence("FREQ=WEEKLY;BYDAY=MO,WE", "2026-07-01", "2026-07-13")).toBe(true);
    expect(isRruleOccurrence("FREQ=WEEKLY;BYDAY=MO,WE", "2026-07-01", "2026-07-14")).toBe(false);
    expect(() => occurrenceDates("NOT AN RRULE", "2026-07-01", "2026-07-01", "2026-07-08")).toThrow();
  });
});

describe("Europe/Berlin DST resolution (DEC-023)", () => {
  it("moves the 2026 spring gap 02:30 start to the first valid instant", () => {
    expect(windowInstants("2026-03-29", { window_start_time: "02:30", window_end_time: "04:00" }, "Europe/Berlin"))
      .toEqual({ startsAt: "2026-03-29T01:00:00Z", endsAt: "2026-03-29T02:00:00Z" });
  });

  it("uses the earlier offset for the 2026 fall overlap 02:30 start", () => {
    expect(windowInstants("2026-10-25", { window_start_time: "02:30", window_end_time: "04:00" }, "Europe/Berlin"))
      .toEqual({ startsAt: "2026-10-25T00:30:00Z", endsAt: "2026-10-25T03:00:00Z" });
  });

  it("applies the same rules to overnight ends crossing both transitions", () => {
    expect(windowInstants("2026-03-28", { window_start_time: "23:00", window_end_time: "02:30" }, "Europe/Berlin"))
      .toEqual({ startsAt: "2026-03-28T22:00:00Z", endsAt: "2026-03-29T01:00:00Z" });
    expect(windowInstants("2026-10-24", { window_start_time: "23:00", window_end_time: "02:30" }, "Europe/Berlin"))
      .toEqual({ startsAt: "2026-10-24T21:00:00Z", endsAt: "2026-10-25T00:30:00Z" });
  });
});
