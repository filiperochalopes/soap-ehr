import assert from "node:assert/strict";
import test from "node:test";

// The modules below read and validate process.env at import time.
process.env.DATABASE_URL ??= "postgresql://clinic:***@localhost:5432/soap_ehr";
process.env.API_DRY_RUN = "true";

const { parsePatientPaging, PatientPagingError, MAX_PATIENT_PAGE } = await import("./patient-paging");
const { getFhirStore } = await import("./store.server");

function params(query: string) {
  return new URL(`http://ehr.test/fhir/Patient${query}`).searchParams;
}

test("without paging parameters it behaves as before: the first 100", () => {
  assert.deepEqual(parsePatientPaging(params("")), { limit: 100, offset: 0 });
  assert.equal(MAX_PATIENT_PAGE, 100);
});

test("_count and _offset are honoured", () => {
  assert.deepEqual(parsePatientPaging(params("?_count=25&_offset=50")), { limit: 25, offset: 50 });
  assert.deepEqual(parsePatientPaging(params("?_offset=100")), { limit: 100, offset: 100 });
});

test("a page can never be bigger than the cap", () => {
  assert.equal(parsePatientPaging(params("?_count=100")).limit, 100);
  assert.equal(parsePatientPaging(params("?_count=5000")).limit, 100);
});

test("a malformed or out of range value is an error, not a silent default", () => {
  for (const query of ["?_count=0", "?_count=-1", "?_count=abc", "?_count=1.5", "?_offset=-1", "?_offset=abc", "?_offset=1.5", "?_offset=", "?_count="]) {
    assert.throws(() => parsePatientPaging(params(query)), PatientPagingError, query);
  }
});

test("a huge offset is refused instead of reaching the database", () => {
  assert.throws(() => parsePatientPaging(params("?_offset=99999999999")), PatientPagingError);
});

test("the store pages the registry without repeating or skipping anyone", async () => {
  const store = getFhirStore();
  for (let index = 1; index <= 130; index += 1) {
    await store.savePatient(
      {
        resourceType: "Patient",
        name: [{ text: `Paciente ${String(index).padStart(4, "0")}` }],
        gender: "unknown",
        birthDate: "1990-01-01",
      },
      1,
    );
  }

  const first = await store.searchPatients({ name: null, limit: 100, offset: 0 });
  const second = await store.searchPatients({ name: null, limit: 100, offset: 100 });
  const third = await store.searchPatients({ name: null, limit: 100, offset: 200 });

  assert.equal(first.length, 100);
  assert.ok(second.length >= 30, `second page has ${second.length}`);
  assert.equal(third.length, 0);
  const ids = [...first, ...second].map((patient) => String(patient.id));
  assert.equal(new Set(ids).size, ids.length, "no patient appears on two pages");

  const names = [...first, ...second].map((patient) => String((patient.name as Array<{ text: string }>)[0].text));
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)), "alphabetical across pages");
});

test("a smaller page and the name filter still work", async () => {
  const store = getFhirStore();

  const few = await store.searchPatients({ name: null, limit: 5, offset: 0 });
  const filtered = await store.searchPatients({ name: "Paciente 0001", limit: 100, offset: 0 });

  assert.equal(few.length, 5);
  assert.ok(filtered.length >= 1);
});
