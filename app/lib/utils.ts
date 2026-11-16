import clsx from "clsx";

export const DEFAULT_UI_TIME_ZONE = "America/Bahia";
const formatterCache = new Map<string, Intl.DateTimeFormat>();

export function cn(...values: Array<string | false | null | undefined>) {
  return clsx(values);
}

export function parseDateInput(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function padNumber(value: number) {
  return String(value).padStart(2, "0");
}

function getFormatter(
  key: string,
  create: () => Intl.DateTimeFormat,
) {
  const cached = formatterCache.get(key);
  if (cached) {
    return cached;
  }

  const formatter = create();
  formatterCache.set(key, formatter);
  return formatter;
}

function getDatePartsFormatter(timeZone: string) {
  return getFormatter(
    `date:${timeZone}`,
    () =>
      new Intl.DateTimeFormat("en-CA", {
        day: "2-digit",
        month: "2-digit",
        timeZone,
        year: "numeric",
      }),
  );
}

function getDateTimePartsFormatter(timeZone: string) {
  return getFormatter(
    `datetime:${timeZone}`,
    () =>
      new Intl.DateTimeFormat("en-CA", {
        day: "2-digit",
        hour: "2-digit",
        hour12: false,
        hourCycle: "h23",
        minute: "2-digit",
        month: "2-digit",
        second: "2-digit",
        timeZone,
        year: "numeric",
      }),
  );
}

function getPartsRecord(parts: Intl.DateTimeFormatPart[]) {
  return parts.reduce<Record<string, string>>((record, part) => {
    if (part.type !== "literal") {
      record[part.type] = part.value;
    }

    return record;
  }, {});
}

function getDatePartsInTimeZone(value: Date | string, timeZone: string) {
  const parts = getPartsRecord(getDatePartsFormatter(timeZone).formatToParts(new Date(value)));
  return {
    day: Number(parts.day),
    month: Number(parts.month),
    year: Number(parts.year),
  };
}

function getDateTimePartsInTimeZone(value: Date | string, timeZone: string) {
  const parts = getPartsRecord(
    getDateTimePartsFormatter(timeZone).formatToParts(new Date(value)),
  );

  return {
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    month: Number(parts.month),
    second: Number(parts.second),
    year: Number(parts.year),
  };
}

function getUtcDateParts(value: Date | string) {
  const date = new Date(value);

  return {
    day: date.getUTCDate(),
    month: date.getUTCMonth() + 1,
    year: date.getUTCFullYear(),
  };
}

function parseDateValue(value: string) {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) {
    return null;
  }

  return {
    day: Number(match[3]),
    month: Number(match[2]),
    year: Number(match[1]),
  };
}

function parseDateTimeValue(value: string) {
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) {
    return null;
  }

  return {
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    month: Number(match[2]),
    year: Number(match[1]),
  };
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatDateParts(parts: { day: number; month: number; year: number }) {
  return `${parts.year}-${padNumber(parts.month)}-${padNumber(parts.day)}`;
}

function formatCount(value: number, singular: string, plural: string) {
  return `${value} ${value === 1 ? singular : plural}`;
}

function compareDateParts(
  left: { day: number; month: number; year: number },
  right: { day: number; month: number; year: number },
) {
  if (left.year !== right.year) {
    return left.year - right.year;
  }

  if (left.month !== right.month) {
    return left.month - right.month;
  }

  return left.day - right.day;
}

function diffDateParts(
  start: { day: number; month: number; year: number },
  end: { day: number; month: number; year: number },
) {
  let years = end.year - start.year;
  let months = end.month - start.month;
  let days = end.day - start.day;

  if (days < 0) {
    months -= 1;
    const previousMonth = end.month === 1 ? 12 : end.month - 1;
    const previousMonthYear = end.month === 1 ? end.year - 1 : end.year;
    days += daysInMonth(previousMonthYear, previousMonth);
  }

  if (months < 0) {
    years -= 1;
    months += 12;
  }

  return { days, months, years };
}

export function isValidTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("pt-BR", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function normalizeTimeZone(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed && isValidTimeZone(trimmed) ? trimmed : DEFAULT_UI_TIME_ZONE;
}

export function getTimeZoneOffsetMs(value: Date | string, timeZone: string) {
  const date = new Date(value);
  const zoned = getDateTimePartsInTimeZone(date, timeZone);
  const utcEquivalent = Date.UTC(
    zoned.year,
    zoned.month - 1,
    zoned.day,
    zoned.hour,
    zoned.minute,
    zoned.second,
  );
  const utcDate = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours(),
    date.getUTCMinutes(),
    date.getUTCSeconds(),
  );

  return utcEquivalent - utcDate;
}

export function parseDateTimeInput(value: string, timeZone = DEFAULT_UI_TIME_ZONE) {
  const parts = parseDateTimeValue(value);

  if (!parts) {
    return new Date(value);
  }

  const normalizedTimeZone = normalizeTimeZone(timeZone);
  const utcGuess = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  const initialOffset = getTimeZoneOffsetMs(new Date(utcGuess), normalizedTimeZone);
  let resolvedTimestamp = utcGuess - initialOffset;
  const refinedOffset = getTimeZoneOffsetMs(new Date(resolvedTimestamp), normalizedTimeZone);

  if (refinedOffset !== initialOffset) {
    resolvedTimestamp = utcGuess - refinedOffset;
  }

  return new Date(resolvedTimestamp);
}

