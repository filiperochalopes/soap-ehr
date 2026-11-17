/**
 * Rehydration: turns the `@P<id>` mentions an agent wrote into "Full Name (age)".
 *
 * Pure: the patient lookup is injected. It runs where the finished report is delivered, never
 * inside the agent, so the names never reach a model.
 *
 * What counts as a mention: exactly `@P` followed by an id without leading zeros, with no letter,
 * digit or underscore glued before the `@` or after the digits. That keeps `email@P42x` and
 * `@P42abc` untouched. Everything else in the text is copied as it came.
 */
import { agentAge } from "./agent-identity";

/** Different patients one text may mention. A report has a handful; a big list is an enumeration attempt. */
export const MAX_DISTINCT_MENTIONS = 100;
const MAX_PATIENT_ID = 2_147_483_647; // the database's integer limit

export class RehydrateInputError extends Error {}

export type RehydrationPatient = { name: string; birthDate: Date | string | null };

/** Finds the patient a mention points to (a merged cadastro answers as its survivor); null when unknown or inactive. */
export type RehydrationLookup = (patientId: number) => Promise<RehydrationPatient | null>;

export type RehydrationResult = {
  texto: string;
  /** Mentions replaced with a name. */
  mencoes: number;
  /** Ids that did not resolve, each listed once; their mentions stay in the text marked `[não encontrado]`. */
  nao_encontradas: number[];
};

const MENTION_RE = /(?<![\p{L}\p{N}_])@P([1-9]\d{0,9})(?![\p{L}\p{N}_])/gu;

export async function rehydrateMentions(
  text: string,
  find: RehydrationLookup,
  options?: { now?: Date | string; timeZone?: string },
): Promise<RehydrationResult> {
  const found = [...text.matchAll(MENTION_RE)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    id: Number(match[1]),
  }));

  const ids = [...new Set(found.map((mention) => mention.id))];
  if (ids.length > MAX_DISTINCT_MENTIONS) {
    throw new RehydrateInputError(`O texto cita mais de ${MAX_DISTINCT_MENTIONS} pacientes diferentes.`);
  }

  const patients = new Map<number, RehydrationPatient | null>(
    await Promise.all(
      ids.map(async (id): Promise<[number, RehydrationPatient | null]> => [id, id > MAX_PATIENT_ID ? null : await find(id)]),
    ),
  );

  let output = "";
  let cursor = 0;
  let replaced = 0;
  for (const mention of found) {
    const patient = patients.get(mention.id) ?? null;
    output += text.slice(cursor, mention.start);
    if (patient) {
      const age = agentAge(patient.birthDate, options);
      output += age ? `${patient.name} (${age})` : patient.name;
      replaced += 1;
    } else {
      output += `@P${mention.id} [não encontrado]`;
    }
    cursor = mention.end;
  }
  output += text.slice(cursor);

  return {
    texto: output,
    mencoes: replaced,
    nao_encontradas: ids.filter((id) => !patients.get(id)).sort((a, b) => a - b),
  };
}
