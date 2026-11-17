/**
 * The real (Prisma) side of `listar_registros` and `listar_agenda`.
 *
 * Notes are read with an explicit `select` of id, template, date and content only, so the title
 * (which carries the patient's name), the composer and the source ids are never even loaded.
 */
import type { Prisma } from "@prisma/client";

import { compositionNarrativeSections, compositionSchema } from "~/lib/ehr/rm";
import { SOAP_NODE_IDS, SOAP_TEMPLATE_ID } from "~/lib/ehr/templates/soap";
import { patientAndMergedIds } from "~/lib/mcp/patient-lookup.server";
import type { AgendaRepo } from "~/lib/mcp/tools/listar-agenda";
import type { RecordSource, RecordsRepo } from "~/lib/mcp/tools/listar-registros";
import { prisma } from "~/lib/prisma.server";

function toRecordSource(version: { id: string; templateId: string; encounteredAt: Date; content: Prisma.JsonValue }): RecordSource {
  const sections = compositionNarrativeSections(compositionSchema.parse(version.content));

  if (version.templateId === SOAP_TEMPLATE_ID) {
    const text = (nodeId: string) => sections.find((section) => section.nodeId === nodeId)?.text ?? null;
    return {
      id: version.id,
      kind: "soap",
      encounteredAt: version.encounteredAt,
      soap: {
        S: text(SOAP_NODE_IDS.subjective),
        O: text(SOAP_NODE_IDS.objective),
        A: text(SOAP_NODE_IDS.assessment),
        P: text(SOAP_NODE_IDS.plan),
      },
    };
  }

  return {
    id: version.id,
    kind: "narrative",
    encounteredAt: version.encounteredAt,
    sections: sections.map((section) => ({ title: section.title, text: section.text })),
  };
}

export const prismaRecords: RecordsRepo = {
  async names(patientId) {
    const patients = await prisma.patient.findMany({
      where: { id: { in: await patientAndMergedIds(patientId) } },
      select: { name: true, contacts: { select: { name: true } } },
    });
    return {
      patientName: patients.map((patient) => patient.name),
      contactNames: patients.flatMap((patient) => patient.contacts.map((contact) => contact.name)),
    };
  },

  async list(patientId, { kind, from, to, after, limit }) {
    const and: Prisma.CompositionVersionWhereInput[] = [];
    if (kind === "soap") {
      and.push({ templateId: SOAP_TEMPLATE_ID });
    } else if (kind === "narrative") {
      and.push({ templateId: { not: SOAP_TEMPLATE_ID } });
    }
    if (from || to) {
      and.push({ encounteredAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } });
    }
    if (after) {
      and.push({
        OR: [
          { encounteredAt: { lt: after.encounteredAt } },
          { encounteredAt: after.encounteredAt, id: { lt: after.id } },
        ],
      });
    }

    const versions = await prisma.compositionVersion.findMany({
      where: {
        followingVersions: { none: {} },
        versionedComposition: { ehr: { patientId: { in: await patientAndMergedIds(patientId) } } },
        AND: and,
      },
      orderBy: [{ encounteredAt: "desc" }, { id: "desc" }],
      take: limit,
      select: { id: true, templateId: true, encounteredAt: true, content: true },
    });

    return versions.map(toRecordSource);
  },
};

export const prismaAgenda: AgendaRepo = {
  async appointmentsBetween(start, end) {
    return prisma.appointment.findMany({
      where: { start: { gte: start, lte: end } },
      orderBy: [{ start: "asc" }, { id: "asc" }],
      select: {
        id: true,
        start: true,
        end: true,
        status: true,
        appointmentType: true,
        confirmationStatus: true,
        patientId: true,
      },
    });
  },
};
