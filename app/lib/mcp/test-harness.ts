/**
 * Shared harness for the MCP tests: a real MCP client talking to `handleMcpRequest` in-process,
 * with fake repositories that follow the same contract as the Prisma ones.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { handleMcpRequest, type McpAuditEntry, type McpRequestDeps } from "./handler.server";
import type { AgendaAppointment } from "./tools/listar-agenda";
import type { RecordSource, RecordsRepo } from "./tools/listar-registros";
import type { LookupPatient, PatientLookupRepo } from "./tools/localizar-paciente";

export const NOW = new Date("2026-11-12T15:00:00Z");
export const TOKEN = "agent-token-ok";
export const TZ = "America/Sao_Paulo";

export const MARINA: LookupPatient = {
  id: 42,
  name: "Marina Almeida",
  gender: "female",
  birthDate: new Date("1984-08-14"),
  recordCount: 7,
  lastRecordAt: new Date("2026-10-28T12:00:00Z"),
};
export const HOMONYM: LookupPatient = { ...MARINA, id: 99, birthDate: new Date("1990-03-02"), recordCount: 1 };
export const INFANT: LookupPatient = {
  id: 7,
  name: "Bento Rocha",
  gender: "male",
  birthDate: new Date("2026-04-20"),
  recordCount: 0,
  lastRecordAt: null,
};

function fakeLookup(people: LookupPatient[]): PatientLookupRepo {
  return {
    findById: async (id) => people.find((person) => person.id === id) ?? null,
    searchByName: async (name, { birthDate, limit }) =>
      people
        .filter((person) => person.name.toLowerCase().includes(name.toLowerCase()))
        .filter((person) => !birthDate || person.birthDate?.toISOString().slice(0, 10) === birthDate)
        .slice(0, limit),
  };
}

/** Same contract as the Prisma repository: newest first, filtered, strictly after the cursor position. */
function fakeRecords(rows: Array<RecordSource & { patientId: number }>, names: Record<number, { patientName: string[]; contactNames: string[] }>): RecordsRepo {
  return {
    names: async (patientId) => names[patientId] ?? { patientName: [], contactNames: [] },
    list: async (patientId, { kind, from, to, after, limit }) =>
      rows
        .filter((row) => row.patientId === patientId)
        .filter((row) => !kind || row.kind === kind)
        .filter((row) => !from || row.encounteredAt >= from)
        .filter((row) => !to || row.encounteredAt <= to)
        .sort((a, b) => b.encounteredAt.getTime() - a.encounteredAt.getTime() || (a.id < b.id ? 1 : -1))
        .filter(
          (row) =>
            !after ||
            row.encounteredAt < after.encounteredAt ||
            (row.encounteredAt.getTime() === after.encounteredAt.getTime() && row.id < after.id),
        )
        .slice(0, limit),
  };
}

export type Fixtures = {
  people?: LookupPatient[];
  records?: Array<RecordSource & { patientId: number }>;
  names?: Record<number, { patientName: string[]; contactNames: string[] }>;
  appointments?: AgendaAppointment[];
};

export function setup({ people = [MARINA, HOMONYM, INFANT], records = [], names = {}, appointments = [] }: Fixtures = {}) {
  const audits: McpAuditEntry[] = [];
  const deps: McpRequestDeps = {
    authenticate: async (request) => {
      if (request.headers.get("authorization") !== `Bearer ${TOKEN}`) {
        throw new Response(null, { status: 401 });
      }
      return { tokenId: 7, user: { id: 1 } };
    },
    audit: async (entry) => {
      audits.push(entry);
    },
    lookup: fakeLookup(people),
    records: fakeRecords(records, names),
    agenda: {
      appointmentsBetween: async (start, end) =>
        appointments.filter((appointment) => appointment.start >= start && appointment.start <= end).sort((a, b) => a.start.getTime() - b.start.getTime()),
    },
    timeZone: async () => TZ,
    now: () => NOW,
  };
  return { audits, deps };
}

export async function connect(deps: McpRequestDeps, token = TOKEN) {
  const transport = new StreamableHTTPClientTransport(new URL("http://ehr.test/mcp"), {
    fetch: (url, init) => handleMcpRequest(new Request(url, init), deps),
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
  return client;
}

/** Calls a tool and returns the raw text plus the parsed JSON (null when the tool reported an error). */
export async function callTool<T = unknown>(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  return { isError: Boolean(result.isError), text, data: result.isError ? null : (JSON.parse(text) as T) };
}

/** True when the call is refused, whether as a tool error or as a protocol error. */
export async function fails(client: Client, name: string, args: Record<string, unknown>) {
  try {
    return (await callTool(client, name, args)).isError;
  } catch {
    return true;
  }
}
