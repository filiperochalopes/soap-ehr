import { ZodError } from "zod";

import { requireApiUser } from "~/lib/auth.server";
import { operationOutcome } from "~/lib/fhir/bundle";
import { fhirJson } from "~/lib/fhir/capability";
import { env } from "~/lib/env.server";
import { getFhirStore } from "~/lib/fhir/store.server";
import { applyFhirPatch, getResourceId } from "~/lib/fhir/write";

export async function loader({
  params,
  request,
}: {
  params: { id?: string };
  request: Request;
}) {
  await requireApiUser(request);

  const appointment = params.id ? await getFhirStore().getAppointment(params.id) : null;

  if (!appointment) {
    return fhirJson(operationOutcome("error", "not-found", "Appointment not found"), 404);
  }

  return fhirJson(appointment);
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
    return fhirJson(operationOutcome("error", "not-found", "Appointment not found"), 404);
  }

  const existingAppointment = await getFhirStore().getAppointment(params.id);
  if (!existingAppointment) {
    return fhirJson(operationOutcome("error", "not-found", "Appointment not found"), 404);
  }
  if (request.method === "DELETE") {
    if (!env.API_DRY_RUN || !env.FHIR_TEST_DELETE_ENABLED) {
      return fhirJson(operationOutcome("error", "forbidden", "Deletion is available only in explicitly enabled dry-run mode."), 403);
    }
    await getFhirStore().deleteAppointment(params.id);
    return new Response(null, { status: 204 });
  }

  try {
    const body = await request.json();
    const resource =
      request.method === "PATCH"
        ? applyFhirPatch(
            existingAppointment,
            body,
            request.headers.get("content-type"),
          )
        : body;
    const bodyId = getResourceId(resource);

    if (bodyId && bodyId !== params.id) {
      return fhirJson(
        operationOutcome("error", "invalid", "Appointment.id must match the request path."),
        400,
      );
    }

    const appointment = await getFhirStore().saveAppointment(
      resource,
      auth.user.id,
      params.id,
    );

    return fhirJson(appointment);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return fhirJson(operationOutcome("error", "invalid", "Invalid JSON body."), 400);
    }

    if (error instanceof ZodError) {
      return fhirJson(
        operationOutcome(
          "error",
          "invalid",
          error.issues[0]?.message ?? "Appointment payload is invalid.",
        ),
        400,
      );
    }

    return fhirJson(
      operationOutcome(
        "error",
        "invalid",
        error instanceof Error ? error.message : "Appointment payload is invalid.",
      ),
      400,
    );
  }
}
