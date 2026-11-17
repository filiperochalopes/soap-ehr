/**
 * `localizar_paciente`: turns an id or a name into the agent's identity of a patient.
 *
 * The name (and the birth date) go IN, because the clinician types them to the agent; they never
 * come back out. The answer is built field by field in `toCandidate`, so a new column on the
 * patient can never leak by being spread into the response.
 */
import { z } from "zod";

import { toAgentPatient } from "../../privacy/agent-identity";
import { ToolInputError, dateString, localDateTime } from "../shared";

export const MAX_CANDIDATES = 10;
const DEFAULT_CANDIDATES = 5;

/** What the lookup reads about a patient. The name is used for the initials only. */
export type LookupPatient = {
  id: number;
  name: string;
  gender: string;
  birthDate: Date | null;
  recordCount: number;
  lastRecordAt: Date | null;
};

export type PatientLookupRepo = {
  /** The patient a cadastro was merged into (or itself); null when unknown or inactive. */
  findById: (id: number) => Promise<LookupPatient | null>;
  /** Active patients by approximate name, closest first, optionally with this exact birth date (YYYY-MM-DD). */
  searchByName: (name: string, options: { birthDate?: string; limit: number }) => Promise<LookupPatient[]>;
};

export const locatePatientShape = {
  id: z.number().int().positive().optional().describe("Id do paciente (o número de @P<id>)."),
  nome: z.string().trim().min(3).max(100).optional().describe("Nome, completo ou parcial, com tolerância a erros de digitação."),
  nascimento: dateString.optional().describe("Data de nascimento AAAA-MM-DD, para separar homônimos. Só junto com `nome`."),
  limite: z.number().int().min(1).max(MAX_CANDIDATES).default(DEFAULT_CANDIDATES).describe("Máximo de candidatos (1 a 10)."),
};

export const LOCATE_PATIENT_DESCRIPTION =
  "Localiza pacientes por `id` ou por `nome` (aproximado) e devolve só: id, menção @P<id>, iniciais, idade, sexo, " +
  "total de registros e data/hora do último registro (horário local, ver `fuso`). Nunca devolve o nome. Informe `id` " +
  "OU `nome`; use `nascimento` (AAAA-MM-DD) com `nome` para desambiguar. Até 10 candidatos, os mais parecidos " +
  "primeiro; `ambiguo` é verdadeiro quando há mais de um.";



type Input = { id?: number; nome?: string; nascimento?: string; limite: number };

export type AgentPatientWithHistory = ReturnType<typeof toAgentPatient> & {
  total_registros: number;
  ultimo_registro: string | null;
};

export type LocateResult = {
  fuso: string;
  candidatos: AgentPatientWithHistory[];
  ambiguo: boolean;
};

/** A patient as the agent sees it, plus how much history there is and when it last changed. */
export function toAgentPatientWithHistory(patient: LookupPatient, now: Date, timeZone: string): AgentPatientWithHistory {
  return {
    ...toAgentPatient(patient, { now }),
    total_registros: patient.recordCount,
    ultimo_registro: localDateTime(patient.lastRecordAt, timeZone),
  };
}

export async function locatePatient(
  input: Input,
  repo: PatientLookupRepo,
  context: { now: Date; timeZone: string },
): Promise<LocateResult> {
  const hasId = input.id !== undefined;
  const hasName = input.nome !== undefined;

  if (hasId === hasName) {
    throw new ToolInputError("Informe `id` ou `nome` (exatamente um dos dois).");
  }
  if (input.nascimento && !hasName) {
    throw new ToolInputError("`nascimento` só vale junto com `nome`.");
  }

  const found = hasId
    ? [await repo.findById(input.id as number)].filter((patient): patient is LookupPatient => patient !== null)
    : await repo.searchByName(input.nome as string, { birthDate: input.nascimento, limit: input.limite });

  const candidatos = found
    .slice(0, input.limite)
    .map((patient) => toAgentPatientWithHistory(patient, context.now, context.timeZone));
  return { fuso: context.timeZone, candidatos, ambiguo: candidatos.length > 1 };
}
