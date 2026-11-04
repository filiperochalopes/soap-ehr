import assert from "node:assert/strict";
import test from "node:test";

// The store reads and validates process.env at import time.
process.env.DATABASE_URL ??= "postgresql://clinic:***@localhost:5432/soap_ehr";
process.env.API_DRY_RUN = "true";

const { DEFAULT_MAX_EDITS, editDistance, normalizePatientName, rankByName } = await import("./patient-name-match");
const { env } = await import("./env.server");
const { toSearchBundle } = await import("./fhir/bundle");
const { getFhirStore } = await import("./fhir/store.server");

const PATIENTS = [
  "Maria Carvalho da Silva",
  "MARIA CARVALHO SILVA",
  "João Pereira Dias",
  "Joana Pereira Lima",
  "Conceição Aparecida Souza",
  "Carlos Eduardo Nunes",
  "Ana Luiza Ramos",
  "Ani Luiza Ramos",
];

function names(query: string, pool: string[] = PATIENTS) {
  return rankByName(query, pool, (name) => name).map((match) => match.item);
}

test("normalizing drops accents, case, symbols and filler words", () => {
  assert.equal(normalizePatientName("  CONCEIÇÃO   da  Silva "), "conceicao silva");
  assert.equal(normalizePatientName("João de Souza e Lima"), "joao souza lima");
  assert.equal(normalizePatientName("D'Ávila-Neto"), "d avila neto");
  assert.equal(normalizePatientName("Ana-Maria"), "ana maria");
  assert.equal(normalizePatientName("Conceição"), "conceicao");
  assert.equal(normalizePatientName(""), "");
  assert.equal(normalizePatientName(null), "");
});

test("case and accents do not matter", () => {
  assert.equal(names("joao pereira dias")[0], "João Pereira Dias");
  assert.equal(names("JOAO PEREIRA DIAS")[0], "João Pereira Dias");
  assert.equal(names("conceicao aparecida")[0], "Conceição Aparecida Souza");
  assert.equal(names("CONCEIÇÃO APARECIDA")[0], "Conceição Aparecida Souza");
  assert.deepEqual(names("CONCEICAO"), ["Conceição Aparecida Souza"]);
});

test("a name with fewer words finds every registration of that person", () => {
  assert.deepEqual(new Set(names("maria carvalho")), new Set(["Maria Carvalho da Silva", "MARIA CARVALHO SILVA"]));
});

test("up to two wrong letters in a word are forgiven", () => {
  assert.equal(names("Joao Pereyra")[0], "João Pereira Dias");
  assert.equal(names("Joao Pereyra Dias")[0], "João Pereira Dias");
  assert.ok(["Maria Carvalho da Silva", "MARIA CARVALHO SILVA"].includes(names("Mariya Carvallo da Silva")[0]));
  assert.equal(names("Joao Perxxra Dias")[0], "João Pereira Dias");
});

test("three wrong letters in a word are not forgiven", () => {
  assert.equal(names("Carlos Edxxxdo Nunes")[0], "Carlos Eduardo Nunes");
  assert.deepEqual(names("Cxrvxlhx Silva"), []);
});

test("a swapped pair of letters counts as one mistake", () => {
  assert.ok(["Maria Carvalho da Silva", "MARIA CARVALHO SILVA"].includes(names("Mraia Carvalho da Silva")[0]));
  assert.deepEqual(names("Mraia", ["Maria Souza"]), ["Maria Souza"]);
});

test("short words are strict so different people are not mixed", () => {
  const ranked = rankByName("Ana Luiza Ramos", PATIENTS, (name) => name);
  assert.equal(ranked[0].item, "Ana Luiza Ramos");
  assert.equal(ranked[0].score, 1);
  const ani = ranked.find((match) => match.item === "Ani Luiza Ramos");
  assert.ok(ani && ani.score < 0.7, "2 of 3 words only");
  assert.deepEqual(names("Luis Carlos Pinto", ["Luiz Carlos Pinto"]), ["Luiz Carlos Pinto"]);
  assert.deepEqual(names("Ana", ["Ani"]), [], "'Ana' is not 'Ani' by a wrong letter");
});

