import type { SupportedLanguage } from "@gadgets/workshop-shared/api";

export function formatNumber(
  value: number | bigint,
  language: SupportedLanguage,
  options?: Intl.NumberFormatOptions,
): string {
  return new Intl.NumberFormat(language, options).format(value);
}

export function formatDate(
  value: Date | number,
  language: SupportedLanguage,
  options?: Intl.DateTimeFormatOptions,
): string {
  return new Intl.DateTimeFormat(language, options).format(value);
}

export function formatRelativeTime(
  value: number,
  unit: Intl.RelativeTimeFormatUnit,
  language: SupportedLanguage,
  options?: Intl.RelativeTimeFormatOptions,
): string {
  return new Intl.RelativeTimeFormat(language, options).format(value, unit);
}
