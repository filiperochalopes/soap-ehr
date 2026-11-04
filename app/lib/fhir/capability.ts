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
            searchParam: [
              {
                name: "name",
                type: "string",
                documentation:
                  "Approximate match: ignores case, accents, punctuation and the words da/de/do/das/dos/e; accepts a prefix or a stretch of a word (3+ letters, a stretch inside a word may leave at most 2 letters over by default), a name with fewer words than the record, and a few wrong letters per word (2 by default, PATIENT_SEARCH_MAX_EDITS, in words of 5+ letters; 1 in words of 4, none up to 3). Results are ordered by closeness, then name; _count and _offset page that ordering.",
              },
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
