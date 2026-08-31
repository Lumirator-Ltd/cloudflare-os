import type { SupportedLanguage } from "@gadgets/workshop-shared/theme";
import type { ManagementSchedule } from "../src/management-types";
import type { ScheduleCadence } from "../src/types";
import { translate } from "./i18n";

export type ScheduleTiming = {
  relative: string;
  absolute?: string;
  diagnostic?: string;
};

export function formatCadence(
  cadence: ScheduleCadence,
  language: SupportedLanguage = "en",
): string {
  if (cadence.kind === "interval") return formatInterval(cadence.everyMs, language);
  if (cadence.kind === "once") {
    const locale = localeFor(language);
    const date = new Intl.DateTimeFormat(locale, {
      timeZone: cadence.timeZone,
      year: "numeric",
      month: "short",
      day: "numeric",
    }).format(cadence.fireAt);
    const time = new Intl.DateTimeFormat(locale, {
      timeZone: cadence.timeZone,
      hour: "numeric",
      minute: "2-digit",
    }).format(cadence.fireAt);
    return translate(language, "cadence.once", { date, time });
  }

  const { rule } = cadence;
  if (rule.freq === "hourly") {
    const frequency = translate(
      language,
      rule.interval === 1 ? "cadence.hourly" : "cadence.everyHours",
      { count: rule.interval },
    );
    return translate(
      language,
      rule.interval === 1 ? "cadence.hourlyAt" : "cadence.everyHoursAt",
      { frequency, minute: rule.minute.toString().padStart(2, "0") },
    );
  }
  const time = formatClock(rule.hour, rule.minute, language);
  if (rule.freq === "daily") {
    return translate(
      language,
      rule.interval === 1 ? "cadence.dailyAt" : "cadence.everyDaysAt",
      { count: rule.interval, time },
    );
  }
  if (rule.interval === 1 && rule.byDay.join(",") === "MO,TU,WE,TH,FR") {
    return translate(language, "cadence.weekdaysAt", { time });
  }
  const days = new Intl.ListFormat(localeFor(language), {
    style: "short",
    type: "conjunction",
  }).format(rule.byDay.map((day) => translate(language, `weekdays.${day}`)));
  return translate(
    language,
    rule.interval === 1 ? "cadence.weeklyOnAt" : "cadence.everyWeeksOnAt",
    { count: rule.interval, days, time },
  );
}

/** Describes a finite recurrence bound and, for a counted bound, progress toward it. */
export function formatOccurrences(
  schedule: ManagementSchedule,
  language: SupportedLanguage = "en",
): string | undefined {
  const bound = schedule.occurrences;
  if (!bound) return undefined;
  if ("count" in bound) {
    return translate(language, "occurrences.progress", {
      count: bound.count,
      completed: schedule.occurrenceCount ?? 0,
      total: bound.count,
    });
  }
  return translate(language, "occurrences.until", {
    date: formatAbsolute(bound.until, scheduleTimeZone(schedule), language),
  });
}

export function formatTiming(
  schedule: ManagementSchedule,
  now = Date.now(),
  language: SupportedLanguage = "en",
): ScheduleTiming {
  const timestamp = scheduleTimestamp(schedule);
  if (timestamp === undefined) return { relative: translate(language, "timing.pending") };
  const absolute = formatAbsolute(timestamp, scheduleTimeZone(schedule), language);
  if (schedule.status === "active") {
    const relative = formatRelative(timestamp - now, language);
    return {
      relative: translate(language, schedule.retrying ? "timing.nextRetry" : "timing.next", {
        relative,
      }),
      absolute,
    };
  }
  if (schedule.status === "dead") {
    return {
      relative: translate(language, "timing.failed", {
        relative: formatRelative(schedule.failedAt - now, language),
      }),
      absolute,
      diagnostic: translate(
        language,
        schedule.failureCode === "authorization_failed"
          ? "diagnostics.authorizationFailed"
          : "diagnostics.callbackFailed",
      ),
    };
  }
  if (schedule.status === "completed") {
    return {
      relative: translate(language, "timing.completed", {
        relative: formatRelative(schedule.completedAt - now, language),
      }),
      absolute,
      diagnostic: translate(
        language,
        schedule.occurrences ? "diagnostics.recurringCompleted" : "diagnostics.onceCompleted",
      ),
    };
  }
  return {
    relative: translate(language, "timing.expired", {
      relative: formatRelative(schedule.expiredAt - now, language),
    }),
    absolute,
    diagnostic: translate(
      language,
      schedule.cadence.kind === "once"
        ? "diagnostics.onceExpired"
        : "diagnostics.recurringExpired",
    ),
  };
}

function formatInterval(milliseconds: number, language: SupportedLanguage): string {
  const units = [
    [7 * 24 * 60 * 60_000, "week"],
    [24 * 60 * 60_000, "day"],
    [60 * 60_000, "hour"],
    [60_000, "minute"],
    [1_000, "second"],
  ] as const;
  const [unitMs, unit] = units.find(([size]) => milliseconds % size === 0) ?? [1, "millisecond"];
  const count = milliseconds / unitMs;
  return translate(language, `interval.${unit}`, { count });
}

function formatClock(hour: number, minute: number, language: SupportedLanguage): string {
  return new Intl.DateTimeFormat(localeFor(language), {
    timeZone: "UTC",
    hour: "numeric",
    minute: "2-digit",
  }).format(Date.UTC(2020, 0, 1, hour, minute));
}

function formatRelative(milliseconds: number, language: SupportedLanguage): string {
  const absolute = Math.abs(milliseconds);
  const [size, unit] =
    absolute >= 24 * 60 * 60_000
      ? ([24 * 60 * 60_000, "day"] as const)
      : absolute >= 60 * 60_000
        ? ([60 * 60_000, "hour"] as const)
        : absolute >= 60_000
          ? ([60_000, "minute"] as const)
          : ([1_000, "second"] as const);
  const value = Math.round(milliseconds / size);
  return new Intl.RelativeTimeFormat(localeFor(language), { numeric: "always" }).format(
    value,
    unit,
  );
}

function formatAbsolute(
  timestamp: number,
  timeZone: string | undefined,
  language: SupportedLanguage,
): string {
  return new Intl.DateTimeFormat(localeFor(language), {
    timeZone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(timestamp);
}

function localeFor(language: SupportedLanguage): string {
  return language === "ja" ? "ja-JP" : "en-US";
}

function scheduleTimestamp(schedule: ManagementSchedule): number | undefined {
  if (schedule.status === "active") return schedule.nextFire;
  if (schedule.status === "dead") return schedule.failedAt;
  if (schedule.status === "completed") return schedule.completedAt;
  return schedule.expiredAt;
}

function scheduleTimeZone(schedule: ManagementSchedule): string | undefined {
  return schedule.cadence.kind === "interval" ? undefined : schedule.cadence.timeZone;
}
