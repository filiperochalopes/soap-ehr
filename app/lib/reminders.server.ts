import {
  ConfirmationInputError,
  parsePatientResponse,
  type PatientResponse,
} from "~/lib/appointment-confirmation";
import {
  AppointmentNotFoundError,
  ConfirmationConflictError,
  getFhirStore,
  type FhirStore,
} from "~/lib/fhir/store.server";
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

/** The body is a one-field JSON object; anything larger is not a legitimate client. */
const MAX_RESPONSE_BODY_BYTES = 4096;

export type ReminderResponseDeps = {
  /** Throws a Response (401) when the caller is not authenticated. */
  authenticate: (request: Request) => Promise<{ user: { id: number } }>;
  store?: FhirStore;
};

/**
 * POST /api/reminders/appointments/:id/response  body: {"response": "confirmed"|"declined"|"no_response"}
 *
 * Records what the patient answered to the reminder. Declining cancels the appointment, which
 * is how the reception sees the slot free on the agenda. Repeating the same answer is safe
 * (200, outcome "noop"); a patient who already declined cannot re-confirm (409), because the
 * slot may have been given away and a person has to decide. The reply carries no patient data.
 */
export async function handleReminderResponseRequest(
  request: Request,
  appointmentId: string,
  deps: ReminderResponseDeps,
): Promise<Response> {
  if (request.method !== "POST") {
    return json({ error: "method_not_allowed", message: "Use POST." }, 405, { Allow: "POST" });
  }

  const auth = await deps.authenticate(request);

  const declared = Number(request.headers.get("Content-Length") ?? "0");
  const raw = declared > MAX_RESPONSE_BODY_BYTES ? null : await request.text();
  if (raw === null || raw.length > MAX_RESPONSE_BODY_BYTES) {
    return json({ error: "payload_too_large", message: "Request body is too large." }, 413);
  }

  let response: PatientResponse;
  try {
    const body: unknown = JSON.parse(raw);
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new ConfirmationInputError("Body must be a JSON object.");
    }
    response = parsePatientResponse((body as Record<string, unknown>).response);
  } catch (error) {
    if (error instanceof ConfirmationInputError || error instanceof SyntaxError) {
      return json({ error: "invalid_request", message: error instanceof SyntaxError ? "Body is not valid JSON." : error.message }, 400);
    }
    throw error;
  }

  try {
    const result = await (deps.store ?? getFhirStore()).recordAppointmentResponse(
      appointmentId,
      response,
      auth.user.id,
    );
    return json(result);
  } catch (error) {
    if (error instanceof AppointmentNotFoundError) {
      return json({ error: "not_found", message: "Appointment not found." }, 404);
    }
    if (error instanceof ConfirmationConflictError) {
      return json({ error: "conflict", reason: error.reason }, 409);
    }
    throw error;
  }
}
