import assert from "node:assert/strict";
import test from "node:test";

/**
 * Integration test against a REAL PostgreSQL (the Prisma store). It only runs when
 * INTEGRATION_DATABASE_URL points at a disposable database that already has the migrations
 * applied, e.g.:
 *
 *   docker run -d --name ehr-test-db -e POSTGRES_USER=clinic -e POSTGRES_PASSWORD=clinic \
 *     -e POSTGRES_DB=soap_ehr_test -p 127.0.0.1:55432:5432 postgres:17-alpine
 *   DATABASE_URL=postgresql://clinic:clinic@localhost:55432/soap_ehr_test pnpm prisma migrate deploy
 *   INTEGRATION_DATABASE_URL=postgresql://clinic:clinic@localhost:55432/soap_ehr_test \
 *     node --import tsx --test app/lib/reminders.integration.test.ts
 *
 * It refuses any URL that is not localhost, and it cleans up the rows it creates.
 */
const url = process.env.INTEGRATION_DATABASE_URL;
const skip = url ? false : "INTEGRATION_DATABASE_URL is not set";

if (url) {
  assert.match(new URL(url).hostname, /^(localhost|127\.0\.0\.1)$/, "integration tests only run against localhost");
  process.env.DATABASE_URL = url;
  process.env.API_DRY_RUN = "false";
}

const TZ = "America/Sao_Paulo";
const TAG = `it-reminders-${process.pid}`;

async function load() {
  const { prisma } = await import("~/lib/prisma.server");
  const { getReminderFeed } = await import("./reminders.server");
  return { prisma, getReminderFeed };
}

async function makePatient(
  prisma: Awaited<ReturnType<typeof load>>["prisma"],
  name: string,
  overrides: { active?: boolean; phone?: string | null } = {},
) {
  return prisma.patient.create({
    data: {
      name,
      gender: "unknown",
      birthDate: new Date("1990-02-03"),
      active: overrides.active ?? true,
      identifier: { create: [{ system: `urn:${TAG}`, value: `cpf-${name}` }] },
      telecom: {
        create: [
          { system: "email", value: `${name}@example.test` },
          ...(overrides.phone === null ? [] : [{ system: "phone", value: overrides.phone ?? "(71) 99999-1234" }]),
        ],
      },
    },
  });
}

test("the Prisma store lists a local day, loads only what the feed needs and respects patient state", { skip }, async () => {
  const { prisma, getReminderFeed } = await load();
  const created: { appointments: number[]; patients: number[] } = { appointments: [], patients: [] };

  try {
    const reachable = await makePatient(prisma, "Marina Alves Costa");
    const noPhone = await makePatient(prisma, "Paulo Sem Telefone", { phone: null });
    const inactive = await makePatient(prisma, "Ines Inativa");
    created.patients.push(reachable.id, noPhone.id, inactive.id);

    const book = async (patientId: number, start: string, end: string, status = "booked") => {
      const row = await prisma.appointment.create({
        data: { patientId, start: new Date(start), end: new Date(end), status, appointmentType: "routine" },
      });
      created.appointments.push(row.id);
      return row;
    };

    const first = await book(reachable.id, "2030-01-08T03:00:00.000Z", "2030-01-08T03:30:00.000Z"); // 00:00 local: in
    const last = await book(reachable.id, "2030-01-09T02:59:59.000Z", "2030-01-09T03:20:00.000Z"); // 23:59:59 local: in
    await book(reachable.id, "2030-01-09T03:00:00.000Z", "2030-01-09T03:30:00.000Z"); // next day: out
    await book(reachable.id, "2030-01-08T02:59:59.000Z", "2030-01-08T03:10:00.000Z"); // previous day: out
    await book(reachable.id, "2030-01-08T14:00:00.000Z", "2030-01-08T15:00:00.000Z", "cancelled");
    await book(noPhone.id, "2030-01-08T15:00:00.000Z", "2030-01-08T16:00:00.000Z");
    await book(inactive.id, "2030-01-08T16:00:00.000Z", "2030-01-08T17:00:00.000Z");
    await prisma.patient.update({ where: { id: inactive.id }, data: { active: false } });

    const feed = await getReminderFeed({ date: "2030-01-08", timeZone: TZ });

    assert.deepEqual(feed.appointments.map((a) => a.id), [String(first.id), String(last.id)]);
    assert.equal(feed.appointments[0].startLocal, "2030-01-08T00:00:00-03:00");
    assert.deepEqual(feed.appointments[0].patient, {
      id: String(reachable.id),
      firstName: "Marina",
      phone: "5571999991234",
    });
    assert.deepEqual(feed.skipped, { notBooked: 1, noPhone: 1 });

    const serialized = JSON.stringify(feed);
    for (const secret of ["cpf-", "1990", "example.test", "Alves", "Costa", "urn:"]) {
      assert.ok(!serialized.includes(secret), `leaked ${secret}`);
    }
  } finally {
    await prisma.appointment.deleteMany({ where: { id: { in: created.appointments } } });
    await prisma.contactPoint.deleteMany({ where: { patientId: { in: created.patients } } });
    await prisma.identifier.deleteMany({ where: { patientId: { in: created.patients } } });
    await prisma.patient.deleteMany({ where: { id: { in: created.patients } } });
    await prisma.$disconnect();
  }
});

// ---------- recording a response, against the real Prisma store ----------

