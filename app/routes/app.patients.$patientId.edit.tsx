import { Form, Link, redirect, useActionData, useLoaderData } from "react-router";
import { ZodError } from "zod";

import {
  PatientFormEditor,
  type PatientFormValues,
} from "~/components/patient-form-editor";
import { requireUserSession } from "~/lib/auth.server";
import {
  mergePatientRecords,
  PATIENT_DUPLICATE_IDENTITY_MESSAGE,
  savePatient,
  searchActivePatientIds,
  sortByIdOrder,
} from "~/lib/patients.server";
import { prisma } from "~/lib/prisma.server";
import { getUiTimeZone } from "~/lib/settings.server";
import { parsePatientForm } from "~/lib/validation/patients";
import { formatDate, formatPatientAge, toDateInputValue } from "~/lib/utils";

const MERGE_CANDIDATE_LIMIT = 10;

export async function loader({
  params,
  request,
}: {
  params: { patientId?: string };
  request: Request;
}) {
  await requireUserSession(request);

  const patientId = Number(params.patientId);
  const url = new URL(request.url);
  const mergeQuery = url.searchParams.get("mergeQ")?.trim() ?? "";
  const mergedFromParam = url.searchParams.get("mergedFrom");
  const mergedFrom = mergedFromParam ? Number(mergedFromParam) : null;
  const timeZone = await getUiTimeZone();

  const patient = await prisma.patient.findUnique({
    where: { id: patientId },
    include: {
      contacts: true,
      identifier: true,
      mergedInto: {
        select: {
          id: true,
          name: true,
        },
      },
      replaces: {
        select: {
          id: true,
          name: true,
        },
        orderBy: {
          name: "asc",
        },
      },
      telecom: true,
    },
  });

  if (!patient) {
    throw new Response("Patient not found", { status: 404 });
  }

  const mergeCandidateIds =
    patient.active && mergeQuery
      ? (
          await searchActivePatientIds(mergeQuery, { excludeId: patient.id, matchIdentifier: true })
        ).slice(0, MERGE_CANDIDATE_LIMIT)
      : [];
  const mergeCandidates = mergeCandidateIds.length
    ? sortByIdOrder(
        mergeCandidateIds,
        await prisma.patient.findMany({
          where: { id: { in: mergeCandidateIds } },
          include: {
            identifier: true,
          },
        }),
      )
    : [];

  const formValues: PatientFormValues = {
    active: patient.active,
    birthDate: toDateInputValue(patient.birthDate),
    contacts: patient.contacts.map((contact) => ({
      name: contact.name,
      relationship: contact.relationship,
    })),
    gender: patient.gender.toLowerCase(),
    isDraft: patient.isDraft,
    identifiers: patient.identifier.map((identifier) => ({
      left: identifier.system,
      right: identifier.value,
    })),
    name: patient.name,
    telecom: patient.telecom.map((contactPoint) => ({
      left: contactPoint.system,
      right: contactPoint.value,
    })),
  };

  return { mergeCandidates, mergeQuery, mergedFrom, patient, formValues, timeZone };
}

export async function action({
  params,
  request,
}: {
  params: { patientId?: string };
  request: Request;
}) {
  const auth = await requireUserSession(request);
  const formData = await request.formData();
  const patientId = Number(params.patientId);
  const intent = String(formData.get("intent") ?? "save");

  try {
    if (intent === "merge") {
      const targetPatientId = Number(formData.get("targetPatientId"));

      if (!Number.isInteger(targetPatientId) || targetPatientId <= 0) {
        return {
          mergeError: "Select a valid patient to merge into.",
        };
      }

      const result = await mergePatientRecords({
        actorUserId: auth.user.id,
        sourcePatientId: patientId,
        targetPatientId,
      });

      throw redirect(`/patients/${result.targetPatient.id}/edit?mergedFrom=${result.sourcePatient.id}`);
    }

    const input = parsePatientForm(formData);
    const active = formData.get("active") !== "false";
    await savePatient(input, auth.user.id, patientId, { active });
    throw redirect(`/patients/${params.patientId}/edit`);
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    if (error instanceof ZodError) {
      return {
        error: error.issues[0]?.message ?? "Invalid patient data.",
      };
    }

    if (intent === "merge") {
      return {
        mergeError: error instanceof Error ? error.message : "Could not merge the patient.",
      };
    }

    const mergedPatientMessage = "Cannot update a merged patient. Use the surviving record.";

    return {
      error:
        error instanceof Error &&
        (error.message === mergedPatientMessage ||
          error.message === PATIENT_DUPLICATE_IDENTITY_MESSAGE)
          ? error.message
          : "Could not update the patient. Check duplicated identifiers.",
    };
  }
}

function mergeCandidateLabel(candidate: {
  birthDate: Date | null;
  id: number;
  identifier: Array<{ system: string; value: string }>;
  name: string;
}) {
  const details = [
    `#${candidate.id}`,
    candidate.birthDate ? formatDate(candidate.birthDate) : "Birth date pending",
    candidate.identifier[0]
      ? `${candidate.identifier[0].system}: ${candidate.identifier[0].value}`
      : "No identifier",
  ];

  return `${candidate.name} (${details.join(" | ")})`;
}

