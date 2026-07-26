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
  _timeZone: string,
  options: ExplicitTimeZoneOptions,
): string {
  // `_timeZone` is intentionally accepted but unused to keep the civil-date
  // and instant formatter APIs uniform. UTC anchoring preserves civil fields.
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(
    new Date(`${value}T00:00:00Z`),
  );
}
