import assert from "node:assert/strict";
import test from "node:test";

import type { Prisma } from "@prisma/client";

/**
 * Integration test of the real `/mcp` route against a REAL PostgreSQL. It only runs when
 * INTEGRATION_DATABASE_URL points at a disposable database that already has the migrations
 * applied (see reminders.integration.test.ts for the docker recipe). It refuses any URL that is
 * not localhost and deletes the rows it creates.
 *
 * It covers what the fakes of mcp.http.test.ts cannot: real tokens and scopes, the merge chain,
 * the record count and the audit rows written by the route.
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
  const { createSoapComposition } = await import("~/lib/ehr/compositions.server");
  const { mergePatientRecords } = await import("~/lib/patients.server");
  const route = await import("~/routes/mcp");

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

    const make = async (name: string, birth: string, active = true) => {
      const patient = await prisma.patient.create({ data: { name, gender: "female", birthDate: new Date(birth), active } });
      patientIds.push(patient.id);
      return patient;
    };
    const survivor = await make(`Marina ${TAG} Almeida`, "1984-08-14");
    const duplicate = await make(`Marina ${TAG} Almeida Duplicada`, "1984-08-14");
    const homonym = await make(`Marina ${TAG} Almeida`, "1990-03-02");
    const inactive = await make(`Inativa ${TAG}`, "1970-01-01", false);

    const note = (patientId: number, day: string) =>
      createSoapComposition({
        assessment: "A", authorUserId: user.id, encounteredAt: new Date(day), objective: "O", patientId, plan: "P", subjective: "S",
      });
    await note(survivor.id, "2026-09-01T12:00:00Z");
    await note(duplicate.id, "2026-10-28T12:00:00Z");
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
    assert.equal(viaMerged.candidatos[0].total_registros, 2);
    assert.equal(viaMerged.candidatos[0].ultimo_registro, "2026-10-28T12:00:00.000Z");
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

    // audit rows: counts and ids only
    const audits = await prisma.auditLog.findMany({ where: { userId: user.id, category: "mcp" } });
    assert.ok(audits.length >= 5);
    assert.ok(audits.every((row) => row.action === "mcp.tool.localizar_paciente"));
    assert.doesNotMatch(JSON.stringify(audits), new RegExp(`marina|almeida|${TAG}`, "i"));

    // scope rules of the real token check, on the reminder endpoint guard
    const asRequest = (token: string) => new Request("http://ehr.test/x", { headers: { Authorization: `Bearer ${token}` } });
    for (const scope of ["full", "reminders", "report"] as const) {
      assert.ok(await requireApiScope(asRequest(tokens[scope]), "reminders"), `${scope} reaches reminders`);
    }
    await assert.rejects(requireApiScope(asRequest(tokens.agent), "reminders"), (e) => e instanceof Response && e.status === 401);
    await assert.rejects(requireApiScope(asRequest(tokens.report), "full"), (e) => e instanceof Response && e.status === 401);
    await assert.rejects(requireApiScope(asRequest(tokens.full), "agent"), (e) => e instanceof Response && e.status === 401);
  } finally {
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
