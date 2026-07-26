import { describe, expect, it } from "vitest";

import { formatCivilDate, formatInstant } from "../app/date-time-format";

describe("workspace date/time formatting (§15)", () => {
  it("keeps a civil date on the same calendar day west of UTC", () => {
    expect(
      formatCivilDate("2026-07-13", "en-US", "America/Los_Angeles", {
        weekday: "long",
        day: "2-digit",
        month: "long",
        year: "numeric",
      }),
    ).toBe("Monday, July 13, 2026");
  });

  it("uses the Berlin IANA timezone's CET and CEST offsets", () => {
    const options: Intl.DateTimeFormatOptions = {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZoneName: "longOffset",
    };

    expect(formatInstant("2026-01-01T12:00:00.000Z", "en-GB", "Europe/Berlin", options)).toBe(
      "01/01/2026, 13:00 GMT+01:00",
    );
    expect(formatInstant("2026-07-01T12:00:00.000Z", "en-GB", "Europe/Berlin", options)).toBe(
      "01/07/2026, 14:00 GMT+02:00",
    );
  });
});