export default function EditPatientRoute() {
  const { mergeCandidates, mergeQuery, mergedFrom, patient, formValues, timeZone } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const mergedFromPatient = mergedFrom
    ? patient.replaces.find((candidate) => candidate.id === mergedFrom)
    : null;
  const patientAge = formatPatientAge(patient.birthDate, { timeZone });

  return (
    <section className="panel p-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[color:var(--muted)]">
            Patient edit
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <h2 className="text-3xl font-semibold">{patient.name}</h2>
            {patientAge ? (
              <span className="text-sm font-medium text-[color:var(--muted)]">{patientAge}</span>
            ) : null}
            {patient.isDraft ? (
              <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-amber-700">
                Draft
              </span>
            ) : null}
            {!patient.active ? (
              <span className="rounded-full border border-slate-500/30 bg-slate-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-[0.18em] text-slate-700">
                Inactive
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link className="button-secondary" to="/patients">
            Back
          </Link>
          <Link className="button-primary" to={`/patients/${patient.id}/soap`}>
            SOAP page
          </Link>
        </div>
      </div>

      {mergedFromPatient ? (
        <p className="mt-4 rounded-2xl border border-emerald-500/20 bg-emerald-500/10 px-4 py-3 text-sm">
          {mergedFromPatient.name} was merged into this patient and now links here as FHIR
          `replaced-by`.
        </p>
      ) : null}

      {actionData?.error ? (
        <p className="mt-4 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm">
          {actionData.error}
        </p>
      ) : null}

      {!patient.active && patient.mergedInto ? (
        <p className="mt-4 rounded-2xl border border-slate-500/20 bg-slate-500/10 px-4 py-3 text-sm">
          This patient was merged into{" "}
          <Link className="font-semibold underline" to={`/patients/${patient.mergedInto.id}/edit`}>
            {patient.mergedInto.name}
          </Link>
          . It no longer appears in search and should not receive new clinical entries.
        </p>
      ) : null}

      {patient.active && patient.replaces.length ? (
        <p className="mt-4 rounded-2xl border border-sky-500/20 bg-sky-500/10 px-4 py-3 text-sm">
          Merged records linked to this patient:{" "}
          {patient.replaces.map((replacedPatient, index) => (
            <span key={replacedPatient.id}>
              {index > 0 ? ", " : null}
              <Link
                className="font-semibold underline"
                to={`/patients/${replacedPatient.id}/edit`}
              >
                {replacedPatient.name}
              </Link>
            </span>
          ))}
          .
        </p>
      ) : null}

      {patient.active && patient.isDraft ? (
        <p className="mt-4 rounded-2xl border border-amber-500/20 bg-amber-500/10 px-4 py-3 text-sm">
          This patient is pending registration completion. Fill the missing fields and uncheck
          `Draft` when the record is complete.
        </p>
      ) : null}

      {patient.active || !patient.mergedInto ? (
        <>
          <Form className="mt-8 space-y-8" method="post">
            <PatientFormEditor initialValues={formValues} showActiveField />
            <div className="flex justify-end">
              <button className="button-primary" type="submit">
                Update patient
              </button>
            </div>
          </Form>

          {patient.active ? (
            <section className="mt-8 rounded-3xl border border-black/10 p-6">
              <div>
                <h3 className="text-2xl font-semibold">Merge into another patient</h3>
                <p className="mt-2 text-sm text-[color:var(--muted)]">
                  This patient will become inactive and gain a FHIR `replaced-by` link to the
                  selected survivor. Existing notes and appointments are kept on their current
                  records.
                </p>
              </div>

              <Form className="mt-6 flex flex-col gap-3 md:flex-row" method="get">
                <input
                  className="w-full"
                  defaultValue={mergeQuery}
                  name="mergeQ"
                  placeholder="Search active patient by name or identifier"
                />
                <button className="button-secondary" type="submit">
                  Search target
                </button>
              </Form>

              {actionData?.mergeError ? (
                <p className="mt-4 rounded-2xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm">
                  {actionData.mergeError}
                </p>
              ) : null}

              {mergeQuery && !mergeCandidates.length ? (
                <p className="mt-4 text-sm text-[color:var(--muted)]">
                  No active patient matched this search.
                </p>
              ) : null}

              {mergeCandidates.length ? (
                <Form className="mt-6 space-y-5" method="post">
                  <input name="intent" type="hidden" value="merge" />
                  <label className="block">
                    <span className="field-label">Target patient</span>
                    <select defaultValue={String(mergeCandidates[0].id)} name="targetPatientId">
                      {mergeCandidates.map((candidate) => (
                        <option key={candidate.id} value={candidate.id}>
                          {mergeCandidateLabel(candidate)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <div className="flex justify-end">
                    <button className="button-secondary" type="submit">
                      Merge patient
                    </button>
                  </div>
                </Form>
              ) : null}
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