export function formatDate(value: Date | string) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}

export function formatDateTime(
  value: Date | string,
  options?: { timeZone?: string },
) {
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: normalizeTimeZone(options?.timeZone),
  }).format(new Date(value));
}

export function startOfDay(value: Date) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

export function endOfDay(value: Date) {
  const date = new Date(value);
  date.setHours(23, 59, 59, 999);
  return date;
}

export function toDateInputValue(value: Date | string | null | undefined) {
  if (!value) {
    return "";
  }

  return new Date(value).toISOString().slice(0, 10);
}

export function toDateTimeLocalValue(
  value: Date | string,
  timeZone = DEFAULT_UI_TIME_ZONE,
) {
  const parts = getDateTimePartsInTimeZone(value, normalizeTimeZone(timeZone));

  return `${parts.year}-${padNumber(parts.month)}-${padNumber(parts.day)}T${padNumber(parts.hour)}:${padNumber(parts.minute)}`;
}

export function getTodayDateInputValue(timeZone = DEFAULT_UI_TIME_ZONE) {
  return formatDateParts(getDatePartsInTimeZone(new Date(), normalizeTimeZone(timeZone)));
}

export function getDayRangeForTimeZone(dateValue: string, timeZone = DEFAULT_UI_TIME_ZONE) {
  const parts = parseDateValue(dateValue);

  if (!parts) {
    throw new Error("Invalid date value");
  }

  const start = parseDateTimeInput(
    `${formatDateParts(parts)}T00:00`,
    normalizeTimeZone(timeZone),
  );
  const nextDay = new Date(Date.UTC(parts.year, parts.month - 1, parts.day));
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const nextDayParts = {
    day: nextDay.getUTCDate(),
    month: nextDay.getUTCMonth() + 1,
    year: nextDay.getUTCFullYear(),
  };
  const nextDayStart = parseDateTimeInput(
    `${formatDateParts(nextDayParts)}T00:00`,
    normalizeTimeZone(timeZone),
  );

  return {
    end: new Date(nextDayStart.getTime() - 1),
    start,
  };
}

export function formatTimeZoneOffsetLabel(
  timeZone: string,
  value: Date | string = new Date(),
) {
  const offsetMinutes = Math.round(getTimeZoneOffsetMs(value, normalizeTimeZone(timeZone)) / 60_000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteMinutes = Math.abs(offsetMinutes);
  const hours = Math.floor(absoluteMinutes / 60);
  const minutes = absoluteMinutes % 60;

  if (!minutes) {
    return `GMT${sign}${hours}`;
  }

  return `GMT${sign}${hours}:${padNumber(minutes)}`;
}

/** Completed years, months and days since birth; null without a birth date or when it is in the future. */
export function getPatientAgeParts(
  birthDate: Date | string | null | undefined,
  options?: { now?: Date | string; timeZone?: string },
) {
  if (!birthDate) {
    return null;
  }

  const normalizedTimeZone = normalizeTimeZone(options?.timeZone);
  const birth = getUtcDateParts(birthDate);
  const today = getDatePartsInTimeZone(options?.now ?? new Date(), normalizedTimeZone);

  if (compareDateParts(today, birth) < 0) {
    return null;
  }

  return diffDateParts(birth, today);
}

export function formatPatientAge(
  birthDate: Date | string | null | undefined,
  options?: { now?: Date | string; timeZone?: string },
) {
  const age = getPatientAgeParts(birthDate, options);

  if (!age) {
    return null;
  }

  if (age.years > 5) {
    return formatCount(age.years, "ano", "anos");
  }

  if (age.years >= 1) {
    return `${formatCount(age.years, "ano", "anos")} e ${formatCount(age.months, "mês", "meses")}`;
  }

  return `${formatCount(age.months, "mês", "meses")} e ${formatCount(age.days, "dia", "dias")}`;
}

export function pickFirstString(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value : "";
}

export function extractRepeatedPairs(
  formData: FormData,
  leftKey: string,
  rightKey: string,
) {
  const left = formData.getAll(leftKey).map((value) => String(value).trim());
  const right = formData.getAll(rightKey).map((value) => String(value).trim());

  return left
    .map((first, index) => ({
      first,
      second: right[index] ?? "",
    }))
    .filter((item) => item.first || item.second);
}

export function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function stripHtml(value: string) {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>\s*<p[^>]*>/gi, "\n\n")
    .replace(/<\/(div|li|ul|ol|section|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function toFhirNarrativeDiv(value: string) {
  const paragraphs = value
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map(
      (paragraph) =>
        `<p>${escapeHtml(paragraph).replace(/\n/g, "<br/>")}</p>`,
    )
    .join("");

  return `<div xmlns="http://www.w3.org/1999/xhtml">${paragraphs || "<p></p>"}</div>`;
}
