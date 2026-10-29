import { z } from "zod";

import { saveAppointment } from "~/lib/appointments.server";
import {
  getClinicalCompositions,
  getCompositionByVersionId,
} from "~/lib/ehr/compositions.server";
import { env } from "~/lib/env.server";
import { toFhirAppointment } from "~/lib/fhir/appointment";
import {
  parseSoapClinicalImpressionFhirId,
  parseSoapConditionFhirId,
  parseSoapEncounterFhirId,
  parseSoapObservationFhirId,
  parseCompositionFhirId,
} from "~/lib/fhir/ids";
import { toFhirNarrativeComposition } from "~/lib/fhir/narrative";
import {
  toFhirClinicalImpression,
  toFhirCondition,
  toFhirComposition,
  toFhirEncounter,
  toFhirObservation,
} from "~/lib/fhir/soap";
import {
  parseFhirAppointmentResource,
  parseFhirPatientResource,
} from "~/lib/fhir/write";
import { importFhirBundle } from "~/lib/import.server";
import {
  PATIENT_DUPLICATE_IDENTITY_MESSAGE,
  savePatient,
} from "~/lib/patients.server";
import { prisma } from "~/lib/prisma.server";
import type { BundlePayload } from "~/lib/validation/import";
import type { AppointmentInput } from "~/lib/validation/appointments";
import type { PatientInput } from "~/lib/validation/patients";
import { endOfDay, startOfDay } from "~/lib/utils";
import { toFhirPatient } from "~/lib/fhir/patient";

export type FhirResource = Record<string, unknown> & {
  id: string;
  resourceType: string;
};

type FhirResourceInput = Record<string, unknown> & {
  id?: string;
  resourceType: string;
};

export type ImportSummary = {
  created: number;
  errors: Array<{ item: string; message: string }>;
  processed: number;
  skipped: number;
  updated: number;
};

type AppointmentSearchResult = {
  included: FhirResource[];
  resources: FhirResource[];
};

type ImportStatus = "created" | "skipped" | "updated";
type RelatedResourceType =
  | "ClinicalImpression"
  | "Composition"
  | "Condition"
  | "Encounter"
  | "Observation";

const relatedResourceTypes = new Set<string>([
  "ClinicalImpression",
  "Composition",
  "Condition",
  "Encounter",
  "Observation",
]);

const appointmentResourceSchema = z.object({
  end: z.string().min(1),
  resourceType: z.literal("Appointment"),
  start: z.string().min(1),
  status: z.string().min(1),
});

export type FhirStore = {
  deleteAppointment: (appointmentId: string) => Promise<boolean>;
  deletePatient: (patientId: string) => Promise<boolean>;
  getAppointment: (appointmentId: string) => Promise<FhirResource | null>;
  getPatient: (patientId: string) => Promise<FhirResource | null>;
  getRelatedResource: (
    resourceType: RelatedResourceType,
    resourceId: string,
  ) => Promise<FhirResource | null>;
  importBundle: (payload: BundlePayload, actorUserId: number) => Promise<ImportSummary>;
  saveAppointment: (
    resource: unknown,
    actorUserId: number,
    appointmentId?: string,
  ) => Promise<FhirResource>;
  savePatient: (
    resource: unknown,
    actorUserId: number,
    patientId?: string,
  ) => Promise<FhirResource>;
  searchAppointments: (input: {
    date: string | null;
    includePatient: boolean;
    patient: string | null;
  }) => Promise<AppointmentSearchResult>;
  searchPatients: (input: { name: string | null }) => Promise<FhirResource[]>;
  searchRelatedResources: (input: {
    patient: string | null;
    resourceType: RelatedResourceType;
  }) => Promise<FhirResource[]>;
};

