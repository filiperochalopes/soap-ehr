import assert from "node:assert/strict";
import test from "node:test";

// The modules below read and validate process.env at import time.
process.env.DATABASE_URL ??= "postgresql://clinic:***@localhost:5432/soap_ehr";
process.env.API_DRY_RUN = "true";

const { handleReminderFeedRequest } = await import("./reminders.server");
const { getFhirStore } = await import("./fhir/store.server");

const URL_BASE = "http://ehr.test/api/reminders/appointments";

type Audit = { count: number; date: string; skipped: { noPhone: number; notBooked: number }; userId: number };

function deps(overrides: Record<string, unknown> = {}) {
  const audits: Audit[] = [];
  let authenticated = 0;
  return {
    audits,
    authenticatedCount: () => authenticated,
    value: {
      authenticate: async () => {
        authenticated += 1;
        return { user: { id: 42 } };
      },
      audit: async (entry: Audit) => {
        audits.push(entry);
      },
      timeZone: async () => "America/Sao_Paulo",
      ...overrides,
    },
  };
}

function get(query: string, method = "GET") {
  return new Request(`${URL_BASE}${query}`, { method });
}

async function seed() {
  const person = await getFhirStore().savePatient(
    {
      resourceType: "Patient",
      active: true,
      identifier: [{ system: "urn:test-reminders-http", value: "reminders-http-1" }],
      name: [{ text: "Helena Prado Santos" }],
      gender: "unknown",
      telecom: [{ system: "phone", value: "(71) 99999-1234" }],
    },
    1,
  );
  const appointment = await getFhirStore().saveAppointment(
    {
      resourceType: "Appointment",
      status: "booked",
      start: "2030-01-08T11:00:00.000Z",
      end: "2030-01-08T12:00:00.000Z",
      appointmentType: { text: "routine" },
      participant: [{ actor: { reference: `Patient/${person.id}` }, status: "accepted" }],
    },
    1,
  );
  return {
    appointmentId: appointment.id,
    clean: async () => {
      await getFhirStore().deleteAppointment(appointment.id);
      await getFhirStore().deletePatient(person.id);
    },
  };
}

test("an unauthenticated request is refused before anything is read or audited", async () => {
  const d = deps({
    authenticate: async () => {
      throw new Response("nope", { status: 401 });
    },
  });

  await assert.rejects(handleReminderFeedRequest(get("?date=2030-01-08"), d.value), (thrown) => {
    assert.ok(thrown instanceof Response);
    assert.equal(thrown.status, 401);
    return true;
  });
  assert.deepEqual(d.audits, []);
});

test("a missing or impossible date is a 400 with a stable error code and no audit", async () => {
  for (const query of ["", "?date=", "?date=2030-02-30", "?date=08/01/2030", "?date=tomorrow"]) {
    const d = deps();

    const response = await handleReminderFeedRequest(get(query), d.value);

    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).error, "invalid_date");
    assert.deepEqual(d.audits, [], query);
  }
});

test("returns the feed as no-store JSON and audits the read with counts only", async () => {
  const row = await seed();
  const d = deps();

  try {
    const response = await handleReminderFeedRequest(get("?date=2030-01-08"), d.value);

    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Type") ?? "", /^application\/json/);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const body = await response.json();
    assert.equal(body.date, "2030-01-08");
    assert.equal(body.timeZone, "America/Sao_Paulo");
    assert.deepEqual(body.appointments.map((a: { id: string }) => a.id), [row.appointmentId]);
    assert.deepEqual(body.appointments[0].patient, {
      id: body.appointments[0].patient.id,
      firstName: "Helena",
      phone: "5571999991234",
    });

    assert.deepEqual(d.audits, [{ count: 1, date: "2030-01-08", skipped: { notBooked: 0, noPhone: 0 }, userId: 42 }]);
    const logged = JSON.stringify(d.audits);
    assert.ok(!logged.includes("5571999991234") && !logged.includes("Helena"), "the audit trail must not hold contact data");
  } finally {
    await row.clean();
  }
});

test("if the access cannot be audited, no contact data is returned", async () => {
  const row = await seed();
  const d = deps({
    audit: async () => {
      throw new Error("audit store down");
    },
  });

  try {
    await assert.rejects(handleReminderFeedRequest(get("?date=2030-01-08"), d.value), /audit store down/);
  } finally {
    await row.clean();
  }
});

test("only GET is served, and a refused method does not even authenticate", async () => {
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const d = deps();

    const response = await handleReminderFeedRequest(get("?date=2030-01-08", method), d.value);

    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("Allow"), "GET");
    assert.equal(d.authenticatedCount(), 0);
  }
});

test("the clinic time zone comes from the injected setting", async () => {
  const d = deps({ timeZone: async () => "Asia/Tokyo" });

  const response = await handleReminderFeedRequest(get("?date=2030-01-08"), d.value);

  assert.equal((await response.json()).timeZone, "Asia/Tokyo");
});
