import { requireApiScope } from "~/lib/auth.server";
import { handleReminderResponseRequest } from "~/lib/reminders.server";

/**
 * POST /api/reminders/appointments/:appointmentId/response
 *
 * Records the patient's answer to a reminder ("confirmed", "declined", "no_response").
 * Declining cancels the appointment. Reachable with a `reminders`-scoped token; the rules live
 * in `handleReminderResponseRequest`, this file only wires the real authentication.
 */
const deps = { authenticate: (request: Request) => requireApiScope(request, "reminders") };

export async function loader({ request, params }: { params: { appointmentId?: string }; request: Request }) {
  return handleReminderResponseRequest(request, params.appointmentId ?? "", deps);
}

export async function action({ request, params }: { params: { appointmentId?: string }; request: Request }) {
  return handleReminderResponseRequest(request, params.appointmentId ?? "", deps);
}
