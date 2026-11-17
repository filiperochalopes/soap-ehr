import assert from "node:assert/strict";
import test from "node:test";

import { MAX_DISTINCT_MENTIONS, RehydrateInputError, rehydrateMentions, type RehydrationPatient } from "./rehydrate";

const NOW = new Date("2026-11-12T15:00:00Z");

const PEOPLE: Record<number, RehydrationPatient> = {
  42: { name: "Marina Almeida", birthDate: new Date("1984-08-14") },
  57: { name: "Mariana Costa", birthDate: new Date("1991-02-01") },
  7: { name: "Bento Rocha", birthDate: new Date("2026-04-20") },
  8: { name: "Sem Nascimento", birthDate: null },
  9: { name: "Nome com @P42 e $& dentro", birthDate: new Date("2000-01-01") },
};

function lookup() {
  const calls: number[] = [];
  return {
    calls,
    find: async (id: number) => {
      calls.push(id);
      return PEOPLE[id] ?? null;
    },
  };
}

const run = (text: string, find = lookup().find) => rehydrateMentions(text, find, { now: NOW });

test("a mention becomes the full name and the agent age", async () => {
  const out = await run("Paciente @P42 e @P57 amanhã.");
  assert.equal(out.texto, "Paciente Marina Almeida (42 anos) e Mariana Costa (35 anos) amanhã.");
  assert.equal(out.mencoes, 2);
  assert.deepEqual(out.nao_encontradas, []);
});

test("an infant keeps the completed months and a patient without birth date has no age", async () => {
  const out = await run("@P7 / @P8");
  assert.equal(out.texto, "Bento Rocha (6 meses) / Sem Nascimento");
});

test("punctuation, brackets, markdown and line ends around a mention are fine", async () => {
  const out = await run("(@P42), @P57. **@P42**\n- @P57;\n\"@P42\"");
  assert.equal(
    out.texto,
    "(Marina Almeida (42 anos)), Mariana Costa (35 anos). **Marina Almeida (42 anos)**\n- Mariana Costa (35 anos);\n\"Marina Almeida (42 anos)\"",
  );
});

test("a mention glued to letters or digits is left alone", async () => {
  for (const text of ["email@P42x", "a@P42", "x1@P42", "@P42abc", "@P42x", "@P420x", "@P42_", "@P42ã", "@Pnome", "@P", "@P-1"]) {
    const out = await run(text);
    assert.equal(out.texto, text, text);
    assert.equal(out.mencoes, 0, text);
  }
});

test("only the exact form @P<id> counts: no leading zeros, no other case, no other prefix", async () => {
  for (const text of ["@P007", "@P0", "@p42", "P42", "#P42", "@ P42", "@P 42", "@P-1"]) {
    const out = await run(text);
    assert.equal(out.texto, text, text);
    assert.equal(out.mencoes, 0, text);
  }
});

test("an unknown id is marked and listed once, and the rest still resolves", async () => {
  const out = await run("@P99 @P42 @P99");
  assert.equal(out.texto, "@P99 [não encontrado] Marina Almeida (42 anos) @P99 [não encontrado]");
  assert.equal(out.mencoes, 1);
  assert.deepEqual(out.nao_encontradas, [99]);
});

test("an id too big for the database is not found without asking", async () => {
  const { calls, find } = lookup();
  const out = await run("@P9999999999 @P2147483648 @P2147483647", find);
  assert.equal(out.texto, "@P9999999999 [não encontrado] @P2147483648 [não encontrado] @P2147483647 [não encontrado]");
  assert.deepEqual(calls, [2147483647]);
  assert.equal((await run("@P99999999999")).texto, "@P99999999999"); // 11 digits: not a mention at all
});

test("each patient is looked up once, however many times it is mentioned", async () => {
  const { calls, find } = lookup();
  await run("@P42 @P42 @P57 @P42 @P57", find);
  assert.deepEqual([...calls].sort(), [42, 57]);
});

test("the rest of the text is byte for byte the same, and a name is never expanded again", async () => {
  const text = "Relatório — ação\r\n\tOlá\u00A0mundo 😀 @P9 fim $1 $& \\n";
  const out = await run(text);
  assert.equal(out.texto, "Relatório — ação\r\n\tOlá\u00A0mundo 😀 Nome com @P42 e $& dentro (26 anos) fim $1 $& \\n");
});

test("a text with no mention is returned as it came and nothing is looked up", async () => {
  const { calls, find } = lookup();
  const out = await run("Sem menções aqui.", find);
  assert.deepEqual([out.texto, out.mencoes, out.nao_encontradas, calls], ["Sem menções aqui.", 0, [], []]);
});

test("too many different patients in one text are refused", async () => {
  const many = Array.from({ length: MAX_DISTINCT_MENTIONS + 1 }, (_, index) => `@P${index + 1}`).join(" ");
  await assert.rejects(run(many), RehydrateInputError);

  const atLimit = Array.from({ length: MAX_DISTINCT_MENTIONS }, (_, index) => `@P${index + 1}`).join(" ");
  assert.equal((await run(atLimit)).nao_encontradas.length, MAX_DISTINCT_MENTIONS - 5); // ids 7, 8, 9, 42 and 57 exist
});

test("the ids not found come sorted as numbers, not as text", async () => {
  const out = await run("@P1000 @P300 @P99 @P300");
  assert.deepEqual(out.nao_encontradas, [99, 300, 1000]);
});
