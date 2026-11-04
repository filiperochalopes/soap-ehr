import assert from "node:assert/strict";
import test from "node:test";

/**
 * Integration test against a REAL PostgreSQL (the Prisma store). It only runs when
 * INTEGRATION_DATABASE_URL points at a disposable database that already has the migrations
 * applied; see reminders.integration.test.ts for the setup. It refuses any URL that is not
 * localhost, and it cleans up the rows it creates.
 *
 * It catches what the dry-run store cannot: PostgreSQL's `contains` is case- and accent-sensitive,
 * so "joao" never found "João" before the search ranked names in the application.
 */
const url = process.env.INTEGRATION_DATABASE_URL;
const skip = url ? false : "INTEGRATION_DATABASE_URL is not set";

if (url) {
  assert.match(new URL(url).hostname, /^(localhost|127\.0\.0\.1)$/, "integration tests only run against localhost");
  process.env.DATABASE_URL = url;
  process.env.API_DRY_RUN = "false";
}

const TAG = `it-patient-search-${process.pid}`;
const CPF = "98765432100";

test("approximate patient search against the real Prisma store", { skip }, async () => {
  const { prisma } = await import("~/lib/prisma.server");
  const { searchActivePatientIds } = await import("~/lib/patients.server");
  const { getFhirStore } = await import("./fhir/store.server");
  const created: number[] = [];

  const make = async (name: string, overrides: { active?: boolean; cpf?: string } = {}) => {
    const row = await prisma.patient.create({
      data: {
        name,
        gender: "unknown",
        birthDate: new Date("1990-02-03"),
        active: overrides.active ?? true,
        identifier: overrides.cpf ? { create: [{ system: `urn:${TAG}`, value: overrides.cpf }] } : undefined,
      },
    });
    created.push(row.id);
    return row.id;
  };
  // The database may hold other rows: look only at the ones this test created.
  const mine = (ids: number[]) => ids.filter((id) => created.includes(id));
  const fhirIds = async (name: string) =>
    (await getFhirStore().searchPatients({ name, limit: 100, offset: 0 })).map((patient) => Number(patient.id));

  try {
    const joao = await make("João Pereira");
    const conceicao = await make("Conceição Lima");
    const silva = await make("Maria Silva");
    const anaMaria = await make("Ana-Maria Costa");
    const inactive = await make("João Inativo", { active: false });
    const carlos = await make("Carlos Souza", { cpf: CPF });

    // the regression: no case or accent folding in PostgreSQL's `contains`
    assert.deepEqual(mine(await searchActivePatientIds("joao")), [joao]);
    assert.deepEqual(mine(await searchActivePatientIds("JOAO PEREYRA")), [joao]);
    assert.deepEqual(mine(await fhirIds("joao")), [joao]);
    assert.deepEqual(mine(await fhirIds("CONCEICAO")), [conceicao]);
    assert.deepEqual(mine(await fhirIds("ilva")), [silva]);
    assert.deepEqual(mine(await fhirIds("ana maria")), [anaMaria]);
    assert.ok(!(await fhirIds("joao")).includes(inactive), "an inactive patient is never offered");

    // paging cuts the ranked list, and the page keeps the ranking order
    const ranked = mine(await fhirIds("maria"));
    assert.deepEqual(ranked.slice().sort(), [silva, anaMaria].sort());
    const firstPage = await getFhirStore().searchPatients({ name: "maria", limit: 1, offset: 0 });
    const secondPage = await getFhirStore().searchPatients({ name: "maria", limit: 1, offset: 1 });
    const stitched = [...firstPage, ...secondPage].map((patient) => Number(patient.id));
    assert.deepEqual(stitched, (await fhirIds("maria")).slice(0, 2));

    // merge search: never the patient itself; identifiers compare letters and digits only
    assert.ok(!(await searchActivePatientIds("joao pereira", { excludeId: joao })).includes(joao));
    assert.deepEqual(mine(await searchActivePatientIds("987.654.321-00", { matchIdentifier: true })), [carlos]);
    assert.deepEqual(mine(await searchActivePatientIds("987.654.321-00")), [], "the FHIR search does not read identifiers");
  } finally {
    await prisma.identifier.deleteMany({ where: { patientId: { in: created } } });
    await prisma.patient.deleteMany({ where: { id: { in: created } } });
    await prisma.$disconnect();
  }
});