function emptySummary(): ImportSummary {
  return {
    created: 0,
    errors: [],
    processed: 0,
    skipped: 0,
    updated: 0,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cloneResource(resource: FhirResource) {
  return structuredClone(resource);
}

function normalizeNumericId(id: string) {
  const numericId = Number(id);
  return Number.isInteger(numericId) && numericId > 0 ? numericId : undefined;
}

function resourceId(resource: Record<string, unknown>) {
  return typeof resource.id === "string" && resource.id.trim()
    ? resource.id.trim()
    : undefined;
}

function resourceReferenceId(reference: string | undefined, resourceType: string) {
  const normalized = reference?.trim().split("?")[0].split("#")[0].replace(/\/+$/, "");
  if (!normalized) {
    return null;
  }

  const prefix = `${resourceType}/`;
  const prefixIndex = normalized.lastIndexOf(prefix);
  if (prefixIndex === -1) {
    return null;
  }

  const id = normalized.slice(prefixIndex + prefix.length);
  return id ? decodeURIComponent(id) : null;
}

function patientSearchId(patient: string | null) {
  if (!patient) {
    return null;
  }

  return resourceReferenceId(patient, "Patient") ?? patient;
}

function appointmentPatientReference(resource: Record<string, unknown>) {
  if (!Array.isArray(resource.participant)) {
    return undefined;
  }

  for (const participant of resource.participant) {
    const participantRecord = asRecord(participant);
    const actorRecord = asRecord(participantRecord?.actor);
    if (actorRecord && typeof actorRecord.reference === "string") {
      return actorRecord.reference;
    }
  }

  return undefined;
}

function appointmentTypeText(resource: Record<string, unknown>) {
  const appointmentType = asRecord(resource.appointmentType);
  if (!appointmentType) {
    return "";
  }

  if (typeof appointmentType.text === "string" && appointmentType.text.trim()) {
    return appointmentType.text.trim();
  }

  const firstCoding =
    Array.isArray(appointmentType.coding) && appointmentType.coding[0]
      ? asRecord(appointmentType.coding[0])
      : null;

  if (firstCoding && typeof firstCoding.display === "string" && firstCoding.display.trim()) {
    return firstCoding.display.trim();
  }

  if (firstCoding && typeof firstCoding.code === "string" && firstCoding.code.trim()) {
    return firstCoding.code.trim();
  }

  return "";
}

function compositionPatientId(resource: FhirResource) {
  const subject = asRecord(resource.subject);
  return typeof subject?.reference === "string"
    ? resourceReferenceId(subject.reference, "Patient")
    : null;
}

function resourceDate(resource: FhirResource) {
  const value =
    typeof resource.date === "string"
      ? resource.date
      : typeof resource.effectiveDateTime === "string"
        ? resource.effectiveDateTime
        : typeof resource.recordedDate === "string"
          ? resource.recordedDate
          : undefined;
  return value ? new Date(value).getTime() : 0;
}

function normalizeDateTime(value: string, fieldName: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${fieldName} must be a valid dateTime.`);
  }

  return date;
}

function normalizePatientFhirResource(input: PatientInput, active: boolean, id: string) {
  return {
    resourceType: "Patient",
    id,
    active,
    identifier: input.identifiers.map((identifier) => ({
      system: identifier.system,
      value: identifier.value,
    })),
    name: [{ text: input.name }],
    gender: input.gender,
    ...(input.birthDate
      ? {
          birthDate: input.birthDate.toISOString().slice(0, 10),
        }
      : {}),
    ...(input.isDraft || !input.birthDate
      ? {
          extension: [
            {
              url: "https://soap-ehr.example/StructureDefinition/patient-draft",
              valueBoolean: true,
            },
          ],
        }
      : {}),
    telecom: input.telecom.map((contactPoint) => ({
      system: contactPoint.system,
      value: contactPoint.value,
    })),
    contact: input.contacts.map((contact) => ({
      name: { text: contact.name },
      relationship: [{ text: contact.relationship }],
    })),
  } satisfies FhirResource;
}

function normalizeAppointmentFhirResource(
  input: AppointmentInput,
  id: string,
  patientName: string,
  patientId: string,
) {
  return {
    resourceType: "Appointment",
    id,
    status: input.status,
    start: input.start.toISOString(),
    end: input.end.toISOString(),
    appointmentType: {
      text: input.appointmentType,
    },
    participant: [
      {
        actor: {
          display: patientName,
          reference: `Patient/${patientId}`,
        },
        status: "accepted",
      },
    ],
  } satisfies FhirResource;
}

function patientName(patient: FhirResource) {
  const names = Array.isArray(patient.name) ? patient.name : [];
  const name = names[0] ? asRecord(names[0]) : null;
  return typeof name?.text === "string" ? name.text : "";
}

function jsonEquals(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

class PrismaFhirStore implements FhirStore {
  async deleteAppointment(_appointmentId: string): Promise<boolean> {
    throw new Error("FHIR deletion is available only in API_DRY_RUN mode.");
  }

  async deletePatient(_patientId: string): Promise<boolean> {
    throw new Error("FHIR deletion is available only in API_DRY_RUN mode.");
  }

  async searchPatients({ name }: { name: string | null }) {
    const patients = await prisma.patient.findMany({
      where: name
        ? {
            active: true,
            name: { contains: name },
          }
        : { active: true },
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
      take: 100,
      orderBy: {
        name: "asc",
      },
    });

    return patients.map(toFhirPatient) as FhirResource[];
  }

  async getPatient(patientId: string) {
    const id = normalizeNumericId(patientId);
    if (!id) {
      return null;
    }

    const patient = await prisma.patient.findUnique({
      where: { id },
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

    return patient ? (toFhirPatient(patient) as FhirResource) : null;
  }

  async savePatient(resource: unknown, actorUserId: number, patientId?: string) {
    const id = patientId ? normalizeNumericId(patientId) : undefined;
    if (patientId && !id) {
      throw new Error("Patient not found");
    }

    const payload = parseFhirPatientResource(resource);
    const patient = await savePatient(payload.input, actorUserId, id, {
      active: payload.active,
    });

    return toFhirPatient(patient) as FhirResource;
  }

  async searchAppointments(input: {
    date: string | null;
    includePatient: boolean;
    patient: string | null;
  }) {
    const patientId = input.patient ? normalizeNumericId(input.patient) : null;
    if (input.patient && !patientId) {
      return { included: [], resources: [] };
    }

    const dateFilter = input.date ? new Date(`${input.date}T00:00:00`) : null;
    const appointments = await prisma.appointment.findMany({
      where: {
        ...(patientId ? { patientId } : {}),
        ...(dateFilter
          ? {
              start: {
                gte: startOfDay(dateFilter),
                lte: endOfDay(dateFilter),
              },
            }
          : {}),
      },
      include: {
        patient: {
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
        },
      },
      orderBy: {
        start: "asc",
      },
    });

    return {
      resources: appointments.map(toFhirAppointment) as FhirResource[],
      included: input.includePatient
        ? (appointments.map((appointment) => toFhirPatient(appointment.patient)) as FhirResource[])
        : [],
    };
  }

  async getAppointment(appointmentId: string) {
    const id = normalizeNumericId(appointmentId);
    if (!id) {
      return null;
    }

    const appointment = await prisma.appointment.findUnique({
      where: { id },
      include: {
        patient: true,
      },
    });

    return appointment ? (toFhirAppointment(appointment) as FhirResource) : null;
  }

  async saveAppointment(resource: unknown, actorUserId: number, appointmentId?: string) {
    const id = appointmentId ? normalizeNumericId(appointmentId) : undefined;
    if (appointmentId && !id) {
      throw new Error("Appointment not found.");
    }

    const payload = parseFhirAppointmentResource(resource);
    const appointment = await saveAppointment(payload.input, actorUserId, id);

    return toFhirAppointment(appointment) as FhirResource;
  }

  async searchRelatedResources(input: {
    patient: string | null;
    resourceType: RelatedResourceType;
  }) {
    if (input.resourceType !== "Composition") {
      return [];
    }

    const patientId = input.patient ? normalizeNumericId(input.patient) : null;
    if (input.patient && !patientId) {
      return [];
    }

    const compositions = await getClinicalCompositions(patientId ?? undefined);
    const soapNotes = compositions.filter((item) => item.kind === "soap");
    const narrativeNotes = compositions.filter((item) => item.kind === "narrative");

    return [
      ...soapNotes.map(toFhirComposition),
      ...narrativeNotes.map(toFhirNarrativeComposition),
    ].sort(
      (left, right) => new Date(right.date).getTime() - new Date(left.date).getTime(),
    ) as FhirResource[];
  }

  async getRelatedResource(resourceType: RelatedResourceType, resourceId: string) {
    if (resourceType === "Composition") {
      const parsedId = parseCompositionFhirId(resourceId);
      if (!parsedId) {
        return null;
      }

      if (parsedId.kind === "soap") {
        const note = await getCompositionByVersionId(parsedId.versionId);
        return note ? (toFhirComposition(note) as FhirResource) : null;
      }

      const note = await getCompositionByVersionId(parsedId.versionId);
      return note ? (toFhirNarrativeComposition(note) as FhirResource) : null;
    }

    const noteId =
      resourceType === "Encounter"
        ? parseSoapEncounterFhirId(resourceId)
        : resourceType === "Observation"
          ? parseSoapObservationFhirId(resourceId)
          : resourceType === "Condition"
            ? parseSoapConditionFhirId(resourceId)
            : parseSoapClinicalImpressionFhirId(resourceId);
    const note = noteId ? await getCompositionByVersionId(noteId) : null;
    if (!note) {
      return null;
    }

    if (resourceType === "Encounter") {
      return toFhirEncounter(note) as FhirResource;
    }

    if (resourceType === "Observation") {
      return toFhirObservation(note) as FhirResource;
    }

    if (resourceType === "Condition") {
      return toFhirCondition(note) as FhirResource;
    }

    return toFhirClinicalImpression(note) as FhirResource;
  }

  async importBundle(payload: BundlePayload, actorUserId: number) {
    const actor = await prisma.authUser.findUniqueOrThrow({
      where: { id: actorUserId },
    });

    return importFhirBundle(payload, actor);
  }
}

class MemoryFhirStore implements FhirStore {
  private appointments = new Map<string, FhirResource>();
  private patients = new Map<string, FhirResource>();
  private relatedResources = new Map<RelatedResourceType, Map<string, FhirResource>>([
    ["ClinicalImpression", new Map()],
    ["Composition", new Map()],
    ["Condition", new Map()],
    ["Encounter", new Map()],
    ["Observation", new Map()],
  ]);
  private sequence = new Map<string, number>();

  async deleteAppointment(appointmentId: string) {
    return this.appointments.delete(appointmentId);
  }

  async deletePatient(patientId: string) {
    const hasAppointment = [...this.appointments.values()].some(
      (appointment) => resourceReferenceId(appointmentPatientReference(appointment), "Patient") === patientId,
    );
    if (hasAppointment) {
      throw new Error("Cannot delete Patient while Appointment resources still reference it.");
    }
    return this.patients.delete(patientId);
  }

  async searchPatients({ name }: { name: string | null }) {
    const normalizedName = name?.toLowerCase();
    return [...this.patients.values()]
      .filter((patient) => patient.active !== false)
      .filter((patient) =>
        normalizedName ? patientName(patient).toLowerCase().includes(normalizedName) : true,
      )
      .sort((left, right) => patientName(left).localeCompare(patientName(right)))
      .slice(0, 100)
      .map(cloneResource);
  }

  async getPatient(patientId: string) {
    const patient = this.patients.get(patientId);
    return patient ? cloneResource(patient) : null;
  }

  async savePatient(resource: unknown, _actorUserId: number, patientId?: string) {
    return this.upsertPatient(resource, patientId).then(({ resource: patient }) => patient);
  }

  async searchAppointments(input: {
    date: string | null;
    includePatient: boolean;
    patient: string | null;
  }) {
    const patientId = patientSearchId(input.patient);
    const dateFilter = input.date ? new Date(`${input.date}T00:00:00`) : null;
    const lowerDate = dateFilter ? startOfDay(dateFilter).getTime() : null;
    const upperDate = dateFilter ? endOfDay(dateFilter).getTime() : null;

    const resources = [...this.appointments.values()]
      .filter((appointment) => {
        const reference = appointmentPatientReference(appointment);
        return patientId ? resourceReferenceId(reference, "Patient") === patientId : true;
      })
      .filter((appointment) => {
        if (lowerDate === null || upperDate === null) {
          return true;
        }

        const start = typeof appointment.start === "string" ? new Date(appointment.start) : null;
        return start && start.getTime() >= lowerDate && start.getTime() <= upperDate;
      })
      .sort((left, right) => {
        const leftStart = typeof left.start === "string" ? new Date(left.start).getTime() : 0;
        const rightStart = typeof right.start === "string" ? new Date(right.start).getTime() : 0;
        return leftStart - rightStart;
      })
      .map(cloneResource);

    const includedPatients = input.includePatient
      ? resources.flatMap((appointment) => {
          const reference = appointmentPatientReference(appointment);
          const referencedPatientId = resourceReferenceId(reference, "Patient");
          const patient = referencedPatientId ? this.patients.get(referencedPatientId) : null;
          return patient ? [cloneResource(patient)] : [];
        })
      : [];

    return {
      resources,
      included: [
        ...new Map(includedPatients.map((patient) => [patient.id ?? "", patient])).values(),
      ],
    };
  }

  async getAppointment(appointmentId: string) {
    const appointment = this.appointments.get(appointmentId);
    return appointment ? cloneResource(appointment) : null;
  }

  async saveAppointment(resource: unknown, _actorUserId: number, appointmentId?: string) {
    return this.upsertAppointment(resource, appointmentId).then(
      ({ resource: appointment }) => appointment,
    );
  }

  async searchRelatedResources(input: {
    patient: string | null;
    resourceType: RelatedResourceType;
  }) {
    const patientId = patientSearchId(input.patient);
    return [...(this.relatedResources.get(input.resourceType)?.values() ?? [])]
      .filter((resource) =>
        patientId && input.resourceType === "Composition"
          ? compositionPatientId(resource) === patientId
          : true,
      )
      .sort((left, right) => resourceDate(right) - resourceDate(left))
      .map(cloneResource);
  }

  async getRelatedResource(resourceType: RelatedResourceType, resourceId: string) {
    const resource = this.relatedResources.get(resourceType)?.get(resourceId);
    return resource ? cloneResource(resource) : null;
  }

  async importBundle(payload: BundlePayload, actorUserId: number) {
    const summary = emptySummary();
    const referenceMap = new Map<string, string>();

    for (const entry of payload.entry) {
      const resource = entry.resource;
      if (resource.resourceType !== "Patient") {
        continue;
      }

      try {
        summary.processed += 1;
        const result = await this.upsertPatient(resource, resourceId(resource));
        summary[result.status] += 1;

        if (entry.fullUrl) {
          referenceMap.set(entry.fullUrl, result.resource.id);
        }
        if (typeof resource.id === "string") {
          referenceMap.set(`Patient/${resource.id}`, result.resource.id);
        }
      } catch (error) {
        summary.errors.push({
          item: "Patient",
          message: error instanceof Error ? error.message : "Unexpected patient import error",
        });
      }
    }

    for (const entry of payload.entry) {
      const resource = entry.resource;
      if (resource.resourceType !== "Appointment") {
        continue;
      }

      try {
        summary.processed += 1;
        const normalizedResource = this.rewritePatientReferences(resource, referenceMap);
        const result = await this.upsertAppointment(
          normalizedResource,
          resourceId(resource),
        );
        summary[result.status] += 1;
      } catch (error) {
        summary.errors.push({
          item: "Appointment",
          message:
            error instanceof Error ? error.message : "Unexpected appointment import error",
        });
      }
    }

    for (const entry of payload.entry) {
      const resource = entry.resource;
      if (
        typeof resource.resourceType !== "string" ||
        !relatedResourceTypes.has(resource.resourceType)
      ) {
        continue;
      }

      try {
        summary.processed += 1;
        const normalizedResource = this.rewritePatientReferences(resource, referenceMap);
        const result = this.upsertRelatedResource(
          resource.resourceType as RelatedResourceType,
          normalizedResource as FhirResourceInput,
          resourceId(resource),
        );
        summary[result] += 1;
      } catch (error) {
        summary.errors.push({
          item: resource.resourceType,
          message:
            error instanceof Error ? error.message : "Unexpected resource import error",
        });
      }
    }

    return summary;
  }

  private nextId(resourceType: string) {
    const next = this.sequence.get(resourceType) ?? 1;
    this.sequence.set(resourceType, next + 1);
    return String(next);
  }

  private assignId(
    resourceType: string,
    map: Map<string, FhirResource>,
    preferredId?: string,
  ) {
    if (preferredId?.trim()) {
      return preferredId.trim();
    }

    let id = this.nextId(resourceType);
    while (map.has(id)) {
      id = this.nextId(resourceType);
    }

    return id;
  }

  private async upsertPatient(resource: unknown, patientId?: string) {
    const payload = parseFhirPatientResource(resource);
    const id = this.assignId("Patient", this.patients, patientId);
    this.assertUniquePatientIdentity(payload.input, id);

    const nextResource = normalizePatientFhirResource(payload.input, payload.active, id);
    const status = this.writeResource(this.patients, id, nextResource);
    return { resource: cloneResource(nextResource), status };
  }

  private assertUniquePatientIdentity(input: PatientInput, patientId: string) {
    if (!input.birthDate) {
      return;
    }

    const birthDate = input.birthDate.toISOString().slice(0, 10);
    const duplicate = [...this.patients.values()].find(
      (patient) =>
        patient.id !== patientId &&
        patient.active !== false &&
        patientName(patient) === input.name &&
        patient.birthDate === birthDate,
    );

    if (duplicate) {
      throw new Error(PATIENT_DUPLICATE_IDENTITY_MESSAGE);
    }
  }

  private async upsertAppointment(resource: unknown, appointmentId?: string) {
    const record = asRecord(resource);
    if (!record) {
      throw new Error("Appointment payload must be a JSON object.");
    }

    appointmentResourceSchema.parse(record);
    const patientReference = appointmentPatientReference(record);
    const patientId = resourceReferenceId(patientReference, "Patient");
    if (!patientId) {
      throw new Error("Appointment participant.actor.reference must be Patient/{id}.");
    }

    const patient = this.patients.get(patientId);
    if (!patient || patient.active === false) {
      throw new Error("Appointment patient must reference an active patient.");
    }

    const appointmentType = appointmentTypeText(record);
    if (!appointmentType) {
      throw new Error("Appointment requires appointmentType.text, coding.display, or coding.code");
    }

    const input = {
      appointmentType,
      end: normalizeDateTime(String(record.end), "Appointment.end"),
      patientId: Number(patientId),
      start: normalizeDateTime(String(record.start), "Appointment.start"),
      status: String(record.status).trim(),
    } satisfies AppointmentInput;
    const existingId =
      appointmentId ??
      [...this.appointments.values()].find(
        (appointment) =>
          resourceReferenceId(appointmentPatientReference(appointment), "Patient") ===
            patientId &&
          appointment.start === input.start.toISOString() &&
          appointment.end === input.end.toISOString(),
      )?.id;
    const id = this.assignId("Appointment", this.appointments, existingId);
    const nextResource = normalizeAppointmentFhirResource(
      input,
      id,
      patientName(patient),
      patientId,
    );
    const status = this.writeResource(this.appointments, id, nextResource);

    return { resource: cloneResource(nextResource), status };
  }

  private rewritePatientReferences(
    resource: Record<string, unknown>,
    referenceMap: Map<string, string>,
  ) {
    const next = structuredClone(resource);
    this.rewritePatientReferenceObject(asRecord(next.subject), referenceMap);

    const participants = Array.isArray(next.participant) ? next.participant : [];
    for (const participant of participants) {
      const participantRecord = asRecord(participant);
      this.rewritePatientReferenceObject(asRecord(participantRecord?.actor), referenceMap);
    }

    return next;
  }

  private rewritePatientReferenceObject(
    referenceObject: Record<string, unknown> | null,
    referenceMap: Map<string, string>,
  ) {
    if (typeof referenceObject?.reference !== "string") {
      return;
    }

    const mappedPatientId = referenceMap.get(referenceObject.reference);
    if (mappedPatientId) {
      referenceObject.reference = `Patient/${mappedPatientId}`;
    }
  }

  private upsertRelatedResource(
    resourceType: RelatedResourceType,
    resource: FhirResourceInput,
    preferredId?: string,
  ) {
    const map = this.relatedResources.get(resourceType);
    if (!map) {
      throw new Error(`${resourceType} is not supported by API_DRY_RUN storage.`);
    }

    const id = this.assignId(resourceType, map, preferredId);
    const nextResource = {
      ...structuredClone(resource),
      resourceType,
      id,
    } satisfies FhirResource;

    return this.writeResource(map, id, nextResource);
  }

  private writeResource(
    map: Map<string, FhirResource>,
    id: string,
    resource: FhirResource,
  ): ImportStatus {
    const existing = map.get(id);
    if (!existing) {
      map.set(id, cloneResource(resource));
      return "created";
    }

    if (jsonEquals(existing, resource)) {
      return "skipped";
    }

    map.set(id, cloneResource(resource));
    return "updated";
  }
}

const prismaFhirStore = new PrismaFhirStore();
const memoryFhirStore = new MemoryFhirStore();

export function getFhirStore() {
  return env.API_DRY_RUN ? memoryFhirStore : prismaFhirStore;
}
