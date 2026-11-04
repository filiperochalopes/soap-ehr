import type { Patient, Prisma, PrismaClient } from "@prisma/client";

import { writeAuditLog } from "~/lib/audit.server";
import { env } from "~/lib/env.server";
import { rankByName } from "~/lib/patient-name-match";
import { prisma } from "~/lib/prisma.server";
import type { PatientInput } from "~/lib/validation/patients";

type PatientClient = PrismaClient | Prisma.TransactionClient;
type ImportedPatientMatch = Prisma.PatientGetPayload<{
  include: {
    contacts: true;
    identifier: true;
    telecom: true;
  };
}>;

export const PATIENT_DUPLICATE_IDENTITY_MESSAGE =
  "A patient with this name and birth date already exists.";

function identifierDigits(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Ids of the active patients that match `query`, closest first (see patient-name-match.ts).
 * It reads only id, name and, with `matchIdentifier`, the identifier values: the registry is small
 * and the ranking rule lives in the app, not in SQL. An identifier matches when the letters and
 * digits of the search are contained in those of the identifier ("123.456.789-00" finds
 * "12345678900"); identifier-only matches come after the name matches.
 */
export async function searchActivePatientIds(
  query: string,
  options: { excludeId?: number; matchIdentifier?: boolean } = {},
) {
  const wantedIdentifier = options.matchIdentifier ? identifierDigits(query) : "";
  const patients: Array<{ id: number; name: string; identifier?: Array<{ value: string }> }> =
    await prisma.patient.findMany({
      where: { active: true, ...(options.excludeId ? { id: { not: options.excludeId } } : {}) },
      select: {
        id: true,
        identifier: wantedIdentifier ? { select: { value: true } } : false,
        name: true,
      },
      orderBy: { id: "asc" },
    });

  return rankByName(query, patients, (patient) => patient.name, {
    maxEdits: env.PATIENT_SEARCH_MAX_EDITS,
    alsoInclude: (patient) =>
      Boolean(wantedIdentifier) &&
      Boolean(patient.identifier?.some((identifier) => identifierDigits(identifier.value).includes(wantedIdentifier))),
  }).map((match) => match.item.id);
}

/** Puts rows loaded with `id: { in }` back in the order of `ids`. */
export function sortByIdOrder<T extends { id: number }>(ids: number[], rows: T[]) {
  const position = new Map(ids.map((id, index) => [id, index]));
  return [...rows].sort((left, right) => (position.get(left.id) ?? 0) - (position.get(right.id) ?? 0));
}

function patientNestedWrite(input: PatientInput) {
  return {
    birthDate: input.birthDate,
    contacts: {
      create: input.contacts.map((contact) => ({
        name: contact.name,
        relationship: contact.relationship,
      })),
    },
    gender: input.gender,
    isDraft: input.isDraft || !input.birthDate,
    identifier: {
      create: input.identifiers.map((identifier) => ({
        system: identifier.system,
        value: identifier.value,
      })),
    },
    name: input.name,
    telecom: {
      create: input.telecom.map((contactPoint) => ({
        system: contactPoint.system,
        value: contactPoint.value,
      })),
    },
  };
}

async function resolveCurrentPatient(patientId: number, db: PatientClient = prisma) {
  const visitedIds = new Set<number>();
  let currentPatientId = patientId;

  while (true) {
    if (visitedIds.has(currentPatientId)) {
      throw new Error("Circular patient merge link detected.");
    }

    visitedIds.add(currentPatientId);
    const patient = await db.patient.findUnique({
      where: { id: currentPatientId },
    });

    if (!patient || !patient.mergedIntoPatientId) {
      return patient;
    }

    currentPatientId = patient.mergedIntoPatientId;
  }
}

async function loadPatientForImport(patientId: number) {
  return prisma.patient.findUnique({
    where: { id: patientId },
    include: {
      contacts: true,
      identifier: true,
      telecom: true,
    },
  });
}

function normalizeDateOnly(date: Date | null | undefined) {
  return date ? date.toISOString().slice(0, 10) : "";
}

function normalizeTupleSet<T>(items: T[], serialize: (item: T) => string) {
  return [...items]
    .map(serialize)
    .sort((left, right) => left.localeCompare(right));
}

function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function hasEverySerializedItem(existing: string[], incoming: string[]) {
  const existingSet = new Set(existing);
  return incoming.every((value) => existingSet.has(value));
}

async function identifiersWouldChange(
  existing: ImportedPatientMatch,
  incomingIdentifiers: Array<{ system: string; value: string }>,
) {
  const existingIdentifiers = normalizeTupleSet(
    existing.identifier,
    (identifier) => `${identifier.system}\u0000${identifier.value}`,
  );
  const incomingIdentifierKeys = normalizeTupleSet(
    incomingIdentifiers,
    (identifier) => `${identifier.system}\u0000${identifier.value}`,
  );
  const missingIdentifierKeys = incomingIdentifierKeys.filter(
    (identifierKey) => !new Set(existingIdentifiers).has(identifierKey),
  );

  if (!missingIdentifierKeys.length) {
    return false;
  }

  const globallyClaimedIdentifiers = await prisma.identifier.findMany({
    where: {
      NOT: { patientId: existing.id },
      OR: missingIdentifierKeys.map((identifierKey) => {
        const [system, value] = identifierKey.split("\u0000");
        return { system, value };
      }),
    },
    select: {
      system: true,
      value: true,
    },
  });

  const globallyClaimedIdentifierKeys = new Set(
    globallyClaimedIdentifiers.map((identifier) => `${identifier.system}\u0000${identifier.value}`),
  );

  return missingIdentifierKeys.some(
    (identifierKey) => !globallyClaimedIdentifierKeys.has(identifierKey),
  );
}

async function patientImportWouldChange(
  existing: ImportedPatientMatch,
  input: Omit<PatientInput, "contacts" | "identifiers" | "telecom"> & {
    contacts: Array<{ name: string; relationship: string }>;
    identifiers: Array<{ system: string; value: string }>;
    telecom: Array<{ system: string; value: string }>;
  },
) {
  const nextBirthDate = input.birthDate ?? existing.birthDate;
  const nextIsDraft = input.birthDate ? input.isDraft : existing.isDraft;

  if (normalizeDateOnly(existing.birthDate) !== normalizeDateOnly(nextBirthDate)) {
    return true;
  }

  if (existing.gender !== input.gender) {
    return true;
  }

  if (existing.isDraft !== nextIsDraft) {
    return true;
  }

  if (existing.name !== input.name) {
    return true;
  }

  if (await identifiersWouldChange(existing, input.identifiers)) {
    return true;
  }

  const existingTelecom = normalizeTupleSet(
    existing.telecom,
    (contactPoint) => `${contactPoint.system}\u0000${contactPoint.value}`,
  );
  const incomingTelecom = normalizeTupleSet(
    input.telecom,
    (contactPoint) => `${contactPoint.system}\u0000${contactPoint.value}`,
  );

  if (!hasEverySerializedItem(existingTelecom, incomingTelecom)) {
    return true;
  }

  const existingContacts = normalizeTupleSet(
    existing.contacts,
    (contact) => `${contact.name}\u0000${contact.relationship}`,
  );
  const incomingContacts = normalizeTupleSet(
    input.contacts,
    (contact) => `${contact.name}\u0000${contact.relationship}`,
  );

  return !arraysEqual(existingContacts, incomingContacts);
}

function assertPatientCanBeEdited(patient: Pick<Patient, "active" | "mergedIntoPatientId">) {
  if (!patient.active && patient.mergedIntoPatientId) {
    throw new Error("Cannot update a merged patient. Use the surviving record.");
  }
}

async function assertPatientNameBirthDateIsUnique(
  input: Pick<PatientInput, "birthDate" | "name">,
  db: PatientClient,
  patientId?: number,
) {
  if (!input.birthDate) {
    return;
  }

  const duplicate = await db.patient.findFirst({
    where: {
      active: true,
      birthDate: input.birthDate,
      name: input.name,
      ...(patientId ? { id: { not: patientId } } : {}),
    },
    select: {
      id: true,
    },
  });

  if (duplicate) {
    throw new Error(PATIENT_DUPLICATE_IDENTITY_MESSAGE);
  }
}

export async function savePatient(
  input: PatientInput,
  actorUserId: number,
  patientId?: number,
  options?: { active?: boolean },
) {
  return prisma.$transaction(async (tx) => {
    let nextActive = options?.active ?? true;

    if (patientId) {
      const existingPatient = await tx.patient.findUnique({
        where: { id: patientId },
        select: {
          active: true,
          mergedIntoPatientId: true,
        },
      });

      if (existingPatient) {
        assertPatientCanBeEdited(existingPatient);
        nextActive = options?.active ?? existingPatient.active;
      }
    }

    if (nextActive) {
      await assertPatientNameBirthDateIsUnique(input, tx, patientId);
    }

    const patient = patientId
      ? await tx.patient.update({
          where: { id: patientId },
          data: {
            ...(typeof options?.active === "boolean" ? { active: options.active } : {}),
            birthDate: input.birthDate,
            contacts: {
              deleteMany: {},
              create: input.contacts,
            },
            gender: input.gender,
            isDraft: input.isDraft || !input.birthDate,
            identifier: {
              deleteMany: {},
              create: input.identifiers,
            },
            name: input.name,
            telecom: {
              deleteMany: {},
              create: input.telecom,
            },
          },
          include: {
            contacts: true,
            identifier: true,
            mergedInto: {
              select: {
                id: true,
              },
            },
            replaces: {
              select: {
                id: true,
              },
            },
            telecom: true,
          },
        })
      : await tx.patient.create({
          data: {
            active: options?.active ?? true,
            ...patientNestedWrite(input),
          },
          include: {
            contacts: true,
            identifier: true,
            mergedInto: {
              select: {
                id: true,
              },
            },
            replaces: {
              select: {
                id: true,
              },
            },
            telecom: true,
          },
        });

    await writeAuditLog(tx, {
      action: patientId ? "patient.updated" : "patient.created",
      category: "patient",
      entityId: String(patient.id),
      entityType: "Patient",
      metadata: {
        name: patient.name,
      } satisfies Prisma.JsonObject,
      userId: actorUserId,
    });

    return patient;
  });
}

export async function findPatientForImport(args: {
  birthDate: Date | null;
  externalId?: string;
  identifiers: Array<{ system: string; value: string }>;
  isDraft: boolean;
  name: string;
  sourceSystem: string;
}) {
  if (args.externalId) {
    const externalIdentifier = await prisma.identifier.findUnique({
      where: {
        system_value: {
          system: `external:${args.sourceSystem}`,
          value: args.externalId,
        },
      },
      include: { patient: true },
    });

    if (externalIdentifier?.patient) {
      const current = await resolveCurrentPatient(externalIdentifier.patient.id);
      return current ? loadPatientForImport(current.id) : null;
    }
  }

  for (const identifier of args.identifiers) {
    const existing = await prisma.identifier.findUnique({
      where: {
        system_value: {
          system: identifier.system,
          value: identifier.value,
        },
      },
      include: { patient: true },
    });

    if (existing?.patient) {
      const current = await resolveCurrentPatient(existing.patient.id);
      return current ? loadPatientForImport(current.id) : null;
    }
  }

  return prisma.patient.findFirst({
    where: {
      active: true,
      birthDate: args.birthDate,
      ...(args.birthDate ? {} : { isDraft: args.isDraft }),
      name: args.name,
    },
    orderBy: [
      { isDraft: "asc" },
      { updatedAt: "desc" },
    ],
    include: {
      contacts: true,
      identifier: true,
      telecom: true,
    },
  });
}

export async function upsertImportedPatient(args: {
  actorUserId: number | null;
  input: Omit<PatientInput, "contacts" | "identifiers" | "telecom"> & {
    contacts: Array<{ name: string; relationship: string }>;
    externalId?: string;
    identifiers: Array<{ system: string; value: string }>;
    telecom: Array<{ system: string; value: string }>;
  };
  sourceSystem: string;
}) {
  const existing = await findPatientForImport({
    birthDate: args.input.birthDate,
    externalId: args.input.externalId,
    identifiers: args.input.identifiers,
    isDraft: args.input.isDraft || !args.input.birthDate,
    name: args.input.name,
    sourceSystem: args.sourceSystem,
  });

  const identifiers = [
    ...args.input.identifiers,
    ...(args.input.externalId
      ? [{ system: `external:${args.sourceSystem}`, value: args.input.externalId }]
      : []),
  ];

  if (!existing) {
    const created = await prisma.patient.create({
      data: {
        birthDate: args.input.birthDate,
        contacts: {
          create: args.input.contacts,
        },
        gender: args.input.gender,
        isDraft: args.input.isDraft || !args.input.birthDate,
        identifier: {
          create: identifiers,
        },
        name: args.input.name,
        telecom: {
          create: args.input.telecom,
        },
      },
      include: {
        contacts: true,
        identifier: true,
        telecom: true,
      },
    });

    await writeAuditLog(prisma, {
      action: "patient.import.created",
      category: "import",
      entityId: String(created.id),
      entityType: "Patient",
      userId: args.actorUserId,
    });

    return { patient: created, status: "created" as const };
  }

  if (
    existing &&
    !(await patientImportWouldChange(existing, {
      ...args.input,
      identifiers,
      telecom: args.input.telecom,
    }))
  ) {
    return { patient: existing, status: "skipped" as const };
  }

  const updated = await prisma.patient.update({
    where: { id: existing.id },
    data: {
      birthDate: args.input.birthDate ?? undefined,
      contacts: {
        deleteMany: {},
        create: args.input.contacts,
      },
      gender: args.input.gender,
      isDraft: args.input.birthDate ? args.input.isDraft : existing.isDraft,
      name: args.input.name,
      identifier: identifiers.length
        ? {
            createMany: {
              data: identifiers,
              skipDuplicates: true,
            },
          }
        : undefined,
      telecom: args.input.telecom.length
        ? {
            createMany: {
              data: args.input.telecom,
              skipDuplicates: true,
            },
          }
        : undefined,
    },
    include: {
      contacts: true,
      identifier: true,
      telecom: true,
    },
  });

  await writeAuditLog(prisma, {
    action: "patient.import.updated",
    category: "import",
    entityId: String(updated.id),
    entityType: "Patient",
    userId: args.actorUserId,
  });

  return { patient: updated, status: "updated" as const };
}

export async function mergePatientRecords(args: {
  actorUserId: number;
  sourcePatientId: number;
  targetPatientId: number;
}) {
  if (args.sourcePatientId === args.targetPatientId) {
    throw new Error("Select a different patient as the merge target.");
  }

  return prisma.$transaction(async (tx) => {
    const [sourcePatient, targetPatient] = await Promise.all([
      tx.patient.findUnique({
        where: { id: args.sourcePatientId },
        select: {
          active: true,
          id: true,
          mergedIntoPatientId: true,
          name: true,
        },
      }),
      tx.patient.findUnique({
        where: { id: args.targetPatientId },
        select: {
          active: true,
          id: true,
          mergedIntoPatientId: true,
          name: true,
        },
      }),
    ]);

    if (!sourcePatient || !targetPatient) {
      throw new Error("Patient not found.");
    }

    if (!sourcePatient.active && sourcePatient.mergedIntoPatientId) {
      throw new Error("This patient has already been merged into another record.");
    }

    if (!targetPatient.active || targetPatient.mergedIntoPatientId) {
      throw new Error("The selected merge target is inactive.");
    }

    const redirectedPatients = await tx.patient.updateMany({
      where: {
        mergedIntoPatientId: sourcePatient.id,
      },
      data: {
        mergedIntoPatientId: targetPatient.id,
      },
    });

    await tx.patient.update({
      where: { id: sourcePatient.id },
      data: {
        active: false,
        mergedIntoPatientId: targetPatient.id,
      },
    });

    await writeAuditLog(tx, {
      action: "patient.merged",
      category: "patient",
      entityId: String(sourcePatient.id),
      entityType: "Patient",
      metadata: {
        redirectedMergedPatients: redirectedPatients.count,
        sourcePatientId: sourcePatient.id,
        sourcePatientName: sourcePatient.name,
        targetPatientId: targetPatient.id,
        targetPatientName: targetPatient.name,
      } satisfies Prisma.JsonObject,
      userId: args.actorUserId,
    });

    return {
      redirectedMergedPatients: redirectedPatients.count,
      sourcePatient,
      targetPatient,
    };
  });
}
