import { Temporal } from "@js-temporal/polyfill";
import { RRule } from "rrule";

import { windowEndDayOffset, type WindowTimesSpec } from "./commitment-types";

function utcDate(date: string): Date {
  return new Date(`${date}T00:00:00.000Z`);
}

function parsedRule(rrule: string, validFrom: string): RRule {
  const options = RRule.parseString(rrule.trim());
  return new RRule({ ...options, dtstart: utcDate(validFrom) });
}

export function isRruleOccurrence(rrule: string, validFrom: string, date: string): boolean {
  const rule = parsedRule(rrule, validFrom);
  const start = utcDate(date);
  const occurrence = rule.after(new Date(start.getTime() - 1), true);
  return occurrence !== null && occurrence.toISOString().slice(0, 10) === date;
}

export function occurrenceDates(
  rrule: string,
  validFrom: string,
  rangeStart: string,
  rangeEndExclusive: string,
): string[] {
  // Parse once so malformed stored rules fail before any partial expansion.
  parsedRule(rrule, validFrom);
  const dates: string[] = [];
  let date = Temporal.PlainDate.from(rangeStart);
  const end = Temporal.PlainDate.from(rangeEndExclusive);
  while (Temporal.PlainDate.compare(date, end) < 0) {
    const value = date.toString();
    if (isRruleOccurrence(rrule, validFrom, value)) dates.push(value);
    date = date.add({ days: 1 });
  }
  return dates;
}

function wallClockInstant(date: Temporal.PlainDate, time: string, timeZone: string): string {
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const requested = date.toPlainDateTime({ hour, minute });
  const fields = (value: Temporal.PlainDateTime) => ({
    timeZone,
    year: value.year,
    month: value.month,
    day: value.day,
    hour: value.hour,
    minute: value.minute,
  });
  const earlier = Temporal.ZonedDateTime.from(fields(requested), { disambiguation: "earlier" });
  if (earlier.toPlainDateTime().equals(requested)) {
    // Normal times produce the same instant; overlaps produce two and DEC-023
    // chooses the earlier offset.
    return earlier.toInstant().toString();
  }
  // Gap: advance wall time to the first representable minute, rather than
  // preserving its offset within the skipped hour.
  let candidate = requested.add({ minutes: 1 });
  while (!Temporal.ZonedDateTime.from(fields(candidate), { disambiguation: "earlier" }).toPlainDateTime().equals(candidate)) {
    candidate = candidate.add({ minutes: 1 });
  }
  return Temporal.ZonedDateTime.from(fields(candidate), { disambiguation: "earlier" }).toInstant().toString();
}

export function windowInstants(
  localDate: string,
  spec: WindowTimesSpec,
  timeZone: string,
): { startsAt: string; endsAt: string } {
  const startDate = Temporal.PlainDate.from(localDate);
  const endDate = startDate.add({ days: windowEndDayOffset(spec) });
  return {
    startsAt: wallClockInstant(startDate, spec.window_start_time, timeZone),
    endsAt: wallClockInstant(endDate, spec.window_end_time, timeZone),
  };
}

export function localHorizon(now: Temporal.Instant, timeZone: string): { start: string; endExclusive: string } {
  const today = now.toZonedDateTimeISO(timeZone).toPlainDate();
  return { start: today.toString(), endExclusive: today.add({ days: 7 }).toString() };
}
