import { Temporal } from "@js-temporal/polyfill";

type ExplicitTimeZoneOptions = Omit<Intl.DateTimeFormatOptions, "timeZone">;

export function formatInstant(
  value: string,
  locale: string,
  timeZone: string,
  options: ExplicitTimeZoneOptions,
): string {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(value));
}

export function formatCivilDate(
  value: string,
  locale: string,
  timeZone: string,
  options: ExplicitTimeZoneOptions,
): string {
  // A PlainDate has no instant to shift across a calendar boundary. The
  // explicit timeZone keeps every display formatter on the same required API.
  return Temporal.PlainDate.from(value).toLocaleString(locale, { ...options, timeZone });
}
