/**
 * `localizar_paciente`: turns an id or a name into the agent's identity of a patient.
 *
 * The name (and the birth date) go IN, because the clinician types them to the agent; they never
 * come back out. The answer is built field by field in `toCandidate`, so a new column on the
 * patient can never leak by being spread into the response.
 */
import { z } from "zod";

import { agentAge, agentInitials, agentMention } from "../../privacy/agent-identity";

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

function isRealDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export const locatePatientShape = {
  id: z.number().int().positive().optional().describe("Id do paciente (o número de @P<id>)."),
  nome: z.string().trim().min(3).max(100).optional().describe("Nome, completo ou parcial, com tolerância a erros de digitação."),
  nascimento: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .refine(isRealDate, "Data inexistente.")
    .optional()
    .describe("Data de nascimento AAAA-MM-DD, para separar homônimos. Só junto com `nome`."),
  limite: z.number().int().min(1).max(MAX_CANDIDATES).default(DEFAULT_CANDIDATES).describe("Máximo de candidatos (1 a 10)."),
};

export const LOCATE_PATIENT_DESCRIPTION =
  "Localiza pacientes por `id` ou por `nome` (aproximado) e devolve só: id, menção @P<id>, iniciais, idade, sexo, " +
  "total de registros e data do último registro. Nunca devolve o nome. Informe `id` OU `nome`; use `nascimento` " +
  "(AAAA-MM-DD) com `nome` para desambiguar. Até 10 candidatos, os mais parecidos primeiro; `ambiguo` é verdadeiro " +
  "quando há mais de um.";

export class LocateInputError extends Error {}

type Input = { id?: number; nome?: string; nascimento?: string; limite: number };

export type LocateResult = {
  candidatos: Array<{
    id: number;
    mencao: string;
    iniciais: string;
    idade: string | null;
    sexo: string;
    total_registros: number;
    ultimo_registro: string | null;
  }>;
  ambiguo: boolean;
};

function toCandidate(patient: LookupPatient, now: Date): LocateResult["candidatos"][number] {
  return {
    id: patient.id,
    mencao: agentMention(patient.id),
    iniciais: agentInitials(patient.name),
    idade: agentAge(patient.birthDate, { now }),
    sexo: patient.gender,
    total_registros: patient.recordCount,
    ultimo_registro: patient.lastRecordAt ? patient.lastRecordAt.toISOString() : null,
  };
}

export async function locatePatient(input: Input, repo: PatientLookupRepo, now: Date): Promise<LocateResult> {
  const hasId = input.id !== undefined;
  const hasName = input.nome !== undefined;

  if (hasId === hasName) {
    throw new LocateInputError("Informe `id` ou `nome` (exatamente um dos dois).");
  }
  if (input.nascimento && !hasName) {
    throw new LocateInputError("`nascimento` só vale junto com `nome`.");
  }

  const found = hasId
    ? [await repo.findById(input.id as number)].filter((patient): patient is LookupPatient => patient !== null)
    : await repo.searchByName(input.nome as string, { birthDate: input.nascimento, limit: input.limite });

  const candidatos = found.slice(0, input.limite).map((patient) => toCandidate(patient, now));
  return { candidatos, ambiguo: candidatos.length > 1 };
}
