import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_BODY_BYTES,
  MAX_TEXT_CHARS,
  handleRehydrateRequest,
  type RehydrateAuditEntry,
  type RehydrateRequestDeps,
} from "./agent-rehydrate.server";

const NOW = new Date("2026-11-12T15:00:00Z");
const TOKEN = "report-token-ok";

const PEOPLE: Record<number, { name: string; birthDate: Date | null }> = {
  42: { name: "Marina Almeida", birthDate: new Date("1984-08-14") },
  57: { name: "Mariana Costa", birthDate: new Date("1991-02-01") },
};

function setup(overrides: Partial<RehydrateRequestDeps> = {}) {
  const audits: RehydrateAuditEntry[] = [];
  const looked: number[] = [];
  const deps: RehydrateRequestDeps = {
    authenticate: async (request) => {
      if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
        throw new Response(null, { status: 401 });
      }
      return { tokenId: 7, user: { id: 1 } };
    },
    find: async (id) => {
      looked.push(id);
      return PEOPLE[id] ?? null;
    },
    audit: async (entry) => {
      audits.push(entry);
    },
    timeZone: async () => "America/Sao_Paulo",
    now: () => NOW,
    ...overrides,
  };
  return { audits, deps, looked };
}

function post(body: unknown, init: { token?: string | null; raw?: string; headers?: Record<string, string> } = {}) {
  const token = init.token === undefined ? TOKEN : init.token;
  return new Request("http://ehr.test/api/agent/rehydrate", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
    body: init.raw ?? JSON.stringify(body),
  });
}

test("a report is rehydrated and the answer is not cacheable", async () => {
  const { deps } = setup();
  const response = await handleRehydrateRequest(post({ texto: "Hoje: @P42 e @P57. Também @P99." }), deps);

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    texto: "Hoje: Marina Almeida (42 anos) e Mariana Costa (35 anos). Também @P99 [não encontrado].",
    mencoes: 2,
    nao_encontradas: [99],
  });
});

test("only POST is accepted, before anything else runs", async () => {
  const { audits, deps, looked } = setup();
  for (const method of ["GET", "PUT", "DELETE", "PATCH"]) {
    const response = await handleRehydrateRequest(new Request("http://ehr.test/api/agent/rehydrate", { method }), deps);
    assert.equal(response.status, 405, method);
    assert.equal(response.headers.get("allow"), "POST");
  }
  assert.deepEqual([audits.length, looked.length], [0, 0]);
});

test("without a valid token nothing is read, looked up or audited", async () => {
  const { audits, deps, looked } = setup();
  for (const token of [null, "wrong", "agent-token"]) {
    await assert.rejects(
      handleRehydrateRequest(post({ texto: "@P42" }, { token }), deps),
      (thrown) => thrown instanceof Response && thrown.status === 401,
    );
  }
  assert.deepEqual([audits.length, looked.length], [0, 0]);
});

test("each call is audited with counts only, never the text or a name", async () => {
  const { audits, deps } = setup();
  await handleRehydrateRequest(post({ texto: "@P42 e @P99 e @P42" }), deps);

  assert.deepEqual(audits, [{ tokenId: 7, userId: 1, mentions: 2, notFound: 1, characters: 18 }]);
  assert.doesNotMatch(JSON.stringify(audits), /marina|almeida|@P/i);
});

test("the age is computed on the clinic's day", async () => {
  // 2026-08-14 at 01:00 UTC is still 13 Aug in Sao Paulo: one day before the 42nd birthday
  const { deps } = setup({ now: () => new Date("2026-08-14T01:00:00Z") });
  const body = await (await handleRehydrateRequest(post({ texto: "@P42" }), deps)).json();
  assert.equal(body.texto, "Marina Almeida (41 anos)");
});

test("a malformed body is a 400 with a reason and no lookup", async () => {
  const { audits, deps, looked } = setup();
  const cases: Array<[string, Request]> = [
    ["invalid_json", post(null, { raw: "{não é json" })],
    ["invalid_body", post(null, { raw: "[]" })],
    ["invalid_body", post(null, { raw: "null" })],
    ["invalid_body", post({})],
    ["invalid_body", post({ texto: 42 })],
    ["invalid_body", post({ texto: null })],
    ["invalid_body", post({ text: "@P42" })],
  ];

  for (const [error, request] of cases) {
    const response = await handleRehydrateRequest(request, deps);
    assert.equal(response.status, 400, error);
    assert.equal((await response.json()).error, error);
  }
  assert.deepEqual([audits.length, looked.length], [0, 0]);
});

test("a text or a body over the limit is a 413", async () => {
  const { deps, looked } = setup();

  const longText = await handleRehydrateRequest(post({ texto: "x".repeat(MAX_TEXT_CHARS + 1) }), deps);
  assert.equal(longText.status, 413);

  const declared = await handleRehydrateRequest(post({ texto: "@P42" }, { headers: { "content-length": String(MAX_BODY_BYTES + 1) } }), deps);
  assert.equal(declared.status, 413);

  const edge = await handleRehydrateRequest(post({ texto: "a".repeat(MAX_TEXT_CHARS) }), deps);
  assert.equal(edge.status, 200);
  assert.equal(looked.length, 0);
});

test("mentioning too many different patients is a 400", async () => {
  const { audits, deps } = setup();
  const texto = Array.from({ length: 101 }, (_, index) => `@P${index + 1}`).join(" ");
  const response = await handleRehydrateRequest(post({ texto }), deps);

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "too_many_mentions");
  assert.equal(audits.length, 0);
});

test("an unexpected failure is not turned into an answer", async () => {
  const { audits, deps } = setup({
    find: async () => {
      throw new Error("falha do banco");
    },
  });
  await assert.rejects(handleRehydrateRequest(post({ texto: "@P42" }), deps), /falha do banco/);
  assert.equal(audits.length, 0);
});

test("a body over the limit is refused even when the client does not declare its length", async () => {
  const { deps, looked } = setup();
  const response = await handleRehydrateRequest(post({ texto: "@P42", enchimento: "x".repeat(MAX_BODY_BYTES + 1) }), deps);

  assert.equal(response.status, 413);
  assert.equal(looked.length, 0);
});