test("the closest comes first and ties are stable", () => {
  const pool = ["Joao Perera Dias", "Joao Pereyra Dias", "João Pereira Dias"];
  const ranked = rankByName("Joao Pereira Dias", pool, (name) => name);

  assert.deepEqual(
    ranked.map((match) => match.item),
    ["João Pereira Dias", "Joao Perera Dias", "Joao Pereyra Dias"],
  );
  assert.deepEqual(
    ranked.map((match) => match.edits),
    [0, 1, 1],
  );
  assert.ok(ranked[0].score > ranked[1].score && ranked[1].score >= ranked[2].score);
});

test("a different person with only a first name in common is not offered", () => {
  assert.deepEqual(names("Carlos Alberto Mendes"), []);
  assert.deepEqual(names("Maria Santos"), []);
});

test("one word is enough, blank is not", () => {
  assert.deepEqual(names("Conceicao"), ["Conceição Aparecida Souza"]);
  assert.deepEqual(names("   "), []);
  assert.deepEqual(names(""), []);
  assert.deepEqual(names("da de"), [], "only filler words");
});

test("a word of the query cannot be used twice", () => {
  assert.deepEqual(names("maria maria", ["Maria Souza"]), []);
});

test("a stretch of a word matches, from three letters, with at most two letters over", () => {
  assert.deepEqual(names("ilva", ["Maria Silva", "Pedro Alves"]), ["Maria Silva"]);
  assert.deepEqual(names("ilva", ["Silvana"]), [], "3 letters over in 'silvana'");
  assert.deepEqual(names("Lu", ["Luiza Lu", "Pedro Alves", "Paulo"]), ["Luiza Lu"], "2 letters: only an exact word");
  assert.deepEqual(names("Pa", ["Paulo"]), [], "2 letters do not start a prefix");
});

test("a stretch with more than two letters over does not match; a prefix still does", () => {
  assert.deepEqual(names("arva", ["Maria Carvalho"]), [], "4 letters over in 'carvalho'");
  assert.deepEqual(names("ana", ["Mariana Souza", "Juliana Lima"]), [], "4 letters over in 'mariana'");
  assert.deepEqual(names("ana", ["Joana Lima"]), ["Joana Lima"], "2 letters over is the limit");
  assert.deepEqual(names("joa", ["Joaquim Souza"]), ["Joaquim Souza"], "the start of a word has no limit");
});

test("the tolerance is one setting: it limits wrong letters and letters over, 2 by default", () => {
  const near = (query: string, pool: string[], maxEdits?: number) =>
    rankByName(query, pool, (name) => name, { maxEdits }).map((match) => match.item);

  // default is 2 and is what the environment resolves to when the variable is unset
  assert.equal(DEFAULT_MAX_EDITS, 2);
  assert.equal(env.PATIENT_SEARCH_MAX_EDITS, 2);
  assert.deepEqual(near("Perxxra", ["Pereira"]), ["Pereira"]);
  assert.deepEqual(near("ana", ["Joana"]), ["Joana"]);

  // 1: one wrong letter, one letter over
  assert.deepEqual(near("Perxxra", ["Pereira"], 1), []);
  assert.deepEqual(near("Pereyra", ["Pereira"], 1), ["Pereira"]);
  assert.deepEqual(near("ana", ["Joana"], 1), []);
  assert.deepEqual(near("ilva", ["Silva"], 1), ["Silva"]);

  // 0: only exact words and the start of a word
  assert.deepEqual(near("Pereyra", ["Pereira"], 0), []);
  assert.deepEqual(near("Luis", ["Luiz"], 0), [], "a 4-letter word never gets more than the setting");
  assert.deepEqual(near("ilva", ["Silva"], 0), []);
  assert.deepEqual(near("joa", ["Joaquim"], 0), ["Joaquim"]);

  // 3: long words tolerate 3, but 4-letter words still tolerate 1 and short words none
  // (a single word with 3 wrong letters scores 0.55, under the 0.6 minimum: it needs a second word)
  assert.deepEqual(near("Cxrvxlhx Silva", ["Carvalho Silva"], 3), ["Carvalho Silva"]);
  assert.deepEqual(near("Cxrvxlhx Silva", ["Carvalho Silva"]), []);
  assert.deepEqual(near("Lxxz", ["Luiz"], 3), []);
});

