import { getFhirStore, type FhirStore } from "~/lib/fhir/store.server";
import {
  ReminderInputError,
  buildReminderFeed,
  parseReminderDate,
  reminderDayRange,
  type ReminderFeed,
} from "~/lib/reminders";

/**
 * Appointments of one local day, reduced to what a reminder needs. Read-only. The day is
 * computed in the clinic's time zone, never the server's, so "tomorrow" is the same day the
 * reception sees on the agenda.
 */
export async function getReminderFeed(input: {
  date: string;
  store?: FhirStore;
  timeZone: string;
}): Promise<ReminderFeed> {
  const date = parseReminderDate(input.date);
  const { end, start } = reminderDayRange(date, input.timeZone);
  const { included, resources } = await (input.store ?? getFhirStore()).searchAppointmentsBetween({
    from: start,
    to: end,
  });

  return buildReminderFeed({
    appointments: resources,
    date,
    patients: included,
    timeZone: input.timeZone,
  });
}

export { ReminderInputError };

/** What the HTTP handler needs from the outside; the route wires the real ones. */
export type ReminderRequestDeps = {
  /** Counts only. The audit trail must never hold names or phone numbers. */
  audit: (entry: {
    count: number;
    date: string;
    skipped: ReminderFeed["skipped"];
    userId: number;
  }) => Promise<void>;
  /** Throws a Response (401) when the caller is not authenticated. */
  authenticate: (request: Request) => Promise<{ user: { id: number } }>;
  store?: FhirStore;
  timeZone: () => Promise<string>;
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

/**
 * GET /api/reminders/appointments?date=YYYY-MM-DD
 *
 * Order matters and is deliberate: refuse other methods first (no auth probing through a
 * route that does not exist for them), authenticate, validate the date, read, and only then
 * audit. The audit runs BEFORE the response is returned, and if it fails nothing is
 * returned: handing out contact data without a record of it is worse than a failed call.
 */
export async function handleReminderFeedRequest(
  request: Request,
  deps: ReminderRequestDeps,
): Promise<Response> {
  if (request.method !== "GET") {
    return json({ error: "method_not_allowed", message: "Use GET." }, 405, { Allow: "GET" });
  }

  const auth = await deps.authenticate(request);

  let date: string;
  try {
    date = parseReminderDate(new URL(request.url).searchParams.get("date"));
  } catch (error) {
    if (error instanceof ReminderInputError) {
      return json({ error: "invalid_date", message: error.message }, 400);
    }
    throw error;
  }

  const feed = await getReminderFeed({
    date,
    store: deps.store,
    timeZone: await deps.timeZone(),
  });

  await deps.audit({
    count: feed.appointments.length,
    date,
    skipped: feed.skipped,
    userId: auth.user.id,
  });

  return json(feed);
}
