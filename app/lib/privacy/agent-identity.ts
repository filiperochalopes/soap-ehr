/**
 * How a patient is named to an LLM agent: by database id (`@P42`), initials and age, never the name.
 * Pure, no I/O. The interface keeps its own age text (`formatPatientAge`).
 */
import { normalizePatientName } from "../patient-name-match";
import { getPatientAgeParts } from "../utils";

/** "42 anos" from 1 year on (completed years only); "7 meses" below 1 year (completed months). */
export function agentAge(
  birthDate: Date | string | null | undefined,
  options?: { now?: Date | string; timeZone?: string },
): string | null {
  const age = getPatientAgeParts(birthDate, options);
  if (!age) {
    return null;
  }

  if (age.years >= 1) {
    return `${age.years} ${age.years === 1 ? "ano" : "anos"}`;
  }

  return `${age.months} ${age.months === 1 ? "mês" : "meses"}`;
}

/** First letter of each name word, upper case, ignoring accents and "da, de, do, das, dos, e". */
export function agentInitials(name: string): string {
  return normalizePatientName(name)
    .split(" ")
    .filter((word) => /^[a-z]/.test(word))
    .map((word) => word[0].toUpperCase())
    .join("");
}

/** The handle an agent uses for a patient, and the one the rehydration parser resolves. */
export function agentMention(patientId: number): string {
  return `@P${patientId}`;
}
