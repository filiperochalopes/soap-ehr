export function buildOpenApiSpec(serverUrl = "http://localhost:3000") {
  return {
    openapi: "3.1.0",
    info: {
      title: "soap-ehr FHIR API",
      version: "0.1.0",
      description:
        "Single-runtime clinical MVP with token authentication and FHIR-oriented endpoints.",
    },
    servers: [{ url: serverUrl }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "Token",
        },
      },
      schemas: {
        ImportSummary: {
          type: "object",
          properties: {
            processed: { type: "integer", example: 4 },
            created: { type: "integer", example: 3 },
            updated: { type: "integer", example: 1 },
            skipped: { type: "integer", example: 0 },
            errors: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  item: { type: "string" },
                  message: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      "/api/reminders/appointments": {
        get: {
          summary: "Appointment reminder feed (read-only, minimised)",
          description:
            "Scheduled (booked or pending) appointments of one clinic-local day with only what a reminder needs: " +
            "the appointment id and time, the patient's first name and one normalised mobile " +
            "number (country code + area code + number, digits only). CPF, birth date, e-mail, " +
            "surname and every other patient field are never returned. Patients without a " +
            "usable mobile number and appointments that are not booked are only counted. " +
            "Every read is audited with counts only. The day uses the time zone configured " +
            "in the EHR settings.",
          parameters: [
            {
              in: "query",
              name: "date",
              required: true,
              schema: { type: "string", format: "date" },
            },
          ],
          responses: {
            "200": {
              description: "Reminder feed for the day",
              content: {
                "application/json": {
                  example: {
                    date: "2026-11-10",
                    timeZone: "America/Bahia",
                    appointments: [
                      {
                        id: "12",
                        start: "2026-11-10T11:00:00.000Z",
                        startLocal: "2026-11-10T08:00:00-03:00",
                        end: "2026-11-10T12:00:00.000Z",
                        status: "booked",
                        type: "routine",
                        confirmation: "pending",
                        patient: { id: "7", firstName: "Maria", phone: "5571999998888" },
                      },
                    ],
                    skipped: { notBooked: 1, noPhone: 0 },
                  },
                },
              },
            },
            "400": { description: "date is missing or is not a real YYYY-MM-DD day" },
            "401": { description: "A valid Bearer token is required" },
          },
        },
      },
      "/api/reminders/appointments/{appointmentId}/response": {
        post: {
          summary: "Record the patient's answer to a reminder",
          description:
            "Body: {\"response\": \"confirmed\" | \"declined\" | \"no_response\"}. `declined` " +
            "(\"não vou\") cancels the appointment so the reception sees the slot free. " +
            "`no_response` records silence and never cancels or overrides a real answer. " +
            "Repeating an answer is safe (outcome `noop`). A patient who already declined " +
            "cannot re-confirm (409): the slot may be gone and a person decides. The reply " +
            "carries no patient data. Reachable with a `reminders`-scoped token.",
          parameters: [
            { in: "path", name: "appointmentId", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["response"],
                  properties: {
                    response: { type: "string", enum: ["confirmed", "declined", "no_response"] },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "Recorded, or already recorded",
              content: {
                "application/json": {
                  example: {
                    appointmentId: "12",
                    outcome: "applied",
                    status: "cancelled",
                    confirmationStatus: "declined",
                  },
                },
              },
            },
            "400": { description: "Body is not valid JSON or `response` is not allowed" },
            "401": { description: "A valid Bearer token is required" },
            "404": { description: "Appointment not found" },
            "405": { description: "Only POST is served" },
            "409": { description: "already_cancelled or not_booked" },
            "413": { description: "Body larger than 4 KiB" },
          },
        },
      },
      "/fhir/metadata": {
        get: {
          summary: "CapabilityStatement",
          security: [{ bearerAuth: [] }],
          responses: {
            "200": {
              description: "FHIR CapabilityStatement",
              content: {
                "application/fhir+json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
      },
      "/fhir/Patient": {
        get: {
          summary:
            "Search patients (alphabetical, or closest name first with name; at most 100 per page; page with _count and _offset)",
          parameters: [
            {
              in: "query",
              name: "name",
              description:
                "Approximate name: ignores case, accents, punctuation and da/de/do/das/dos/e; accepts a prefix or a stretch of a word (3+ letters, a stretch inside a word may leave at most 2 letters over by default), fewer words than the record, and a few wrong letters per word (2 by default, PATIENT_SEARCH_MAX_EDITS, in words of 5+ letters; 1 in words of 4, none up to 3). Closest first.",
              schema: { type: "string" },
              required: false,
            },
            {
              in: "query",
              name: "_count",
              description: "Page size, 1 to 100 (default 100).",
              schema: { type: "integer", minimum: 1, maximum: 100 },
              required: false,
            },
            {
              in: "query",
              name: "_offset",
              description:
                "How many patients to skip; continue from here until a page comes back with fewer than _count.",
              schema: { type: "integer", minimum: 0 },
              required: false,
            },
          ],
          responses: {
            "200": {
              description: "FHIR Patient searchset",
              content: {
                "application/fhir+json": {
                  example: {
                    resourceType: "Bundle",
                    type: "searchset",
                    total: 1,
                    entry: [
                      {
                        fullUrl: `${serverUrl}/fhir/Patient/1`,
                        resource: {
                          resourceType: "Patient",
                          id: "1",
                          name: [{ text: "Maria de Souza" }],
                          gender: "female",
                          birthDate: "1980-09-14",
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
        post: {
          summary: "Create patient",
          requestBody: {
            required: true,
            content: {
              "application/fhir+json": {
                example: {
                  resourceType: "Patient",
                  active: true,
                  identifier: [
                    {
                      system: "https://www.gov.br/cpf",
                      value: "11122233344",
                    },
                  ],
                  name: [{ text: "Maria de Souza" }],
                  gender: "female",
                  birthDate: "1980-09-14",
                  telecom: [
                    {
                      system: "phone",
                      value: "+55 71 99999-0000",
                    },
                  ],
                  contact: [
                    {
                      relationship: [{ text: "Brother" }],
                      name: { text: "Joao de Souza" },
                    },
                  ],
                },
              },
            },
          },
          responses: {
            "201": {
              description: "FHIR Patient resource created",
              content: {
                "application/fhir+json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
      },
      "/fhir/Patient/{id}": {
        get: {
          summary: "Read patient",
          parameters: [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "FHIR Patient resource",
              content: {
                "application/fhir+json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
        put: {
          summary: "Update patient",
          parameters: [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/fhir+json": {
                example: {
                  resourceType: "Patient",
                  id: "1",
                  active: true,
                  identifier: [
                    {
                      system: "https://www.gov.br/cpf",
                      value: "11122233344",
                    },
                  ],
                  name: [{ text: "Maria de Souza" }],
                  gender: "female",
                  birthDate: "1980-09-14",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "FHIR Patient resource updated",
              content: {
                "application/fhir+json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
        patch: {
          summary: "Patch patient",
          parameters: [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json-patch+json": {
                example: [
                  {
                    op: "replace",
                    path: "/telecom",
                    value: [
                      {
                        system: "phone",
                        value: "+55 71 98888-0000",
                      },
                    ],
                  },
                ],
              },
              "application/merge-patch+json": {
                example: {
                  telecom: [
                    {
                      system: "phone",
                      value: "+55 71 98888-0000",
                    },
                  ],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "FHIR Patient resource patched",
              content: {
                "application/fhir+json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
      },
      "/fhir/Appointment": {
        get: {
          summary: "Search appointments",
          parameters: [
            { in: "query", name: "date", schema: { type: "string", format: "date" } },
            { in: "query", name: "patient", schema: { type: "string" } },
            {
              in: "query",
              name: "_include",
              schema: { type: "string", enum: ["Appointment:patient"] },
              required: false,
            },
          ],
          responses: {
            "200": {
              description: "FHIR Appointment searchset",
              content: {
                "application/fhir+json": {
                  example: {
                    resourceType: "Bundle",
                    type: "searchset",
                    total: 1,
                    entry: [
                      {
                        fullUrl: `${serverUrl}/fhir/Appointment/1`,
                        resource: {
                          resourceType: "Appointment",
                          id: "1",
                          status: "booked",
                          start: "2026-03-10T13:30:00Z",
                          end: "2026-03-10T14:00:00Z",
                          appointmentType: {
                            text: "routine",
                          },
                          participant: [
                            {
                              actor: {
                                reference: "Patient/7",
                                display: "Maria de Souza",
                              },
                              status: "accepted",
                            },
                          ],
                        },
                        search: {
                          mode: "match",
                        },
                      },
                      {
                        fullUrl: `${serverUrl}/fhir/Patient/7`,
                        resource: {
                          resourceType: "Patient",
                          id: "7",
                          name: [{ text: "Maria de Souza" }],
                          gender: "female",
                          birthDate: "1980-09-14",
                        },
                        search: {
                          mode: "include",
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
        },
        post: {
          summary: "Create appointment",
          requestBody: {
            required: true,
            content: {
              "application/fhir+json": {
                example: {
                  resourceType: "Appointment",
                  status: "booked",
                  start: "2026-03-10T13:30:00Z",
                  end: "2026-03-10T14:00:00Z",
                  appointmentType: {
                    text: "routine",
                  },
                  participant: [
                    {
                      actor: {
                        reference: "Patient/1",
                      },
                      status: "accepted",
                    },
                  ],
                },
              },
            },
          },
          responses: {
            "201": {
              description: "FHIR Appointment resource created",
              content: {
                "application/fhir+json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
      },
      "/fhir/Appointment/{id}": {
        get: {
          summary: "Read appointment",
          parameters: [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "FHIR Appointment resource",
              content: {
                "application/fhir+json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
        put: {
          summary: "Update appointment",
          parameters: [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/fhir+json": {
                example: {
                  resourceType: "Appointment",
                  id: "1",
                  status: "booked",
                  start: "2026-03-10T13:30:00Z",
                  end: "2026-03-10T14:00:00Z",
                  appointmentType: {
                    text: "routine",
                  },
                  participant: [
                    {
                      actor: {
                        reference: "Patient/1",
                      },
                      status: "accepted",
                    },
                  ],
                },
              },
            },
          },
          responses: {
            "200": {
              description: "FHIR Appointment resource updated",
              content: {
                "application/fhir+json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
        patch: {
          summary: "Patch appointment",
          parameters: [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string" },
            },
          ],
          requestBody: {
            required: true,
            content: {
              "application/json-patch+json": {
                example: [
                  {
                    op: "replace",
                    path: "/status",
                    value: "cancelled",
                  },
                ],
              },
              "application/merge-patch+json": {
                example: {
                  status: "cancelled",
                },
              },
            },
          },
          responses: {
            "200": {
              description: "FHIR Appointment resource patched",
              content: {
                "application/fhir+json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
      },
      "/fhir/Composition": {
        get: {
          summary: "Search clinical compositions",
          parameters: [
            { in: "query", name: "patient", schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "FHIR Composition searchset",
              content: {
                "application/fhir+json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
      },
      "/fhir/Composition/{id}": {
        get: {
          summary: "Read clinical composition",
          parameters: [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "FHIR Composition resource",
              content: {
                "application/fhir+json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
      },
      "/fhir/DocumentReference": {
        get: {
          summary: "Search clinical attachments",
          parameters: [
            { in: "query", name: "patient", schema: { type: "string" } },
          ],
          responses: {
            "200": {
              description: "FHIR DocumentReference searchset",
              content: {
                "application/fhir+json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
      },
      "/fhir/DocumentReference/{id}": {
        get: {
          summary: "Read clinical attachment metadata",
          parameters: [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string" },
            },
          ],
          responses: {
            "200": {
              description: "FHIR DocumentReference resource",
              content: {
                "application/fhir+json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
      },
      "/fhir": {
        post: {
          summary: "Import Bundle payloads",
          requestBody: {
            required: true,
            content: {
              "application/fhir+json": {
                example: {
                  resourceType: "Bundle",
                  type: "transaction",
                  entry: [
                    {
                      fullUrl: "urn:uuid:patient-1",
                      resource: {
                        resourceType: "Patient",
                        id: "external-patient-1",
                        identifier: [
                          {
                            system: "https://clinic.example.org/patients",
                            value: "external-patient-1",
                          },
                          {
                            system: "https://www.gov.br/cpf",
                            value: "11122233344",
                          },
                        ],
                        name: [
                          {
                            use: "official",
                            text: "Maria de Souza",
                            family: "Souza",
                            given: ["Maria"],
                          },
                        ],
                        gender: "female",
                        birthDate: "1980-09-14",
                        telecom: [
                          {
                            system: "phone",
                            value: "+55 71 99999-0000",
                            use: "mobile",
                          },
                          {
                            system: "email",
                            value: "maria.souza@example.org",
                            use: "home",
                          },
                        ],
                        contact: [
                          {
                            relationship: [{ text: "Brother" }],
                            name: { text: "Joao de Souza" },
                          },
                        ],
                      },
                    },
                    {
                      fullUrl: "urn:uuid:appointment-1",
                      resource: {
                        resourceType: "Appointment",
                        id: "appointment-1",
                        status: "booked",
                        start: "2026-03-10T13:30:00Z",
                        end: "2026-03-10T14:00:00Z",
                        appointmentType: {
                          text: "routine",
                        },
                        participant: [
                          {
                            actor: {
                              reference: "urn:uuid:patient-1",
                              display: "Maria de Souza",
                            },
                            status: "accepted",
                          },
                        ],
                      },
                    },
                    {
                      fullUrl: "urn:uuid:encounter-1",
                      resource: {
                        resourceType: "Encounter",
                        id: "encounter-1",
                        subject: { reference: "urn:uuid:patient-1" },
                        period: {
                          start: "2026-03-10T14:30:00Z",
                        },
                      },
                    },
                    {
                      resource: {
                        resourceType: "Composition",
                        id: "soap-1",
                        identifier: [
                          {
                            system: "https://clinic.example.org/soap-notes",
                            value: "SOAP-993",
                          },
                        ],
                        subject: { reference: "urn:uuid:patient-1" },
                        encounter: { reference: "urn:uuid:encounter-1" },
                        title: "SOAP note",
                        status: "final",
                        type: {
                          text: "SOAP note",
                        },
                        section: [
                          {
                            title: "Subjective",
                            text: { status: "generated", div: "<div><p>Headache for 2 days.</p></div>" },
                          },
                          {
                            title: "Objective",
                            text: { status: "generated", div: "<div><p>Afebrile. BP 120/80.</p></div>" },
                          },
                          {
                            title: "Assessment",
                            text: { status: "generated", div: "<div><p>Tension headache.</p></div>" },
                          },
                          {
                            title: "Plan",
                            text: { status: "generated", div: "<div><p>Hydration and analgesic guidance.</p></div>" },
                          },
                        ],
                      },
                    },
                  ],
                },
                examples: {
                  withAppointmentHistory: {
                    summary: "Bundle imports patient, appointment history, and SOAP note together",
                    value: {
                      resourceType: "Bundle",
                      type: "transaction",
                      entry: [
                        {
                          fullUrl: "urn:uuid:patient-1",
                          resource: {
                            resourceType: "Patient",
                            id: "external-patient-1",
                            name: [{ text: "Maria de Souza" }],
                            gender: "female",
                            birthDate: "1980-09-14",
                          },
                        },
                        {
                          resource: {
                            resourceType: "Appointment",
                            id: "appointment-1",
                            status: "fulfilled",
                            start: "2026-03-10T13:30:00Z",
                            end: "2026-03-10T14:00:00Z",
                            appointmentType: {
                              text: "routine",
                            },
                            participant: [
                              {
                                actor: {
                                  reference: "urn:uuid:patient-1",
                                },
                                status: "accepted",
                              },
                            ],
                          },
                        },
                        {
                          resource: {
                            resourceType: "Composition",
                            id: "soap-1",
                            subject: { reference: "urn:uuid:patient-1" },
                            date: "2026-03-10T14:30:00Z",
                            section: [
                              {
                                title: "Subjective",
                                text: {
                                  status: "generated",
                                  div: "<div><p>Headache for 2 days.</p></div>",
                                },
                              },
                              {
                                title: "Objective",
                                text: {
                                  status: "generated",
                                  div: "<div><p>Afebrile. BP 120/80.</p></div>",
                                },
                              },
                              {
                                title: "Assessment",
                                text: {
                                  status: "generated",
                                  div: "<div><p>Tension headache.</p></div>",
                                },
                              },
                              {
                                title: "Plan",
                                text: {
                                  status: "generated",
                                  div: "<div><p>Hydration and analgesic guidance.</p></div>",
                                },
                              },
                            ],
                          },
                        },
                      ],
                    },
                  },
                  withCompositionDate: {
                    summary: "Composition carries the encounter date directly",
                    value: {
                      resourceType: "Bundle",
                      type: "transaction",
                      entry: [
                        {
                          fullUrl: "urn:uuid:patient-1",
                          resource: {
                            resourceType: "Patient",
                            id: "external-patient-1",
                            name: [{ text: "Maria de Souza" }],
                            gender: "female",
                            birthDate: "1980-09-14",
                          },
                        },
                        {
                          resource: {
                            resourceType: "Composition",
                            id: "soap-1",
                            subject: { reference: "urn:uuid:patient-1" },
                            date: "2026-03-10T14:30:00Z",
                            section: [
                              {
                                title: "Subjective",
                                text: {
                                  status: "generated",
                                  div: "<div><p>Headache for 2 days.</p></div>",
                                },
                              },
                              {
                                title: "Objective",
                                text: {
                                  status: "generated",
                                  div: "<div><p>Afebrile. BP 120/80.</p></div>",
                                },
                              },
                              {
                                title: "Assessment",
                                text: {
                                  status: "generated",
                                  div: "<div><p>Tension headache.</p></div>",
                                },
                              },
                              {
                                title: "Plan",
                                text: {
                                  status: "generated",
                                  div: "<div><p>Hydration and analgesic guidance.</p></div>",
                                },
                              },
                            ],
                          },
                        },
                      ],
                    },
                  },
                  withNarrativeSections: {
                    summary: "Composition carries a free-text consultation note",
                    value: {
                      resourceType: "Bundle",
                      type: "transaction",
                      entry: [
                        {
                          fullUrl: "urn:uuid:patient-2",
                          resource: {
                            resourceType: "Patient",
                            id: "external-patient-2",
                            name: [{ text: "Joao Pereira" }],
                            gender: "male",
                            birthDate: "1978-06-22",
                          },
                        },
                        {
                          resource: {
                            resourceType: "Composition",
                            id: "consult-note-1",
                            subject: { reference: "urn:uuid:patient-2" },
                            date: "2026-03-12T10:15:00Z",
                            title: "Consulta ambulatorial",
                            section: [
                              {
                                title: "Narrativa clinica",
                                text: {
                                  status: "generated",
                                  div: "<div xmlns=\"http://www.w3.org/1999/xhtml\"><p>Paciente comparece relatando tosse seca ha 5 dias, sem dispneia e sem febre. Orientado retorno se piora.</p></div>",
                                },
                              },
                            ],
                          },
                        },
                      ],
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": {
              description: "FHIR OperationOutcome with import summary",
              content: {
                "application/fhir+json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
      },
    },
  };
}
