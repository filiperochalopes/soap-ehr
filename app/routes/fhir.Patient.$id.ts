import { ZodError } from "zod";

import { requireApiUser } from "~/lib/auth.server";
import { operationOutcome } from "~/lib/fhir/bundle";
import { fhirJson } from "~/lib/fhir/capability";
import { env } from "~/lib/env.server";
import { FHIR_APP_ERROR_CODES } from "~/lib/fhir/errors";
import { getFhirStore } from "~/lib/fhir/store.server";
import { applyFhirPatch, getResourceId } from "~/lib/fhir/write";
import { Prisma as PrismaRuntime } from "~/lib/prisma.server";
import { PATIENT_DUPLICATE_IDENTITY_MESSAGE } from "~/lib/patients.server";

export async function loader({
  params,
  request,
}: {
  params: { id?: string };
  request: Request;
}) {
  await requireApiUser(request);

  const patient = params.id ? await getFhirStore().getPatient(params.id) : null;

  if (!patient) {
    return fhirJson(operationOutcome("error", "not-found", "Patient not found"), 404);
  }

  return fhirJson(patient);
}

export async function action({
  params,
  request,
}: {
  params: { id?: string };
  request: Request;
}) {
  if (request.method !== "PUT" && request.method !== "PATCH" && request.method !== "DELETE") {
    return fhirJson(
      operationOutcome("error", "not-supported", "Method not allowed."),
      405,
      {
        Allow: "GET, PUT, PATCH, DELETE",
      },
    );
  }

  const auth = await requireApiUser(request);
  if (!params.id) {
    return fhirJson(operationOutcome("error", "not-found", "Patient not found"), 404);
  }

  const existingPatient = await getFhirStore().getPatient(params.id);
  if (!existingPatient) {
    return fhirJson(operationOutcome("error", "not-found", "Patient not found"), 404);
  }
  if (request.method === "DELETE") {
    if (!env.API_DRY_RUN || !env.FHIR_TEST_DELETE_ENABLED) {
      return fhirJson(operationOutcome("error", "forbidden", "Deletion is available only in explicitly enabled dry-run mode."), 403);
    }
    try {
      await getFhirStore().deletePatient(params.id);
      return new Response(null, { status: 204 });
    } catch (error) {
      return fhirJson(operationOutcome("error", "conflict", error instanceof Error ? error.message : "Patient deletion failed."), 409);
    }
  }

  try {
    const body = await request.json();
    const resource =
      request.method === "PATCH"
        ? applyFhirPatch(
            existingPatient,
            body,
            request.headers.get("content-type"),
          )
        : body;
    const bodyId = getResourceId(resource);

    if (bodyId && bodyId !== params.id) {
      return fhirJson(
        operationOutcome("error", "invalid", "Patient.id must match the request path."),
        400,
      );
    }

    const patient = await getFhirStore().savePatient(resource, auth.user.id, params.id);

    return fhirJson(patient);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return fhirJson(operationOutcome("error", "invalid", "Invalid JSON body."), 400);
    }

    if (error instanceof ZodError) {
      return fhirJson(
        operationOutcome(
          "error",
          "invalid",
          error.issues[0]?.message ?? "Patient payload is invalid.",
        ),
        400,
      );
    }

    if (error instanceof PrismaRuntime.PrismaClientKnownRequestError && error.code === "P2002") {
      return fhirJson(
        operationOutcome(
          "error",
          "duplicate",
          "Patient identifier already exists.",
          undefined,
          {
            appCode: FHIR_APP_ERROR_CODES.patientIdentifierDuplicate,
            expression: ["Patient.identifier"],
          },
        ),
        409,
      );
    }

    if (error instanceof Error && error.message === PATIENT_DUPLICATE_IDENTITY_MESSAGE) {
      return fhirJson(
        operationOutcome(
          "error",
          "duplicate",
          PATIENT_DUPLICATE_IDENTITY_MESSAGE,
          undefined,
          {
            appCode: FHIR_APP_ERROR_CODES.patientNameBirthDateDuplicate,
            expression: ["Patient.name", "Patient.birthDate"],
          },
        ),
        409,
      );
    }

    return fhirJson(
      operationOutcome(
        "error",
        "invalid",
        error instanceof Error ? error.message : "Patient payload is invalid.",
      ),
      400,
    );
  }
}
