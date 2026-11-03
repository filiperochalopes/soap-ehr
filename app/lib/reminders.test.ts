import assert from "node:assert/strict";
import test from "node:test";

// The modules below read and validate process.env at import time.
process.env.DATABASE_URL ??= "postgresql://clinic:***@localhost:5432/soap_ehr";
process.env.API_DRY_RUN = "true";

const { buildReminderFeed, normalizeBrazilianMobile, parseReminderDate, ReminderInputError } =
  await import("./reminders");
const { getReminderFeed } = await import("./reminders.server");
const { getFhirStore } = await import("./fhir/store.server");

const TZ = "America/Sao_Paulo";

// ---------- phone normalisation ----------

test("normalizes Brazilian mobile numbers to digits with the country code", () => {
  for (const raw of [
    "(71) 99999-1234",
    "+55 71 99999-1234",
    "71999991234",
    "5571999991234",
    "071 99999 1234",
    "+55 (71) 9 9999-1234",
  ]) {
    assert.equal(normalizeBrazilianMobile(raw), "5571999991234", raw);
  }
});

test("rejects landlines, incomplete numbers and garbage instead of guessing", () => {
  for (const raw of ["7133334444", "999991234", "(71) 9999-1234", "", "   ", "abc", "55", "+1 415 555 2671", "0800 123 4567"]) {
    assert.equal(normalizeBrazilianMobile(raw), null, JSON.stringify(raw));
  }
  assert.equal(normalizeBrazilianMobile(undefined), null);
  assert.equal(normalizeBrazilianMobile(42 as unknown as string), null);
});

// ---------- date parameter ----------

test("accepts only a real calendar day in YYYY-MM-DD", () => {
  assert.equal(parseReminderDate("2030-01-08"), "2030-01-08");
  for (const bad of ["", null, undefined, "2030-1-8", "08/01/2030", "2030-02-30", "2030-13-01", "2030-01-08T10:00", "tomorrow"]) {
    assert.throws(() => parseReminderDate(bad as string), ReminderInputError, String(bad));
  }
});

// ---------- feed shape and minimisation ----------

const CPF = "123.456.789-09";

function patient(id: string, overrides: Record<string, unknown> = {}) {
  return {
    resourceType: "Patient",
    id,
    active: true,
    identifier: [{ system: "urn:cpf", value: CPF }],
    name: [{ text: "Maria de Souza Lima" }],
    gender: "female",
    birthDate: "1984-05-17",
    telecom: [
      { system: "email", value: "maria@example.test" },
      { system: "phone", value: "(71) 99999-1234" },
    ],
    contact: [{ name: { text: "Joao Lima" }, relationship: [{ text: "spouse" }] }],
    ...overrides,
  };
}

function appointment(id: string, patientId: string, overrides: Record<string, unknown> = {}) {
  return {
    resourceType: "Appointment",
    id,
    status: "booked",
    start: "2030-01-08T11:00:00.000Z",
    end: "2030-01-08T12:00:00.000Z",
    appointmentType: { text: "routine" },
    participant: [{ actor: { reference: `Patient/${patientId}`, display: "Maria de Souza Lima" }, status: "accepted" }],
    ...overrides,
  };
}

test("exposes only what a reminder needs and nothing else about the patient", () => {
  const feed = buildReminderFeed({
    date: "2030-01-08",
    timeZone: TZ,
    appointments: [appointment("10", "7")],
    patients: [patient("7")],
  });

  assert.deepEqual(feed.appointments, [
    {
      id: "10",
      start: "2030-01-08T11:00:00.000Z",
      startLocal: "2030-01-08T08:00:00-03:00",
      end: "2030-01-08T12:00:00.000Z",
      status: "booked",
      type: "routine",
      confirmation: "pending",
      patient: { id: "7", firstName: "Maria", phone: "5571999991234" },
    },
  ]);
  const serialized = JSON.stringify(feed);
  for (const secret of [CPF, "1984", "maria@example.test", "Souza", "Lima", "Joao", "spouse", "urn:cpf", "female"]) {
    assert.ok(!serialized.includes(secret), `leaked ${secret}`);
  }
});

