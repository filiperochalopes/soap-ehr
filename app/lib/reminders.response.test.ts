import assert from "node:assert/strict";
import test from "node:test";

// The modules below read and validate process.env at import time.
process.env.DATABASE_URL ??= "postgresql://clinic:***@localhost:5432/soap_ehr";
process.env.API_DRY_RUN = "true";

const { handleReminderResponseRequest, getReminderFeed } = await import("./reminders.server");
const { getFhirStore, AppointmentNotFoundError, ConfirmationConflictError } = await import("./fhir/store.server");

const TZ = "America/Sao_Paulo";

async function seed(status = "booked") {
  const person = await getFhirStore().savePatient(
    {
      resourceType: "Patient",
      active: true,
      identifier: [{ system: "urn:test-response", value: `response-${Math.random()}` }],
      name: [{ text: "Clara Mendes Rocha" }],
      gender: "unknown",
      telecom: [{ system: "phone", value: "(71) 99999-1234" }],
    },
    1,
  );
  const appointment = await getFhirStore().saveAppointment(
    {
      resourceType: "Appointment",
      status,
      start: "2030-01-08T11:00:00.000Z",
      end: "2030-01-08T12:00:00.000Z",
      appointmentType: { text: "routine" },
      participant: [{ actor: { reference: `Patient/${person.id}` }, status: "accepted" }],
    },
    1,
  );
  return {
    id: appointment.id,
    clean: async () => {
      await getFhirStore().deleteAppointment(appointment.id);
      await getFhirStore().deletePatient(person.id);
    },
  };
}

const feedFor = () => getReminderFeed({ date: "2030-01-08", timeZone: TZ });

// ---------- store: recording a response ----------

test("confirming marks the appointment and the feed shows it", async () => {
  const row = await seed();
  try {
    assert.equal((await feedFor()).appointments[0].confirmation, "pending");

    const result = await getFhirStore().recordAppointmentResponse(row.id, "confirmed", 1);

    assert.deepEqual(result, { appointmentId: row.id, outcome: "applied", status: "booked", confirmationStatus: "confirmed" });
    assert.equal((await feedFor()).appointments[0].confirmation, "confirmed");
  } finally {
    await row.clean();
  }
});

test("declining cancels the appointment, so it leaves the reminder feed", async () => {
  const row = await seed();
  try {
    const result = await getFhirStore().recordAppointmentResponse(row.id, "declined", 1);

    assert.deepEqual(result, { appointmentId: row.id, outcome: "applied", status: "cancelled", confirmationStatus: "declined" });
    const feed = await feedFor();
    assert.deepEqual(feed.appointments, []);
    assert.deepEqual(feed.skipped, { notBooked: 1, noPhone: 0 });
    assert.equal((await getFhirStore().getAppointment(row.id))?.status, "cancelled");
  } finally {
    await row.clean();
  }
});

test("recording the same response twice is idempotent", async () => {
  const row = await seed();
  try {
    await getFhirStore().recordAppointmentResponse(row.id, "declined", 1);
    const again = await getFhirStore().recordAppointmentResponse(row.id, "declined", 1);

    assert.equal(again.outcome, "noop");
    assert.equal(again.status, "cancelled");
  } finally {
    await row.clean();
  }
});

test("silence is recorded without cancelling and never overrides a confirmation", async () => {
  const row = await seed();
  try {
    const silent = await getFhirStore().recordAppointmentResponse(row.id, "no_response", 1);
    assert.deepEqual([silent.outcome, silent.status, silent.confirmationStatus], ["applied", "booked", "no_response"]);

    await getFhirStore().recordAppointmentResponse(row.id, "confirmed", 1);
    const late = await getFhirStore().recordAppointmentResponse(row.id, "no_response", 1);
    assert.deepEqual([late.outcome, late.confirmationStatus], ["noop", "confirmed"]);
  } finally {
    await row.clean();
  }
});

