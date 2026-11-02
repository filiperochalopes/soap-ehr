/**
 * Reminder feed: the minimum an outbound "your appointment is tomorrow" message needs.
 *
 * Pure functions, no database and no server imports, so the minimisation rules are testable
 * on their own. The feed is built from FHIR resources but deliberately exposes none of their
 * structure: only the appointment id and time, the patient's FIRST name and one normalised
 * mobile number. CPF, birth date, e-mail, surname, contacts and every other field never
 * leave this module, so a client holding the feed cannot read them by accident.
 */
import { getDayRangeForTimeZone } from "~/lib/utils";

export class ReminderInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReminderInputError";
  }
}

type Resource = Record<string, unknown>;

export type ReminderAppointment = {
  id: string;
  start: string;
  startLocal: string;
  end: string;
  status: "booked";
  type: string | null;
  patient: { id: string; firstName: string; phone: string };
};

export type ReminderFeed = {
  date: string;
  timeZone: string;
  appointments: ReminderAppointment[];
  /** Counts only. Never names, ids or numbers of the people left out. */
  skipped: { notBooked: number; noPhone: number };
};

/** Only a firm appointment gets a reminder; pending/proposed ones are not confirmed bookings. */
const ELIGIBLE_STATUS = "booked";

// Area codes in use in Brazil (ANATEL). Used to tell a real DDD from a stray prefix.
const BRAZILIAN_AREA_CODES = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38, 41, 42, 43,
  44, 45, 46, 47, 48, 49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68, 69, 71, 73, 74, 75, 77,
  79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 94, 95, 96, 97, 98, 99,
]);

/**
 * `55` + DDD + 9-digit mobile, digits only (the form WhatsApp addresses), or null.
 *
 * Strict on purpose: landlines, numbers without the area code, the pre-2016 8-digit mobiles
 * and anything foreign return null. A reminder to a guessed number reaches a stranger, and
 * the reception can fix the registration, so "skip and count" beats "try anyway".
 */
export function normalizeBrazilianMobile(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  let digits = value.replace(/\D/g, "").replace(/^0+/, "");
  // 55 is also the area code of Santa Maria (RS): only treat it as the country code when
  // the number is too long to be a national one.
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) {
    digits = digits.slice(2);
  }

  if (digits.length !== 11 || digits[2] !== "9") {
    return null;
  }
  if (!BRAZILIAN_AREA_CODES.has(Number(digits.slice(0, 2)))) {
    return null;
  }

  return `55${digits}`;
}

/** A real calendar day in YYYY-MM-DD; anything else is a client error. */
export function parseReminderDate(value: string | null | undefined): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ReminderInputError("date must be a day in YYYY-MM-DD format.");
  }

  const [year, month, day] = value.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    throw new ReminderInputError("date must be a real calendar day.");
  }

  return value;
}

/** The instants that bound a local day, inclusive, for the clinic's time zone. */
export function reminderDayRange(date: string, timeZone: string) {
  return getDayRangeForTimeZone(parseReminderDate(date), timeZone);
}

function pad(value: number, width = 2) {
  return String(value).padStart(width, "0");
}

/** ISO-8601 with the local offset, e.g. `2030-01-08T08:00:00-03:00`. */
function toLocalIso(instant: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      second: "2-digit",
      timeZone,
      year: "numeric",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  const localAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  const offsetMinutes = Math.round((localAsUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const absolute = Math.abs(offsetMinutes);

  return (
    `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}` +
    `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`
  );
}

function asRecord(value: unknown): Resource | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Resource) : null;
}

function patientIdOf(appointment: Resource): string | null {
  const participants = Array.isArray(appointment.participant) ? appointment.participant : [];
  for (const participant of participants) {
    const reference = asRecord(asRecord(participant)?.actor)?.reference;
    if (typeof reference === "string" && reference.startsWith("Patient/")) {
      return reference.slice("Patient/".length) || null;
    }
  }

  return null;
}

function firstNameOf(patient: Resource): string {
  const names = Array.isArray(patient.name) ? patient.name : [];
  const text = asRecord(names[0])?.text;

  return typeof text === "string" ? (text.trim().split(/\s+/)[0] ?? "") : "";
}

function mobileOf(patient: Resource): string | null {
  const telecom = Array.isArray(patient.telecom) ? patient.telecom : [];
  for (const point of telecom) {
    const record = asRecord(point);
    const system = typeof record?.system === "string" ? record.system.toLowerCase() : "";
    if (system !== "phone" && system !== "sms") {
      continue;
    }

    const phone = normalizeBrazilianMobile(record?.value);
    if (phone) {
      return phone;
    }
  }

  return null;
}

export function buildReminderFeed(input: {
  appointments: Resource[];
  date: string;
  patients: Resource[];
  timeZone: string;
}): ReminderFeed {
  const patients = new Map<string, Resource>();
  for (const patient of input.patients) {
    if (typeof patient.id === "string") {
      patients.set(patient.id, patient);
    }
  }

  const skipped = { notBooked: 0, noPhone: 0 };
  const eligible: Array<ReminderAppointment & { startMs: number }> = [];

  for (const appointment of input.appointments) {
    if (appointment.status !== ELIGIBLE_STATUS) {
      skipped.notBooked += 1;
      continue;
    }

    const patientId = patientIdOf(appointment);
    const patient = patientId ? patients.get(patientId) : undefined;
    const phone = patient ? mobileOf(patient) : null;
    const start = typeof appointment.start === "string" ? new Date(appointment.start) : null;
    const end = typeof appointment.end === "string" ? new Date(appointment.end) : null;

    if (!patientId || !patient || !phone || !start || !end || Number.isNaN(start.getTime())) {
      skipped.noPhone += 1;
      continue;
    }

    const type = asRecord(appointment.appointmentType)?.text;
    eligible.push({
      id: String(appointment.id),
      start: start.toISOString(),
      startLocal: toLocalIso(start, input.timeZone),
      end: end.toISOString(),
      status: ELIGIBLE_STATUS,
      type: typeof type === "string" ? type : null,
      patient: { id: patientId, firstName: firstNameOf(patient), phone },
      startMs: start.getTime(),
    });
  }

  eligible.sort((left, right) => left.startMs - right.startMs || left.id.localeCompare(right.id));

  return {
    date: input.date,
    timeZone: input.timeZone,
    appointments: eligible.map(({ startMs: _startMs, ...appointment }) => appointment),
    skipped,
  };
}