test("accepted consequence: 'Ana' also finds Joana and Anabela, below the exact Ana", () => {
  const found = names("Ana", ["Joana Lima", "Ana Souza", "Anabela Dias", "Mariana Souza", "Pedro Alves"]);
  assert.equal(found[0], "Ana Souza");
  assert.deepEqual(new Set(found), new Set(["Ana Souza", "Joana Lima", "Anabela Dias"]));
});

test("hyphen, apostrophe and cedilla do not matter", () => {
  assert.deepEqual(names("ana maria", ["Ana-Maria Souza"]), ["Ana-Maria Souza"]);
  assert.deepEqual(names("davila", ["D'Ávila Neto"]), ["D'Ávila Neto"]);
  assert.deepEqual(names("Conceicao", ["Conceição"]), ["Conceição"]);
});

test("order: exact, then prefix/stretch, then 1 error, then 2 errors; ties A-Z then input order", () => {
  const pool = ["Pereyra", "Pereirao", "Pereira", "Perxxra", "Zpereira", "Pereira"];
  const ranked = rankByName("pereira", pool, (name) => name);

  assert.deepEqual(
    ranked.map((match) => match.item),
    ["Pereira", "Pereira", "Pereirao", "Zpereira", "Pereyra", "Perxxra"],
  );
});

test("the score never leaves the module through the FHIR bundle", () => {
  const bundle = toSearchBundle("Patient", [{ resourceType: "Patient", id: "1" }], "http://ehr.test");
  for (const entry of bundle.entry) {
    assert.deepEqual(Object.keys(entry.search), ["mode"]);
  }
});

test("edit distance counts insert, delete, replace and swap", () => {
  assert.equal(editDistance("maria", "maria"), 0);
  assert.equal(editDistance("maria", "mariaa"), 1);
  assert.equal(editDistance("maria", "mari"), 1);
  assert.equal(editDistance("maria", "marya"), 1);
  assert.equal(editDistance("maria", "mraia"), 1);
  assert.equal(editDistance("carvalho", "carvallho"), 1);
  assert.equal(editDistance("abc", "xyz"), 3);
  assert.equal(editDistance("", "abc"), 3);
});

async function savePatients(store: ReturnType<typeof getFhirStore>, patientNames: string[]) {
  for (const name of patientNames) {
    await store.savePatient({ resourceType: "Patient", name: [{ text: name }], gender: "unknown", birthDate: "1990-01-01" }, 1);
  }
}

function resourceName(resource: { [key: string]: unknown }) {
  return (resource.name as Array<{ text: string }>)[0].text;
}

test("the store finds a patient by an approximate name, best match first", async () => {
  const store = getFhirStore();
  await savePatients(store, ["João Pereira", "Joao Perera", "Joana Lima", "Zé Silva"]);

  const found = await store.searchPatients({ name: "joao pereyra", limit: 100, offset: 0 });

  assert.deepEqual(found.map(resourceName), ["João Pereira", "Joao Perera"]);
  assert.deepEqual((await store.searchPatients({ name: "ilva", limit: 100, offset: 0 })).map(resourceName), ["Zé Silva"]);
});

test("the store pages 130 similar names without repeating or skipping anyone", async () => {
  const store = getFhirStore();
  await savePatients(
    store,
    Array.from({ length: 130 }, (_, index) => `Fulano Beltrano ${String.fromCharCode(97 + (index % 26))}${index}`),
  );

  const pages = [];
  for (const offset of [0, 50, 100]) {
    pages.push(await store.searchPatients({ name: "fulano beltrano", limit: 50, offset }));
  }

  assert.deepEqual(pages.map((page) => page.length), [50, 50, 30]);
  const ids = pages.flat().map((patient) => String(patient.id));
  assert.equal(new Set(ids).size, 130, "no patient appears on two pages");
  assert.equal((await store.searchPatients({ name: "fulano beltrano", limit: 50, offset: 150 })).length, 0);
});
