/**
 * What a patient's answer to a reminder does to an appointment. Pure, no database.
 *
 * Responses: `confirmed`, `declined` ("não vou") and `no_response` (silence, recorded by the
 * reminder service). Declining cancels the appointment so the slot is visibly free and the
 * reception is told; silence does NOT cancel, because the patient may simply not have read
 * the message and still come. A patient who already declined cannot re-confirm by message:
 * the slot may have been given to someone else, so that case is a conflict for a human.
 */
export const PATIENT_RESPONSES = ["confirmed", "declined", "no_response"] as const;

export type PatientResponse = (typeof PATIENT_RESPONSES)[number];

export type ConfirmationStatus = "pending" | PatientResponse;

export class ConfirmationInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfirmationInputError";
  }
}

export function parsePatientResponse(value: unknown): PatientResponse {
  if (typeof value === "string" && (PATIENT_RESPONSES as readonly string[]).includes(value)) {
    return value as PatientResponse;
  }

  throw new ConfirmationInputError(`response must be one of: ${PATIENT_RESPONSES.join(", ")}.`);
}

/**
 * Statuses of an appointment that is still scheduled. In this clinic the reception marks a
 * scheduled appointment as "pending" (161 pending, 82 fulfilled, 45 cancelled, 3 noshow in
 * production and never "booked"); the assistant writes "booked". Both are active.
 */
export const ACTIVE_APPOINTMENT_STATUSES = ["booked", "pending"] as const;
export type ActiveAppointmentStatus = (typeof ACTIVE_APPOINTMENT_STATUSES)[number];

export function isActiveAppointmentStatus(status: string): status is ActiveAppointmentStatus {
  return (ACTIVE_APPOINTMENT_STATUSES as readonly string[]).includes(status);
}

export type ConfirmationDecision =
  | { kind: "noop" }
  | {
      kind: "apply";
      confirmationStatus: PatientResponse;
      appointmentStatus?: "cancelled";
    }
  | { kind: "conflict"; reason: "already_cancelled" | "not_booked" };

export function decideConfirmation(
  current: { confirmationStatus: string; status: string },
  response: PatientResponse,
): ConfirmationDecision {
  const alreadyDeclined = current.status === "cancelled" && current.confirmationStatus === "declined";

  if (alreadyDeclined) {
    if (response === "confirmed") {
      return { kind: "conflict", reason: "already_cancelled" };
    }

    return { kind: "noop" };
  }

  if (!isActiveAppointmentStatus(current.status)) {
    // A late "silence" mark on something already closed is harmless; a real answer is not.
    return response === "no_response" ? { kind: "noop" } : { kind: "conflict", reason: "not_booked" };
  }

  switch (response) {
    case "confirmed":
      return current.confirmationStatus === "confirmed"
        ? { kind: "noop" }
        : { kind: "apply", confirmationStatus: "confirmed" };
    case "declined":
      return { kind: "apply", confirmationStatus: "declined", appointmentStatus: "cancelled" };
    case "no_response":
      return current.confirmationStatus === "pending"
        ? { kind: "apply", confirmationStatus: "no_response" }
        : { kind: "noop" };
  }
}
