import assert from "node:assert/strict";
import test from "node:test";

import type { Prisma } from "@prisma/client";

/**
 * Integration test of the real `/mcp` route against a REAL PostgreSQL. It only runs when
 * INTEGRATION_DATABASE_URL points at a disposable database that already has the migrations
 * applied (see reminders.integration.test.ts for the docker recipe). It refuses any URL that is
 * not localhost and deletes the rows it creates.
 *
 * It covers what the fakes of the other MCP tests cannot: real tokens and scopes, the merge chain,
 * the record count, the Prisma queries behind `listar_registros` and `listar_agenda`, the names
 * taken from the patient, the merged cadastro and the contacts, the rehydration endpoint with its
 * scope rules, and the audit rows of the routes.
 */
const url = process.env.INTEGRATION_DATABASE_URL;
const skip = url ? false : "INTEGRATION_DATABASE_URL is not set";

if (url) {
  assert.match(new URL(url).hostname, /^(localhost|127\.0\.0\.1)$/, "integration tests only run against localhost");
  process.env.DATABASE_URL = url;
  process.env.API_DRY_RUN = "false";
}

const TAG = `Zorzal${process.pid}`;

test("the /mcp route with real tokens, merged cadastros, record counts and audit", { skip }, async () => {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const { prisma } = await import("~/lib/prisma.server");
  const { addTokenToUser, requireApiScope } = await import("~/lib/auth.server");
  const { createNarrativeComposition, createSoapComposition } = await import("~/lib/ehr/compositions.server");
  const { mergePatientRecords } = await import("~/lib/patients.server");
  const route = await import("~/routes/mcp");
  const rehydrateRoute = await import("~/routes/api.agent.rehydrate");

  const patientIds: number[] = [];
  const user = await prisma.authUser.create({
    data: { crm: `IT-${process.pid}`, crmUf: "NA", fullName: `Dr ${TAG}` },
  });

  const call = async (request: Request) => {
    try {
      return await route.action({ request });
    } catch (thrown) {
      if (thrown instanceof Response) {
        return thrown;
      }
      throw thrown;
    }
  };
  const connect = async (token: string) => {
    const transport = new StreamableHTTPClientTransport(new URL("http://ehr.test/mcp"), {
      fetch: (input, init) => call(new Request(input, init)),
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client({ name: "it", version: "0" });
    await client.connect(transport);
    return client;
  };
  const locate = async (client: InstanceType<typeof Client>, args: Record<string, unknown>) => {
    const result = await client.callTool({ name: "localizar_paciente", arguments: args });
    return JSON.parse((result.content as Array<{ text: string }>)[0].text) as {
      candidatos: Array<{ id: number; mencao: string; iniciais: string; total_registros: number; ultimo_registro: string | null }>;
      ambiguo: boolean;
    };
  };

  try {
    const tokens = {
      agent: (await addTokenToUser(user.id, "agent")).rawToken,
      full: (await addTokenToUser(user.id, "full")).rawToken,
      reminders: (await addTokenToUser(user.id, "reminders")).rawToken,
      report: (await addTokenToUser(user.id, "report")).rawToken,
    };

    const make = async (name: string, birth: string, active = true, contactName?: string) => {
      const patient = await prisma.patient.create({
        data: {
          name,
          gender: "female",
          birthDate: new Date(birth),
          active,
          ...(contactName ? { contacts: { create: [{ name: contactName, relationship: "mother" }] } } : {}),
        },
      });
      patientIds.push(patient.id);
      return patient;
    };
    const survivor = await make(`Marina ${TAG} Almeida`, "1984-08-14", true, "Rosalva Prates");
    const duplicate = await make(`Marina ${TAG} Almeida Duplicada`, "1984-08-14");
    const homonym = await make(`Marina ${TAG} Almeida`, "1990-03-02");
    const inactive = await make(`Inativa ${TAG}`, "1970-01-01", false);

    const note = (patientId: number, day: string) =>
      createSoapComposition({
        assessment: "A", authorUserId: user.id, encounteredAt: new Date(day), objective: "O", patientId, plan: "P", subjective: "S",
      });
    await note(survivor.id, "2026-09-01T12:00:00Z");
    await note(duplicate.id, "2026-10-28T12:00:00Z");
    await createSoapComposition({
      assessment: "HAS", authorUserId: user.id, encounteredAt: new Date("2026-10-05T12:00:00Z"), objective: "PA 130x85", patientId: survivor.id,
      plan: "Manter", subjective: `Marina ${TAG} Almeida relata dor. A mãe Rosalva veio. CPF 123.456.789-09. Ligou a Duplicada.`,
    });
    await createNarrativeComposition({
      authorUserId: user.id, encounteredAt: new Date("2026-10-06T12:00:00Z"), patientId: duplicate.id,
      sections: [{ title: "Telefonema", text: "Falou com Rosalva sobre exames." }],
    });
    await mergePatientRecords({ actorUserId: user.id, sourcePatientId: duplicate.id, targetPatientId: survivor.id });

    // a note amended once has two versions but is still one record
    const first = await prisma.compositionVersion.findFirstOrThrow({
      where: { composerUserId: user.id, encounteredAt: new Date("2026-09-01T12:00:00Z") },
    });
    const { id: _firstId, sourceMetadata: _meta, ...firstFields } = first;
    await prisma.compositionVersion.create({
      data: {
        ...firstFields,
        content: first.content as Prisma.InputJsonValue,
        fhirCompositionId: `${first.fhirCompositionId}-v2`,
        precedingVersionId: first.id,
        versionNumber: 2,
      },
    });

    // scopes: only the agent token gets in
    for (const scope of ["full", "reminders", "report"] as const) {
      await assert.rejects(connect(tokens[scope]), /401|Unauthorized|HTTP/i, `${scope} must not reach /mcp`);
    }
    const noAuth = await call(new Request("http://ehr.test/mcp", { method: "POST", body: "{}" }));
    assert.equal(noAuth.status, 401);

    const client = await connect(tokens.agent);

    // by id: a merged cadastro answers as the survivor, counting both histories
    const viaMerged = await locate(client, { id: duplicate.id });
    assert.deepEqual(viaMerged.candidatos.map((c) => c.id), [survivor.id]);
    assert.equal(viaMerged.candidatos[0].total_registros, 4); // the amended note counts once
    assert.equal(viaMerged.candidatos[0].ultimo_registro, "2026-10-28T09:00"); // local time, UTC-3
    assert.equal(viaMerged.candidatos[0].mencao, `@P${survivor.id}`);
    assert.equal(viaMerged.candidatos[0].iniciais, "MZA"); // Marina + the tag word + Almeida

    // an inactive patient is not found
    assert.deepEqual((await locate(client, { id: inactive.id })).candidatos, []);
    assert.deepEqual((await locate(client, { nome: `Inativa ${TAG}` })).candidatos, []);

    // by name: the merged cadastro is inactive, so the survivor and the homonym remain; the birth date separates them.
    // Other rows of a shared database may also be close in name, so look only at the patients created here.
    const ours = (result: { candidatos: Array<{ id: number }> }) =>
      result.candidatos.map((c) => c.id).filter((id) => patientIds.includes(id));
    const byName = await locate(client, { nome: `Marina ${TAG} Almeida` });
    assert.deepEqual(new Set(ours(byName)), new Set([survivor.id, homonym.id]));
    assert.equal(byName.ambiguo, true);
    const byBirth = await locate(client, { nome: `marina ${TAG.toLowerCase()} almeida`, nascimento: "1984-08-14" });
    assert.deepEqual(ours(byBirth), [survivor.id]);
    assert.deepEqual(ours(await locate(client, { nome: `Marina ${TAG} Almeida`, nascimento: "2001-01-01" })), []);

    // nothing identifying left the server
    const everything = JSON.stringify([viaMerged, byName, byBirth]);
    assert.doesNotMatch(everything, new RegExp(`marina|almeida|${TAG}|1984-08-14|1990-03-02`, "i"));

    // listar_registros: asking by the merged cadastro answers as the survivor, with every history, newest first
    const read = async (args: Record<string, unknown>) => {
      const result = await client.callTool({ name: "listar_registros", arguments: args });
      const text = (result.content as Array<{ text: string }>)[0].text;
      return {
        isError: Boolean(result.isError),
        text,
        data: JSON.parse(text) as {
          paciente: { id: number };
          registros: Array<{ tipo: string; data: string; secoes: unknown }>;
          proximo_cursor: string | null;
        },
      };
    };
    const history = await read({ id: duplicate.id });
    assert.equal(history.data.paciente.id, survivor.id);
    assert.deepEqual(history.data.registros.map((r) => [r.tipo, r.data]), [
      ["soap", "2026-10-28T09:00"],
      ["narrativa", "2026-10-06T09:00"],
      ["soap", "2026-10-05T09:00"],
      ["soap", "2026-09-01T09:00"], // two versions, one record
    ]);
    assert.deepEqual(history.data.registros[1].secoes, [{ titulo: "Telefonema", texto: "Falou com [CONTATO] sobre exames." }]);
    assert.deepEqual((history.data.registros[2].secoes as Record<string, string>).S, "[PACIENTE] relata dor. A mãe [CONTATO] veio. CPF [REMOVIDO]. Ligou a [PACIENTE].");
    // title ("... note for <name>"), composer and the names of patient, merged cadastro and contact never leave
    assert.doesNotMatch(history.text, new RegExp(`marina|almeida|duplicada|rosalva|${TAG}|123\\.456|note for|Dr `, "i"));

    // filters and paging reach the database query
    assert.deepEqual((await read({ id: survivor.id, tipo: "narrativa" })).data.registros.map((r) => r.tipo), ["narrativa"]);
    assert.deepEqual((await read({ id: survivor.id, desde: "2026-10-05", ate: "2026-10-06" })).data.registros.map((r) => r.data), ["2026-10-06T09:00", "2026-10-05T09:00"]);
    const firstPage = await read({ id: survivor.id, limite: 3 });
    assert.equal(firstPage.data.registros.length, 3);
    assert.ok(firstPage.data.proximo_cursor);
    const secondPage = await read({ id: survivor.id, limite: 3, cursor: firstPage.data.proximo_cursor });
    assert.deepEqual(secondPage.data.registros.map((r) => r.data), ["2026-09-01T09:00"]);
    assert.equal(secondPage.data.proximo_cursor, null);
    assert.equal((await client.callTool({ name: "listar_registros", arguments: { id: inactive.id } })).isError, true);

    // notes at the same instant are paged by id: none repeated, none skipped
    const tied = await make(`Empate ${TAG}`, "2000-01-01");
    for (const subjective of ["um", "dois", "tres"]) {
      await createSoapComposition({
        assessment: "A", authorUserId: user.id, encounteredAt: new Date("2026-10-07T12:00:00Z"), objective: "O", patientId: tied.id, plan: "P", subjective,
      });
    }
    const tiedSeen: string[] = [];
    let tiedCursor: string | undefined;
    for (let page = 0; page < 5; page += 1) {
      const { data } = await read({ id: tied.id, limite: 1, ...(tiedCursor ? { cursor: tiedCursor } : {}) });
      tiedSeen.push(...data.registros.map((r) => (r as unknown as { registro_id: string }).registro_id));
      tiedCursor = data.proximo_cursor ?? undefined;
      if (!tiedCursor) break;
    }
    assert.equal(tiedSeen.length, 3);
    assert.equal(new Set(tiedSeen).size, 3);

    // listar_agenda: the day in the clinic's zone; a merged cadastro answers as the survivor; an inactive one is null
    const book = async (patientId: number, start: string) => {
      const row = await prisma.appointment.create({
        data: { patientId, start: new Date(start), end: new Date(new Date(start).getTime() + 30 * 60_000), status: "booked", appointmentType: "routine" },
      });
      return row.id;
    };
    const mine = [
      await book(survivor.id, "2030-03-05T03:00:00Z"), // exactly 00:00 local: in
      await book(survivor.id, "2030-03-05T12:00:00Z"),
      await book(inactive.id, "2030-03-05T14:00:00Z"),
      await book(duplicate.id, "2030-03-05T15:00:00Z"),
    ];
    await book(survivor.id, "2030-03-06T03:00:00Z"); // 00:00 of the next local day: out
    const agendaResult = await client.callTool({ name: "listar_agenda", arguments: { data: "2030-03-05" } });
    const agendaText = (agendaResult.content as Array<{ text: string }>)[0].text;
    const consultas = (JSON.parse(agendaText) as { consultas: Array<{ consulta_id: number; inicio: string; status: string; confirmacao: string; paciente: { id: number } | null }> }).consultas.filter((c) => mine.includes(c.consulta_id));
    assert.deepEqual(consultas.map((c) => [c.inicio, c.paciente?.id ?? null, c.status, c.confirmacao]), [
      ["2030-03-05T00:00", survivor.id, "booked", "pending"],
      ["2030-03-05T09:00", survivor.id, "booked", "pending"],
      ["2030-03-05T11:00", null, "booked", "pending"],
      ["2030-03-05T12:00", survivor.id, "booked", "pending"],
    ]);
    assert.doesNotMatch(agendaText, new RegExp(`marina|almeida|duplicada|${TAG}`, "i"));

    // rehydration: only a report (or full) token; the answer has the names, so the agent token must not reach it
    const rehydrate = async (token: string | null, texto: string) => {
      const request = new Request("http://ehr.test/api/agent/rehydrate", {
        method: "POST",
        headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({ texto }),
      });
      try {
        return await rehydrateRoute.action({ request });
      } catch (thrown) {
        if (thrown instanceof Response) {
          return thrown;
        }
        throw thrown;
      }
    };
    const report = `Hoje: @P${survivor.id}, @P${duplicate.id}, @P${inactive.id} e @P${tied.id}.`;
    const delivered = await rehydrate(tokens.report, report);
    assert.equal(delivered.status, 200);
    assert.equal(delivered.headers.get("cache-control"), "no-store");
    assert.deepEqual(await delivered.json(), {
      texto: `Hoje: Marina ${TAG} Almeida (42 anos), Marina ${TAG} Almeida (42 anos), @P${inactive.id} [não encontrado] e Empate ${TAG} (26 anos).`,
      mencoes: 3, // the merged cadastro answers as its survivor
      nao_encontradas: [inactive.id],
    });
    assert.equal((await rehydrate(tokens.full, report)).status, 200);
    for (const refused of [tokens.agent, tokens.reminders, null]) {
      assert.equal((await rehydrate(refused, report)).status, 401);
    }

    // audit rows: counts and ids only
    const rehydrateAudits = await prisma.auditLog.findMany({ where: { userId: user.id, action: "agent.rehydrate" } });
    assert.equal(rehydrateAudits.length, 2); // the report token and the full token; refused calls leave no row
    const meta = rehydrateAudits[0].metadata as { characters: number; mentions: number; notFound: number; tokenId: number };
    assert.deepEqual([meta.characters, meta.mentions, meta.notFound, typeof meta.tokenId], [report.length, 3, 1, "number"]);
    assert.doesNotMatch(JSON.stringify(rehydrateAudits), new RegExp(`marina|almeida|${TAG}|@P`, "i"));

    const audits = await prisma.auditLog.findMany({ where: { userId: user.id, category: "mcp" } });
    assert.ok(audits.length >= 5);
    assert.ok(audits.every((row) => /^mcp\.tool\.(localizar_paciente|listar_registros|listar_agenda)$/.test(row.action)));
    assert.ok(audits.some((row) => row.action === "mcp.tool.listar_registros" && row.entityId === String(survivor.id)));
    assert.ok(audits.some((row) => row.action === "mcp.tool.listar_agenda"));
    assert.doesNotMatch(JSON.stringify(audits), new RegExp(`marina|almeida|duplicada|rosalva|${TAG}|relata dor`, "i"));

    // scope rules of the real token check, on the reminder endpoint guard
    const asRequest = (token: string) => new Request("http://ehr.test/x", { headers: { Authorization: `Bearer ${token}` } });
    for (const scope of ["full", "reminders", "report"] as const) {
      assert.ok(await requireApiScope(asRequest(tokens[scope]), "reminders"), `${scope} reaches reminders`);
    }
    await assert.rejects(requireApiScope(asRequest(tokens.agent), "reminders"), (e) => e instanceof Response && e.status === 401);
    await assert.rejects(requireApiScope(asRequest(tokens.report), "full"), (e) => e instanceof Response && e.status === 401);
    await assert.rejects(requireApiScope(asRequest(tokens.full), "agent"), (e) => e instanceof Response && e.status === 401);
  } finally {
    await prisma.appointment.deleteMany({ where: { patientId: { in: patientIds } } });
    await prisma.contact.deleteMany({ where: { patientId: { in: patientIds } } });
    await prisma.auditLog.deleteMany({ where: { userId: user.id } });
    await prisma.authToken.deleteMany({ where: { userId: user.id } });
    await prisma.compositionVersion.deleteMany({ where: { composerUserId: user.id } });
    await prisma.versionedComposition.deleteMany({ where: { ehr: { patientId: { in: patientIds } } } });
    await prisma.contribution.deleteMany({ where: { committerUserId: user.id } });
    await prisma.ehrRecord.deleteMany({ where: { patientId: { in: patientIds } } });
    await prisma.patient.updateMany({ where: { id: { in: patientIds } }, data: { mergedIntoPatientId: null } });
    await prisma.patient.deleteMany({ where: { id: { in: patientIds } } });
    await prisma.authUser.delete({ where: { id: user.id } });
    await prisma.$disconnect();
  }
});
