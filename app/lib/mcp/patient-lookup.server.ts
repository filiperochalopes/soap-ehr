/**
 * The real (Prisma) side of `localizar_paciente`. Merged cadastros resolve to the patient they were
 * merged into, and the record count and last record cover the survivor and every cadastro merged
 * into it, so the agent sees one patient with one history.
 */
import type { Prisma } from "@prisma/client";

import type { LookupPatient, PatientLookupRepo } from "~/lib/mcp/tools/localizar-paciente";
import { prisma } from "~/lib/prisma.server";
import { searchActivePatientIds, sortByIdOrder } from "~/lib/patients.server";

const patientSelect = { id: true, name: true, gender: true, birthDate: true } satisfies Prisma.PatientSelect;

/** The patient itself plus every cadastro merged into it (directly or through other merges). */
export async function patientAndMergedIds(patientId: number): Promise<number[]> {
  const seen = new Set<number>([patientId]);
  let frontier = [patientId];

  while (frontier.length) {
    const merged = await prisma.patient.findMany({
      where: { mergedIntoPatientId: { in: frontier } },
      select: { id: true },
    });
    frontier = merged.map((patient) => patient.id).filter((id) => !seen.has(id));
    frontier.forEach((id) => seen.add(id));
  }

  return [...seen];
}

async function withRecordStats(
  patients: Array<{ id: number; name: string; gender: string; birthDate: Date | null }>,
): Promise<LookupPatient[]> {
  return Promise.all(
    patients.map(async (patient) => {
      const stats = await prisma.compositionVersion.aggregate({
        where: {
          followingVersions: { none: {} },
          versionedComposition: { ehr: { patientId: { in: await patientAndMergedIds(patient.id) } } },
        },
        _count: { _all: true },
        _max: { encounteredAt: true },
      });
      return { ...patient, recordCount: stats._count._all, lastRecordAt: stats._max.encounteredAt };
    }),
  );
}

/** The active patient a cadastro resolves to, following merges; null when unknown, inactive or circular. */
export async function findCurrentPatient(patientId: number) {
  const visited = new Set<number>();
  let currentId = patientId;

  while (!visited.has(currentId)) {
    visited.add(currentId);
    const patient = await prisma.patient.findUnique({
      where: { id: currentId },
      select: { ...patientSelect, active: true, mergedIntoPatientId: true },
    });
    if (!patient) {
      return null;
    }
    if (!patient.mergedIntoPatientId) {
      return patient.active ? patient : null;
    }
    currentId = patient.mergedIntoPatientId;
  }

  return null; // circular merge link
}

export const prismaPatientLookup: PatientLookupRepo = {
  async findById(id) {
    const patient = await findCurrentPatient(id);
    return patient ? (await withRecordStats([patient]))[0] : null;
  },

  async searchByName(name, { birthDate, limit }) {
    const ranked = await searchActivePatientIds(name);
    if (!ranked.length) {
      return [];
    }

    const rows = await prisma.patient.findMany({
      where: { id: { in: ranked }, ...(birthDate ? { birthDate: new Date(`${birthDate}T00:00:00Z`) } : {}) },
      select: patientSelect,
    });

    return withRecordStats(sortByIdOrder(ranked, rows).slice(0, limit));
  },
};
