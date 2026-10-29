export function fhirJson(data: unknown, status = 200, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  if (!responseHeaders.has("Content-Type")) {
    responseHeaders.set("Content-Type", "application/fhir+json; charset=utf-8");
  }

  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: responseHeaders,
  });
}

export function capabilityStatement(baseUrl: string) {
  return {
    resourceType: "CapabilityStatement",
    status: "active",
    date: new Date().toISOString(),
    kind: "instance",
    format: ["application/fhir+json"],
    fhirVersion: "4.0.1",
    implementation: {
      description: "FHIR-oriented MVP API for the clinical monolith.",
      url: baseUrl,
    },
    software: {
      name: "soap-ehr",
      version: "0.1.0",
    },
    patchFormat: ["application/json-patch+json"],
    rest: [
      {
        mode: "server",
        resource: [
          {
            type: "Patient",
            interaction: [
              { code: "read" },
              { code: "search-type" },
              { code: "create" },
              { code: "update" },
              { code: "patch" },
              { code: "delete" },
            ],
          },
          {
            type: "Appointment",
            interaction: [
              { code: "read" },
              { code: "search-type" },
              { code: "create" },
              { code: "update" },
              { code: "patch" },
              { code: "delete" },
            ],
            searchInclude: ["Appointment:patient"],
          },
          { type: "Composition", interaction: [{ code: "read" }, { code: "search-type" }] },
          { type: "DocumentReference", interaction: [{ code: "read" }, { code: "search-type" }] },
          { type: "Encounter", interaction: [{ code: "read" }] },
          { type: "Observation", interaction: [{ code: "read" }] },
          { type: "Condition", interaction: [{ code: "read" }] },
          { type: "ClinicalImpression", interaction: [{ code: "read" }] },
        ],
      },
    ],
  };
}