test("reads the confirmation state from the appointment and defaults to pending", () => {
  const confirmed = appointment("1", "7", {
    extension: [{ url: "https://soap-ehr.example/StructureDefinition/appointment-confirmation", valueCode: "confirmed" }],
  });
  const odd = appointment("2", "7", {
    extension: [{ url: "https://soap-ehr.example/StructureDefinition/appointment-confirmation", valueCode: "banana" }],
  });

  const feed = buildReminderFeed({
    date: "2030-01-08",
    timeZone: TZ,
    appointments: [confirmed, odd, appointment("3", "7")],
    patients: [patient("7")],
  });

  assert.deepEqual(feed.appointments.map((a) => [a.id, a.confirmation]), [
    ["1", "confirmed"],
    ["2", "pending"],
    ["3", "pending"],
  ]);
});

test("booked and pending appointments are eligible and the rest are counted, not listed", () => {
  const feed = buildReminderFeed({
    date: "2030-01-08",
    timeZone: TZ,
    appointments: [
      appointment("1", "7"),
      appointment("2", "7", { status: "cancelled" }),
      appointment("3", "7", { status: "noshow" }),
      appointment("4", "7", { status: "pending" }),
      appointment("5", "7", { status: "entered-in-error" }),
      appointment("6", "7", { status: "proposed" }),
      appointment("7", "7", { status: "fulfilled" }),
    ],
    patients: [patient("7")],
  });

  // "pending" is how the reception marks a scheduled appointment, so it is reminded too.
  assert.deepEqual(feed.appointments.map((a) => a.id), ["1", "4"]);
  assert.deepEqual(feed.appointments.map((a) => a.status), ["booked", "pending"], "the real status is reported");
  assert.deepEqual(feed.skipped, { notBooked: 5, noPhone: 0 });
});

test("patients without a usable mobile number are counted, never listed", () => {
  const feed = buildReminderFeed({
    date: "2030-01-08",
    timeZone: TZ,
    appointments: [appointment("1", "7"), appointment("2", "8"), appointment("3", "9"), appointment("4", "404")],
    patients: [
      patient("7"),
      patient("8", { telecom: [{ system: "phone", value: "7133334444" }] }),
      patient("9", { telecom: [] }),
    ],
  });

  assert.deepEqual(feed.appointments.map((a) => a.id), ["1"]);
  assert.deepEqual(feed.skipped, { notBooked: 0, noPhone: 3 });
});

test("takes the first valid mobile among several contact points, in stored order", () => {
  const feed = buildReminderFeed({
    date: "2030-01-08",
    timeZone: TZ,
    appointments: [appointment("1", "7")],
    patients: [
      patient("7", {
        telecom: [
          { system: "phone", value: "7133334444" },
          { system: "sms", value: "(71) 98888-7777" },
          { system: "phone", value: "(71) 99999-1234" },
        ],
      }),
    ],
  });

  assert.equal(feed.appointments[0].patient.phone, "5571988887777");
});

test("sorts by start and keeps one entry per appointment even for the same patient", () => {
  const feed = buildReminderFeed({
    date: "2030-01-08",
    timeZone: TZ,
    appointments: [
      appointment("late", "7", { start: "2030-01-08T19:00:00.000Z", end: "2030-01-08T20:00:00.000Z" }),
      appointment("early", "7"),
    ],
    patients: [patient("7")],
  });

  assert.deepEqual(feed.appointments.map((a) => a.id), ["early", "late"]);
});

test("a first name is the first word of the stored name, trimmed", () => {
  const feed = buildReminderFeed({
    date: "2030-01-08",
    timeZone: TZ,
    appointments: [appointment("1", "7"), appointment("2", "8")],
    patients: [patient("7", { name: [{ text: "  ana  Clara Silva " }] }), patient("8", { name: [{ text: "Cher" }] })],
  });

  assert.deepEqual(feed.appointments.map((a) => a.patient.firstName), ["ana", "Cher"]);
});

// ---------- end to end over the dry-run store: time zone window ----------

async function savePatient(name: string, phone: string | null, cpf: string) {
  return getFhirStore().savePatient(
    {
      resourceType: "Patient",
      active: true,
      identifier: [{ system: "urn:test-reminders", value: cpf }],
      name: [{ text: name }],
      gender: "unknown",
      birthDate: "1990-02-03",
      ...(phone ? { telecom: [{ system: "phone", value: phone }] } : {}),
    },
    1,
  );
}

