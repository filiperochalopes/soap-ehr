# soap-ehr V2 architecture

## Boundaries

The V2 runtime has one canonical clinical model. `SoapNote` and `NarrativeNote`
are not tables, compatibility views or fallback read paths.

Operational records remain relational:

- `Patient`, demographics and patient merge state;
- `AuthUser`, tokens, plugin credentials and audit events;
- `Appointment`, encrypted browser drafts and attachment workflow.

Clinical records use a deliberately small openEHR-inspired kernel:

- `EhrRecord` is the patient-scoped record root;
- `Contribution` is the auditable commit/change set;
- `VersionedComposition` owns the logical clinical document identity;
- `CompositionVersion` is immutable clinical content with a preceding-version link;
- `ArchetypeDefinition` and `TemplateDefinition` are executable knowledge artifacts;
- `ClinicalAttachment` points to the exact composition version it accompanies.

This educational kernel follows the openEHR separation of reference model,
archetypes and templates but does not claim full openEHR platform conformance.
Full conformance would additionally require the complete RM, OPT/ADL processing,
REST service contracts and AQL semantics.

## Canonical SOAP template

`soap-ehr.template.encounter-soap.v1` constrains a consultation composition to:

| Node | Section | RM entry | Narrative archetype |
| --- | --- | --- | --- |
| `at0001` | Subjective | `OBSERVATION` | `openEHR-EHR-OBSERVATION.story.v1` |
| `at0002` | Objective | `OBSERVATION` | `openEHR-EHR-OBSERVATION.clinical_exam.v1` |
| `at0003` | Assessment | `EVALUATION` | `openEHR-EHR-EVALUATION.clinical_assessment.v1` |
| `at0004` | Plan | `EVALUATION` | `openEHR-EHR-EVALUATION.care_plan.v1` |

The plan remains an `EVALUATION` during V1 migration because historical free
text may mix advice, follow-up, prescriptions and requests. Future structured
orders can use dedicated `INSTRUCTION` archetypes without reinterpreting old text.

Each save validates the JSON composition, hashes the canonical content and
commits the EHR root, contribution, logical composition and first version in one
database transaction. Draft attachments are promoted only inside that same
successful transaction.

## FHIR boundary

FHIR resources are projections, never a second clinical source of truth:

- consultation context -> `Encounter`;
- objective narrative -> `Observation`;
- assessment narrative -> `Condition` and `ClinicalImpression`;
- the full template -> `Composition`;
- attachment metadata -> `DocumentReference`.

FHIR imports are normalized into a validated composition before commit.

## OMOP boundary

OMOP CDM 5.4.2 is a one-way, read-only projection inside the V2 PostgreSQL
database. The batch ETL
resolves patient merges, creates people/providers/visits/observation periods and
preserves each canonical composition in `NOTE`. It does not reinterpret free
SOAP prose as coded conditions or measurements. See [`omop.md`](omop.md).

## Database isolation

The application uses PostgreSQL:

```text
soap-ehr-db (PostgreSQL)
└── soap_ehr
    ├── public        V2 canonical runtime
    ├── omop          derived OMOP CDM
    └── soap_ehr_etl ETL provenance and stable source mappings
```

OMOP shares the PostgreSQL server and database but not the canonical tables. It
is outside the clinical transaction path and remains safe to rebuild from
`public`.

The active Prisma migrations contain only the canonical schema in
`prisma/migrations/`.

## Historical backup recovery

A retained V1 MySQL dump cannot be restored directly into PostgreSQL. The V1
schema, conversion tooling and migration runbook are available in Git at commit
`c2bfa38`; recovery requires an isolated MySQL restore followed by semantic
conversion. Database dumps do not include attachments in S3-compatible storage;
those require a separate backup. The checked-in V1 dump is a synthetic fixture,
not a production backup.
