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
  // Civil dates have no workspace offset to apply. UTC anchoring preserves
  // their calendar fields while the shared API still requires a timeZone.
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: "UTC" }).format(
    new Date(`${value}T00:00:00Z`),
  );
}