async function saveAppointment(patientId: string, start: string, end: string, status = "booked") {
  return getFhirStore().saveAppointment(
    {
      resourceType: "Appointment",
      status,
      start,
      end,
      appointmentType: { text: "routine" },
      participant: [{ actor: { reference: `Patient/${patientId}` }, status: "accepted" }],
    },
    1,
  );
}

test("the day is the clinic's local day, whatever the server time zone is", async () => {
  const reachable = await savePatient("Paciente Alcancavel", "(71) 99999-1234", "reminders-1");
  const unreachable = await savePatient("Paciente Sem Telefone", null, "reminders-2");

  const first = await saveAppointment(reachable.id, "2030-01-08T03:00:00.000Z", "2030-01-08T03:30:00.000Z"); // 00:00 local: in
  const last = await saveAppointment(reachable.id, "2030-01-09T02:59:59.000Z", "2030-01-09T03:20:00.000Z"); // 23:59:59 local: in
  const tomorrow = await saveAppointment(reachable.id, "2030-01-09T03:00:00.000Z", "2030-01-09T03:30:00.000Z"); // 00:00 next day: out
  const yesterday = await saveAppointment(reachable.id, "2030-01-08T02:59:59.000Z", "2030-01-08T03:10:00.000Z"); // 23:59:59 previous day: out
  const cancelled = await saveAppointment(reachable.id, "2030-01-08T14:00:00.000Z", "2030-01-08T15:00:00.000Z", "cancelled");
  const noPhone = await saveAppointment(unreachable.id, "2030-01-08T15:00:00.000Z", "2030-01-08T16:00:00.000Z");

  try {
    const feed = await getReminderFeed({ date: "2030-01-08", timeZone: TZ });

    assert.equal(feed.timeZone, TZ);
    assert.deepEqual(feed.appointments.map((a) => a.id), [first.id, last.id]);
    assert.equal(feed.appointments[0].startLocal, "2030-01-08T00:00:00-03:00");
    assert.equal(feed.appointments[1].startLocal, "2030-01-08T23:59:59-03:00");
    assert.deepEqual(feed.skipped, { notBooked: 1, noPhone: 1 });
    assert.ok(!JSON.stringify(feed).includes("Alcancavel"), "surname-like parts of the name must not leak");
  } finally {
    for (const id of [first.id, last.id, tomorrow.id, yesterday.id, cancelled.id, noPhone.id]) {
      await getFhirStore().deleteAppointment(id);
    }
    await getFhirStore().deletePatient(reachable.id);
    await getFhirStore().deletePatient(unreachable.id);
  }
});

test("another clinic time zone moves the window", async () => {
  const person = await savePatient("Paciente Tokyo", "(71) 99999-1234", "reminders-3");
  const inTokyo = await saveAppointment(person.id, "2030-01-07T15:00:00.000Z", "2030-01-07T15:30:00.000Z"); // 00:00 Jan 8 in Tokyo

  try {
    const tokyo = await getReminderFeed({ date: "2030-01-08", timeZone: "Asia/Tokyo" });
    const saoPaulo = await getReminderFeed({ date: "2030-01-08", timeZone: TZ });

    assert.deepEqual(tokyo.appointments.map((a) => a.id), [inTokyo.id]);
    assert.deepEqual(saoPaulo.appointments.map((a) => a.id), []);
  } finally {
    await getFhirStore().deleteAppointment(inTokyo.id);
    await getFhirStore().deletePatient(person.id);
  }
});

test("a bad date is rejected before touching the store", async () => {
  await assert.rejects(getReminderFeed({ date: "2030-02-30", timeZone: TZ }), ReminderInputError);
});

test("appointments of patients deactivated after booking are not listed", async () => {
  const person = await savePatient("Paciente Inativado", "(71) 99999-1234", "reminders-inactive");
  const booked = await saveAppointment(person.id, "2030-01-08T13:00:00.000Z", "2030-01-08T13:30:00.000Z");

  try {
    const before = await getReminderFeed({ date: "2030-01-08", timeZone: TZ });
    assert.deepEqual(before.appointments.map((a) => a.id), [booked.id], "listed while active");

    await getFhirStore().savePatient({ ...person, active: false }, 1, person.id);

    const after = await getReminderFeed({ date: "2030-01-08", timeZone: TZ });
    assert.deepEqual(after.appointments, []);
  } finally {
    await getFhirStore().deleteAppointment(booked.id);
    await getFhirStore().deletePatient(person.id);
  }
});
