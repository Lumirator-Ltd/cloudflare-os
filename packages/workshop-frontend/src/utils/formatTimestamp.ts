const fullTimestampFormatters = new Map<string, Intl.DateTimeFormat>();

function localeKey(locale?: string): string {
  return locale || "default";
}

function getFullTimestampFormatter(locale?: string): Intl.DateTimeFormat {
  const key = localeKey(locale);
  let formatter = fullTimestampFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, {
      dateStyle: "short",
      timeStyle: "short",
    });
    fullTimestampFormatters.set(key, formatter);
  }
  return formatter;
}

export function formatFullTimestamp(date: Date, locale?: string): string {
  return getFullTimestampFormatter(locale).format(date);
}

export function formatWorkspaceDate(
  date: Date,
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(locale, options).format(date);
}
