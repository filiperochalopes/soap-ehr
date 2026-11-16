/**
 * Hygiene for clinical text that leaves the server for a model or an export. Pure, no I/O.
 *
 * Two layers, in this order:
 * 1. patterns for identifiers that have a shape (CPF, CNS, phone, e-mail) -> `[REMOVIDO]`;
 * 2. the names of this record (the patient's and the registered contacts') -> `[PACIENTE]` and
 *    `[CONTATO]`, matched by whole word, ignoring case, accents, no-break spaces and invisible
 *    characters.
 *
 * Names of people who are not in the record (a colleague, a neighbour) are NOT detected here.
 */
import { normalizePatientName } from "../patient-name-match";

const EMAIL_RE = /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g;
const CPF_RE = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const CNS_RE = /(?<!\d)[1-9]\d{2}[ .]?\d{4}[ .]?\d{4}[ .]?\d{4}(?!\d)/g;
const PHONE_RE = /(?<!\d)(?:\+?55[\s.-]?)?(?:\(?\d{2}\)?[\s.-]?)?\d{4,5}[\s.-]?\d{4}(?!\d)/g;

const MIN_NAME_WORD_LENGTH = 3;
const INVISIBLE_RE = /[\u200B-\u200D\u2060\uFEFF\u00AD]/;

export type RecordNames = {
  patientName?: string | null;
  contactNames?: readonly string[];
};

type Label = "[PACIENTE]" | "[CONTATO]";

function nameWords(name: string | null | undefined): string[] {
  return normalizePatientName(name)
    .split(" ")
    .filter((word) => word.length >= MIN_NAME_WORD_LENGTH);
}

function buildDictionary(names: RecordNames): Map<string, Label> {
  const dictionary = new Map<string, Label>();
  for (const contact of names.contactNames ?? []) {
    for (const word of nameWords(contact)) {
      dictionary.set(word, "[CONTATO]");
    }
  }
  for (const word of nameWords(names.patientName)) {
    dictionary.set(word, "[PACIENTE]"); // the patient wins when a surname is shared
  }
  return dictionary;
}

/** Lower-cased text without accents, invisible characters or odd spaces, with each kept character's source range. */
function fold(text: string) {
  let folded = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let index = 0;

  for (const char of text) {
    const start = index;
    index += char.length;
    const base = INVISIBLE_RE.test(char) ? "" : char.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

    if (!base) {
      if (ends.length) {
        ends[ends.length - 1] = index; // a dropped mark or invisible character belongs to the letter before it
      }
      continue;
    }

    const out = /\s/.test(char) ? " " : base;
    for (let unit = 0; unit < out.length; unit += 1) {
      folded += out[unit];
      starts.push(start);
      ends.push(index);
    }
  }

  return { folded, starts, ends };
}

function replaceRecordNames(text: string, dictionary: Map<string, Label>): string {
  if (!dictionary.size) {
    return text;
  }

  const { folded, starts, ends } = fold(text);
  const hits: Array<{ start: number; end: number; label: Label }> = [];

  for (const match of folded.matchAll(/[a-z0-9]+/g)) {
    const label = dictionary.get(match[0]);
    if (!label) {
      continue;
    }

    const start = starts[match.index];
    const end = ends[match.index + match[0].length - 1];
    const previous = hits.at(-1);
    if (previous && previous.label === label && /^\s*$/.test(text.slice(previous.end, start))) {
      previous.end = end; // "Marina Almeida" becomes one placeholder
    } else {
      hits.push({ start, end, label });
    }
  }

  let result = text;
  for (const hit of hits.reverse()) {
    result = result.slice(0, hit.start) + hit.label + result.slice(hit.end);
  }
  return result;
}

export function scrubClinicalText(value: string, names: RecordNames = {}): string {
  const withoutPatterns = value
    .replace(EMAIL_RE, "[REMOVIDO]")
    .replace(CPF_RE, "[REMOVIDO]")
    .replace(CNS_RE, "[REMOVIDO]")
    .replace(PHONE_RE, "[REMOVIDO]");

  return replaceRecordNames(withoutPatterns, buildDictionary(names)).trim();
}