test("a patient who declined cannot re-confirm: that is a conflict for a human", async () => {
  const row = await seed();
  try {
    await getFhirStore().recordAppointmentResponse(row.id, "declined", 1);

    await assert.rejects(
      getFhirStore().recordAppointmentResponse(row.id, "confirmed", 1),
      (error) => error instanceof ConfirmationConflictError && error.reason === "already_cancelled",
    );
  } finally {
    await row.clean();
  }
});

test("a pending appointment can be declined and is then cancelled", async () => {
  const row = await seed("pending");
  try {
    const result = await getFhirStore().recordAppointmentResponse(row.id, "declined", 1);

    assert.deepEqual(result, { appointmentId: row.id, outcome: "applied", status: "cancelled", confirmationStatus: "declined" });
    assert.equal((await getFhirStore().getAppointment(row.id))?.status, "cancelled");
  } finally {
    await row.clean();
  }
});

test("only active appointments take a response, and unknown ones are not found", async () => {
  const row = await seed("fulfilled");
  try {
    await assert.rejects(
      getFhirStore().recordAppointmentResponse(row.id, "confirmed", 1),
      (error) => error instanceof ConfirmationConflictError && error.reason === "not_booked",
    );
    await assert.rejects(getFhirStore().recordAppointmentResponse("999999", "confirmed", 1), AppointmentNotFoundError);
    await assert.rejects(getFhirStore().recordAppointmentResponse("abc", "confirmed", 1), AppointmentNotFoundError);
  } finally {
    await row.clean();
  }
});

// ---------- HTTP handler ----------

function post(id: string, body: unknown, method = "POST") {
  return new Request(`http://ehr.test/api/reminders/appointments/${id}/response`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const allow = { authenticate: async () => ({ user: { id: 7 } }) };

test("the handler answers 200 with the outcome and nothing about the patient", async () => {
  const row = await seed();
  try {
    const response = await handleReminderResponseRequest(post(row.id, { response: "confirmed" }), row.id, allow);

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await response.json(), { appointmentId: row.id, outcome: "applied", status: "booked", confirmationStatus: "confirmed" });
  } finally {
    await row.clean();
  }
});

test("the handler maps bad input, unknown ids and conflicts to stable errors", async () => {
  const row = await seed();
  try {
    for (const body of ["{nope", "", "[]", "null", { response: "yes" }, { response: 1 }, {}]) {
      const bad = await handleReminderResponseRequest(post(row.id, body), row.id, allow);
      assert.equal(bad.status, 400, JSON.stringify(body));
      assert.equal((await bad.json()).error, "invalid_request");
    }

    const missing = await handleReminderResponseRequest(post("999999", { response: "confirmed" }), "999999", allow);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, "not_found");

    await handleReminderResponseRequest(post(row.id, { response: "declined" }), row.id, allow);
    const conflict = await handleReminderResponseRequest(post(row.id, { response: "confirmed" }), row.id, allow);
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: "conflict", reason: "already_cancelled" });
  } finally {
    await row.clean();
  }
});

test("only POST is served and an unauthenticated call changes nothing", async () => {
  const row = await seed();
  try {
    const get = await handleReminderResponseRequest(post(row.id, { response: "declined" }, "PUT"), row.id, allow);
    assert.equal(get.status, 405);
    assert.equal(get.headers.get("Allow"), "POST");

    await assert.rejects(
      handleReminderResponseRequest(post(row.id, { response: "declined" }), row.id, {
        authenticate: async () => {
          throw new Response("nope", { status: 401 });
        },
      }),
      (thrown) => thrown instanceof Response && thrown.status === 401,
    );
    assert.equal((await getFhirStore().getAppointment(row.id))?.status, "booked", "an unauthenticated call must not write");
  } finally {
    await row.clean();
  }
});

test("an oversized body is refused before it is parsed", async () => {
  const row = await seed();
  try {
    const huge = JSON.stringify({ response: "confirmed", pad: "x".repeat(20_000) });

    const response = await handleReminderResponseRequest(post(row.id, huge), row.id, allow);

    assert.equal(response.status, 413);
  } finally {
    await row.clean();
  }
});