test("responses are recorded atomically, audited without personal data, and race-safe", { skip }, async () => {
  const { prisma, getReminderFeed } = await load();
  const { getFhirStore, ConfirmationConflictError } = await import("./fhir/store.server");
  const patient = await makePatient(prisma, "Rafaela Duarte Lima");
  const user = await prisma.authUser.create({ data: { fullName: "Teste Integracao", crm: "000", crmUf: "BA" } });
  const rows: number[] = [];
  const book = async (start: string) => {
    const row = await prisma.appointment.create({
      data: { patientId: patient.id, start: new Date(start), end: new Date(Date.parse(start) + 3_600_000), status: "booked", appointmentType: "routine" },
    });
    rows.push(row.id);
    return String(row.id);
  };

  try {
    const store = getFhirStore();

    // confirm -> shows in the feed, status stays booked
    const a = await book("2030-01-08T11:00:00.000Z");
    assert.deepEqual(await store.recordAppointmentResponse(a, "confirmed", user.id), {
      appointmentId: a, outcome: "applied", status: "booked", confirmationStatus: "confirmed",
    });
    assert.equal((await getReminderFeed({ date: "2030-01-08", timeZone: TZ })).appointments[0].confirmation, "confirmed");
    assert.equal((await store.recordAppointmentResponse(a, "confirmed", user.id)).outcome, "noop");

    // decline -> cancelled in the database, gone from the feed, re-confirm is a conflict
    const b = await book("2030-01-08T13:00:00.000Z");
    const declined = await store.recordAppointmentResponse(b, "declined", user.id);
    assert.deepEqual([declined.status, declined.confirmationStatus], ["cancelled", "declined"]);
    const stored = await prisma.appointment.findUniqueOrThrow({ where: { id: Number(b) } });
    assert.deepEqual([stored.status, stored.confirmationStatus, stored.confirmationAt instanceof Date], ["cancelled", "declined", true]);
    await assert.rejects(store.recordAppointmentResponse(b, "confirmed", user.id), (e) => e instanceof ConfirmationConflictError);
    assert.deepEqual((await getReminderFeed({ date: "2030-01-08", timeZone: TZ })).appointments.map((x) => x.id), [a]);

    // race: "confirmo" and "nao vou" at the same instant. Exactly one starting state, a
    // coherent end state, never "confirmed" on a cancelled appointment.
    const c = await book("2030-01-08T15:00:00.000Z");
    const settled = await Promise.allSettled([
      store.recordAppointmentResponse(c, "confirmed", user.id),
      store.recordAppointmentResponse(c, "declined", user.id),
    ]);
    const end = await prisma.appointment.findUniqueOrThrow({ where: { id: Number(c) } });
    const coherent =
      (end.status === "cancelled" && end.confirmationStatus === "declined") ||
      (end.status === "booked" && end.confirmationStatus === "confirmed");
    assert.ok(coherent, `incoherent end state ${end.status}/${end.confirmationStatus}`);
    assert.ok(settled.some((r) => r.status === "fulfilled"));

    // silence marks without cancelling
    const d = await book("2030-01-08T17:00:00.000Z");
    const silent = await store.recordAppointmentResponse(d, "no_response", user.id);
    assert.deepEqual([silent.status, silent.confirmationStatus], ["booked", "no_response"]);

    // audit trail: written, metadata only
    const audits = await prisma.auditLog.findMany({ where: { action: "appointment.reminder.response", entityId: { in: rows.map(String) } } });
    assert.ok(audits.length >= 4);
    const logged = JSON.stringify(audits);
    for (const secret of ["Rafaela", "Duarte", "Lima", "99999", "1234", "example.test", "cpf-"]) {
      assert.ok(!logged.includes(secret), `audit leaked ${secret}`);
    }
  } finally {
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.appointment.deleteMany({ where: { id: { in: rows } } });
    await prisma.contactPoint.deleteMany({ where: { patientId: patient.id } });
    await prisma.identifier.deleteMany({ where: { patientId: patient.id } });
    await prisma.patient.deleteMany({ where: { id: patient.id } });
    await prisma.authToken.deleteMany({ where: { userId: user.id } });
    await prisma.authUser.deleteMany({ where: { id: user.id } });
    await prisma.$disconnect();
  }
});

test("a reminders token reaches only the reminder endpoints; a full token reaches everything", { skip }, async () => {
  const { prisma } = await load();
  const { addTokenToUser, authenticateToken, getAuthContext } = await import("~/lib/auth.server");
  const user = await prisma.authUser.create({ data: { fullName: "Teste Escopo", crm: "001", crmUf: "BA" } });

  try {
    const full = await addTokenToUser(user.id);
    const narrow = await addTokenToUser(user.id, "reminders");

    // the default requirement is `full`: this is what every pre-existing caller uses
    assert.ok(await authenticateToken(full.rawToken));
    assert.equal(await authenticateToken(narrow.rawToken), null, "a reminders token must not pass the default (full) check");

    // the reminder endpoints accept both
    assert.ok(await authenticateToken(full.rawToken, "reminders"));
    assert.equal((await authenticateToken(narrow.rawToken, "reminders"))?.scope, "reminders");

    // the FHIR API and the UI session go through getAuthContext with the default requirement
    const request = new Request("http://ehr.test/fhir/Patient", { headers: { Authorization: `Bearer ${narrow.rawToken}` } });
    assert.equal(await getAuthContext(request), null);
    assert.ok(await getAuthContext(request, "reminders"));

    // an unknown scope written around the application is refused, not treated as full
    await prisma.authToken.updateMany({ where: { userId: user.id, scope: "reminders" }, data: { scope: "full" } });
    await assert.rejects(prisma.authToken.updateMany({ where: { userId: user.id }, data: { scope: "root" } }));
    await assert.rejects(addTokenToUser(user.id, "root" as never), /Invalid token scope/);
  } finally {
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.authToken.deleteMany({ where: { userId: user.id } });
    await prisma.authUser.deleteMany({ where: { id: user.id } });
    await prisma.$disconnect();
  }
});
