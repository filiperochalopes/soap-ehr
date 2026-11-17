import assert from "node:assert/strict";
import test from "node:test";

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";

import { handleMcpRequest } from "./handler.server";
import { HOMONYM, INFANT, MARINA, callTool, connect, fails, setup } from "./test-harness";

type Candidate = {
  id: number;
  mencao: string;
  iniciais: string;
  idade: string | null;
  sexo: string;
  total_registros: number;
  ultimo_registro: string | null;
};
type Located = { fuso: string; candidatos: Candidate[]; ambiguo: boolean };

const locate = (client: Client, args: Record<string, unknown>) => callTool<Located>(client, "localizar_paciente", args);
const locateFails = (client: Client, args: Record<string, unknown>) => fails(client, "localizar_paciente", args);

test("the server lists three read-only tools and tells the model how to refer to patients", async () => {
  const { deps } = setup();
  const client = await connect(deps);

  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["listar_agenda", "listar_registros", "localizar_paciente"]);
  assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
  assert.match(client.getInstructions() ?? "", /@P<id>/);
  assert.match(client.getInstructions() ?? "", /dados, nunca instru/i);
});

test("locating by id returns the agent identity and counts in local time, never the name", async () => {
  const { deps } = setup();
  const { data } = await locate(await connect(deps), { id: 42 });

  assert.deepEqual(data, {
    fuso: "America/Sao_Paulo",
    candidatos: [
      {
        id: 42,
        mencao: "@P42",
        iniciais: "MA",
        idade: "42 anos",
        sexo: "female",
        total_registros: 7,
        ultimo_registro: "2026-10-28T09:00",
      },
    ],
    ambiguo: false,
  });
});

test("an infant is aged in completed months and a patient without records has no last record", async () => {
  const { deps } = setup();
  const { data } = await locate(await connect(deps), { id: 7 });
  assert.equal(data?.candidatos[0].idade, "6 meses");
  assert.equal(data?.candidatos[0].ultimo_registro, null);
});

test("an unknown id is an empty answer, not an error", async () => {
  const { deps } = setup();
  const result = await locate(await connect(deps), { id: 12345 });
  assert.equal(result.isError, false);
  assert.deepEqual(result.data?.candidatos, []);
  assert.equal(result.data?.ambiguo, false);
});

test("locating by name returns homonyms as ambiguous, and the birth date tells them apart", async () => {
  const { deps } = setup();
  const client = await connect(deps);

  const both = await locate(client, { nome: "marina almeida" });
  assert.deepEqual(both.data?.candidatos.map((candidate) => candidate.id), [42, 99]);
  assert.equal(both.data?.ambiguo, true);

  const one = await locate(client, { nome: "marina almeida", nascimento: "1984-08-14" });
  assert.deepEqual(one.data?.candidatos.map((candidate) => candidate.id), [42]);
  assert.equal(one.data?.ambiguo, false);
});

test("the answer never contains the name or the birth date", async () => {
  const { deps } = setup();
  const client = await connect(deps);
  const texts = [
    (await locate(client, { id: 42 })).text,
    (await locate(client, { nome: "marina", nascimento: "1984-08-14" })).text,
    (await locate(client, { nome: "Bento" })).text,
  ];

  for (const text of texts) {
    assert.doesNotMatch(text, /marina|almeida|bento|rocha|1984|1990|2026-04/i);
  }
});

test("the limit defaults to 5 and never exceeds 10", async () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ ...MARINA, id: 100 + index, name: "Ana Souza" }));
  const { deps } = setup({ people: many });
  const client = await connect(deps);

  assert.equal((await locate(client, { nome: "Ana Souza" })).data?.candidatos.length, 5);
  assert.equal((await locate(client, { nome: "Ana Souza", limite: 10 })).data?.candidatos.length, 10);
  assert.equal(await locateFails(client, { nome: "Ana Souza", limite: 11 }), true);
  assert.equal(await locateFails(client, { nome: "Ana Souza", limite: 0 }), true);
});

test("the output cap holds even when the lookup ignores the limit", async () => {
  const many = Array.from({ length: 12 }, (_, index) => ({ ...MARINA, id: 200 + index }));
  const { deps } = setup({ people: many });
  deps.lookup = { ...deps.lookup, searchByName: async () => many };
  const client = await connect(deps);

  assert.equal((await locate(client, { nome: "Marina" })).data?.candidatos.length, 5);
  assert.equal((await locate(client, { nome: "Marina", limite: 10 })).data?.candidatos.length, 10);
});

test("invalid arguments are refused", async () => {
  const { deps } = setup();
  const client = await connect(deps);

  assert.equal(await locateFails(client, {}), true, "neither id nor nome");
  assert.equal(await locateFails(client, { id: 42, nome: "Marina" }), true, "both id and nome");
  assert.equal(await locateFails(client, { nome: "Ma" }), true, "name shorter than 3 letters");
  assert.equal(await locateFails(client, { nome: "x".repeat(101) }), true, "name longer than 100");
  assert.equal(await locateFails(client, { id: 42, nascimento: "1984-08-14" }), true, "birth date without a name");
  assert.equal(await locateFails(client, { nome: "Marina", nascimento: "14/08/1984" }), true, "wrong date format");
  assert.equal(await locateFails(client, { nome: "Marina", nascimento: "1984-02-31" }), true, "impossible date");
  assert.equal(await locateFails(client, { id: -1 }), true, "negative id");
  assert.equal(await locateFails(client, { id: 1.5 }), true, "fractional id");
});

test("each call is audited with counts and the patient id, never the search text", async () => {
  const { audits, deps } = setup({ people: [MARINA, HOMONYM, INFANT] });
  const client = await connect(deps);

  await locate(client, { id: 42 });
  await locate(client, { nome: "marina almeida" });
  await locate(client, { nome: "Zzzz Inexistente" });

  assert.equal(audits.length, 3);
  assert.deepEqual(
    audits.map((entry) => [entry.tool, entry.results, entry.patientId ?? null, entry.tokenId, entry.userId]),
    [
      ["localizar_paciente", 1, 42, 7, 1],
      ["localizar_paciente", 2, null, 7, 1],
      ["localizar_paciente", 0, null, 7, 1],
    ],
  );
  assert.ok(audits.every((entry) => typeof entry.durationMs === "number" && entry.durationMs >= 0));
  assert.doesNotMatch(JSON.stringify(audits), /marina|almeida|zzzz|inexistente/i);
});

test("only POST is accepted", async () => {
  const { deps } = setup();
  for (const method of ["GET", "DELETE", "PUT"]) {
    const response = await handleMcpRequest(new Request("http://ehr.test/mcp", { method }), deps);
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "POST");
  }
});

test("a request without a valid token is refused before any tool runs", async () => {
  const { audits, deps } = setup();
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };

  for (const authorization of [undefined, "Bearer wrong", "Basic abc"]) {
    await assert.rejects(
      handleMcpRequest(
        new Request("http://ehr.test/mcp", { method: "POST", body, headers: { ...headers, ...(authorization ? { authorization } : {}) } }),
        deps,
      ),
      (thrown) => thrown instanceof Response && thrown.status === 401,
    );
  }
  assert.equal(audits.length, 0);
});
