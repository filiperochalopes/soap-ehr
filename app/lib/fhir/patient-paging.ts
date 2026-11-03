/**
 * Paging for `GET /fhir/Patient`: `_count` (page size, at most 100) and `_offset`.
 *
 * The search used to return the first 100 patients and nothing else, so a clinic with more than 100
 * registrations had everyone after the 100th unreachable. Callers that read the whole registry now
 * continue from `_offset` until a page comes back short. Without the parameters the behaviour is the
 * old one (the first 100), so existing clients keep working. A malformed value is an error: guessing
 * a default for a paging parameter would make a client loop or skip people.
 */

export const MAX_PATIENT_PAGE = 100;
const MAX_PATIENT_OFFSET = 1_000_000;

export class PatientPagingError extends Error {}

function readInteger(raw: string | null, name: string, minimum: number, maximum: number): number | null {
  if (raw === null) {
    return null;
  }
  if (!/^\d{1,12}$/.test(raw)) {
    throw new PatientPagingError(`${name} must be a whole number.`);
  }
  const value = Number(raw);
  if (value < minimum || value > maximum) {
    throw new PatientPagingError(`${name} is out of range.`);
  }

  return value;
}

export function parsePatientPaging(searchParams: URLSearchParams): { limit: number; offset: number } {
  const count = readInteger(searchParams.get("_count"), "_count", 1, Number.MAX_SAFE_INTEGER);
  const offset = readInteger(searchParams.get("_offset"), "_offset", 0, MAX_PATIENT_OFFSET);

  return {
    limit: Math.min(count ?? MAX_PATIENT_PAGE, MAX_PATIENT_PAGE),
    offset: offset ?? 0,
  };
}
