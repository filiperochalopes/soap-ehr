import { Form, Link, redirect, useLoaderData, useSubmit } from "react-router";
import type { Prisma } from "@prisma/client";

import { requireUserSession } from "~/lib/auth.server";
import { writeAuditLog } from "~/lib/audit.server";
import { prisma } from "~/lib/prisma.server";
import { getPatientPersonalDataPrivacy, getUiTimeZone } from "~/lib/settings.server";
import {
  formatDateTime,
  getDayRangeForTimeZone,
  getTodayDateInputValue,
} from "~/lib/utils";

const appointmentStatuses = [
  "proposed",
  "pending",
  "booked",
  "arrived",
  "fulfilled",
  "cancelled",
  "noshow",
  "entered-in-error",
  "checked-in",
  "waitlist",
] as const;

const appointmentStatusSet = new Set<string>(appointmentStatuses);

/** What the patient answered to the reminder message, as the reception reads it. */
const REMINDER_LABELS: Record<string, string> = {
  confirmed: "Confirmed",
  declined: "Declined (cancelled)",
  no_response: "No response",
  pending: "Not answered",
};

function parseAppointmentId(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function loader({ request }: { request: Request }) {
  await requireUserSession(request);

  const url = new URL(request.url);
  const dateValue = url.searchParams.get("date");
  const [patientPersonalDataPrivacy, timeZone] = await Promise.all([
    getPatientPersonalDataPrivacy(request),
    getUiTimeZone(),
  ]);
  const selectedDate = dateValue ?? getTodayDateInputValue(timeZone);
  const dayRange = getDayRangeForTimeZone(selectedDate, timeZone);

  const appointments = await prisma.appointment.findMany({
    where: {
      start: {
        gte: dayRange.start,
        lte: dayRange.end,
      },
    },
    include: {
      patient: true,
    },
    orderBy: {
      start: "asc",
    },
  });

  return {
    appointments,
    blurPatientPersonalData: patientPersonalDataPrivacy.shouldBlur,
    date: selectedDate,
    timeZone,
  };
}

export async function action({ request }: { request: Request }) {
  const auth = await requireUserSession(request);
  const formData = await request.formData();
  const appointmentId = parseAppointmentId(formData.get("appointmentId"));
  const status = String(formData.get("status") ?? "");
  const date = String(formData.get("date") ?? "");

  if (!appointmentId) {
    throw new Response("Appointment id is required.", { status: 400 });
  }

  if (!appointmentStatusSet.has(status)) {
    throw new Response("Appointment status is invalid.", { status: 400 });
  }

  await prisma.$transaction(async (tx) => {
    const appointment = await tx.appointment.findUnique({
      where: { id: appointmentId },
      select: {
        appointmentType: true,
        end: true,
        id: true,
        patientId: true,
        start: true,
        status: true,
      },
    });

    if (!appointment) {
      throw new Response("Appointment not found.", { status: 404 });
    }

    if (appointment.status === status) {
      return;
    }

    await tx.appointment.update({
      where: { id: appointment.id },
      data: {
        status,
      },
    });

    await writeAuditLog(tx, {
      action: "appointment.status.updated",
      category: "appointment",
      entityId: String(appointment.id),
      entityType: "Appointment",
      metadata: {
        appointmentType: appointment.appointmentType,
        end: appointment.end.toISOString(),
        fromStatus: appointment.status,
        patientId: appointment.patientId,
        start: appointment.start.toISOString(),
        status,
      } satisfies Prisma.JsonObject,
      userId: auth.user.id,
    });
  });

  throw redirect(date ? `/agenda?date=${encodeURIComponent(date)}` : "/agenda");
}

export default function AgendaRoute() {
  const { appointments, blurPatientPersonalData, date, timeZone } = useLoaderData<typeof loader>();
  const submit = useSubmit();
  const sensitiveClassName = blurPatientPersonalData ? "privacy-blur" : undefined;

  return (
    <div className="space-y-6">
      <section className="panel p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[color:var(--muted)]">
              Daily agenda
            </p>
            <h2 className="mt-2 text-3xl font-semibold">Appointments</h2>
          </div>
          <Form className="flex flex-wrap items-end gap-3" method="get">
            <label className="block">
              <span className="field-label">Date</span>
              <input
                defaultValue={date}
                name="date"
                type="date"
                onChange={(event) => {
                  if (event.currentTarget.form) {
                    submit(event.currentTarget.form);
                  }
                }}
              />
            </label>
            <button className="button-secondary" type="submit">
              Load day
            </button>
          </Form>
        </div>
      </section>

      <section className="panel overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full text-left text-sm">
            <thead className="bg-black/5 text-xs uppercase tracking-[0.22em] text-[color:var(--muted)] dark:bg-white/5">
              <tr>
                <th className="px-5 py-4">Patient</th>
                <th className="px-5 py-4">Start</th>
                <th className="px-5 py-4">End</th>
                <th className="px-5 py-4">Status</th>
                <th className="px-5 py-4">Type</th>
                <th className="px-5 py-4">Reminder</th>
                <th aria-label="Actions" className="px-5 py-4" />
              </tr>
            </thead>
            <tbody>
              {appointments.length ? (
                appointments.map((appointment) => (
                  <tr
                    className="border-t border-black/5 dark:border-white/10"
                    key={appointment.id}
                  >
                    <td className="px-5 py-4 font-medium">
                      <span className={sensitiveClassName}>{appointment.patient.name}</span>
                    </td>
                    <td className="px-5 py-4">
                      {formatDateTime(appointment.start, { timeZone })}
                    </td>
                    <td className="px-5 py-4">
                      {formatDateTime(appointment.end, { timeZone })}
                    </td>
                    <td className="px-5 py-4">
                      <Form method="post">
                        <input name="appointmentId" type="hidden" value={appointment.id} />
                        <input name="date" type="hidden" value={date} />
                        <select
                          aria-label={`Status for ${appointment.patient.name}`}
                          className="min-w-36 uppercase"
                          name="status"
                          defaultValue={appointment.status}
                          onChange={(event) => {
                            if (event.currentTarget.form) {
                              submit(event.currentTarget.form);
                            }
                          }}
                        >
                          {appointmentStatuses.map((status) => (
                            <option key={status} value={status}>
                              {status}
                            </option>
                          ))}
                        </select>
                      </Form>
                    </td>
                    <td className="px-5 py-4">{appointment.appointmentType}</td>
                    <td className="px-5 py-4">
                      {REMINDER_LABELS[appointment.confirmationStatus] ?? appointment.confirmationStatus}
                    </td>
                    <td className="px-5 py-4 text-right">
                      <Link
                        className="button-primary whitespace-nowrap"
                        to={`/patients/${appointment.patientId}/soap?appointmentId=${appointment.id}`}
                      >
                        Attend
                      </Link>
                    </td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td className="px-5 py-6 text-[color:var(--muted)]" colSpan={6}>
                    No appointments registered for this date.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
