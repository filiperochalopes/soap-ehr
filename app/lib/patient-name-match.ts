/**
 * Approximate patient-name search. Pure functions, no I/O.
 *
 * What counts as "the same name": accents, case, punctuation and filler words ("da", "de", ...) do
 * not matter; a registered name with more words than the search still matches; and each word
 * tolerates wrong letters according to its length (`maxEdits`, 2 by default, for 5+ letters; 1 for
 * 4; none up to 3, so "Ana" is not "Ani"). A word of the search (3+ letters) may also be the start
 * of a registered word, or a stretch inside it that leaves at most `maxEdits` letters over ("ilva"
 * finds "Silva"; "ana" does not find "Mariana"; "joa" still finds "Joaquim").
 * Swapping two neighbouring letters counts as one mistake. The result comes closest first.
 *
 * Callers pass the items in `id` order: ties beyond the name keep the input order.
 */

const PARTICLES = new Set(["da", "de", "do", "das", "dos", "e"]);
/** Wrong letters tolerated in a long word, and letters a stretch inside a word may leave over. */
export const DEFAULT_MAX_EDITS = 2;
const MIN_SCORE = 0.6;
const PARTIAL_SCORE = 0.9;
const MIN_PARTIAL_LENGTH = 3;
const SCORE_LOST_PER_ERROR = 0.15;

export type NameMatch<T> = {
  item: T;
  /** 0..1, the mean over the words of the search. It only orders the list; it is never exposed. */
  score: number;
  /** Wrong letters tolerated in the matched words. */
  edits: number;
  normalizedName: string;
};

export function normalizePatientName(value: unknown): string {
  return normalizedWords(value).join(" ");
}

function normalizedWords(value: unknown): string[] {
  const text = String(value ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
  return text
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((word) => word && !PARTICLES.has(word));
}

/** Levenshtein with swapped neighbours (Damerau, "optimal string alignment" variant). */
export function editDistance(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  if (!a.length || !b.length) {
    return a.length || b.length;
  }

  let previous2: number[] = [];
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i, ...new Array<number>(b.length).fill(0)];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        current[j] = Math.min(current[j], previous2[j - 2] + 1);
      }
    }
    previous2 = previous;
    previous = current;
  }
  return previous[b.length];
}

function allowedEdits(word: string, maxEdits: number) {
  return word.length <= 3 ? 0 : word.length === 4 ? Math.min(1, maxEdits) : maxEdits;
}

function wordMatch(queryWord: string, candidateWord: string, maxEdits: number): { score: number; edits: number } | null {
  if (queryWord === candidateWord) {
    return { score: 1, edits: 0 };
  }
  if (queryWord.length >= MIN_PARTIAL_LENGTH) {
    if (candidateWord.startsWith(queryWord)) {
      return { score: PARTIAL_SCORE, edits: 0 };
    }
    // A stretch inside the word (D4) may leave at most `maxEdits` letters over, the same limit as
    // the wrong letters: "ilva" finds "Silva", but "ana" does not find "Mariana".
    if (
      candidateWord.length - queryWord.length <= maxEdits &&
      candidateWord.includes(queryWord)
    ) {
      return { score: PARTIAL_SCORE, edits: 0 };
    }
  }
  const allowed = allowedEdits(queryWord, maxEdits);
  // The distance is never smaller than the difference in length: skip the table when it cannot fit.
  if (Math.abs(queryWord.length - candidateWord.length) > allowed) {
    return null;
  }
  const distance = editDistance(queryWord, candidateWord);
  return distance <= allowed ? { score: 1 - SCORE_LOST_PER_ERROR * distance, edits: distance } : null;
}

function scoreWords(queryWords: string[], candidateWords: string[], maxEdits: number) {
  const unused = candidateWords.map((_, index) => index);
  let total = 0;
  let edits = 0;

  for (const word of queryWords) {
    let best: { score: number; edits: number; index: number } | null = null;
    for (const index of unused) {
      const found = wordMatch(word, candidateWords[index], maxEdits);
      if (found && (!best || found.score > best.score || (found.score === best.score && found.edits < best.edits))) {
        best = { ...found, index };
      }
    }
    if (best) {
      total += best.score;
      edits += best.edits;
      unused.splice(unused.indexOf(best.index), 1);
    }
  }

  return { score: Math.round((total / queryWords.length) * 10000) / 10000, edits };
}

/**
 * Items whose name is close enough to `query`, closest first: score, then fewer wrong letters, then
 * normalized name A-Z. `alsoInclude` adds items that matched for another reason (an identifier);
 * they come after every name match. `maxEdits` is the tolerance for long words (default 2).
 */
export function rankByName<T>(
  query: string,
  items: Iterable<T>,
  key: (item: T) => string,
  options: { alsoInclude?: (item: T) => boolean; maxEdits?: number } = {},
): NameMatch<T>[] {
  const maxEdits = options.maxEdits ?? DEFAULT_MAX_EDITS;
  const queryWords = normalizedWords(query);
  const matches: NameMatch<T>[] = [];

  for (const item of items) {
    const candidateWords = normalizedWords(key(item));
    const normalizedName = candidateWords.join(" ");
    const byName =
      queryWords.length && candidateWords.length ? scoreWords(queryWords, candidateWords, maxEdits) : null;

    if (byName && byName.score >= MIN_SCORE) {
      matches.push({ item, normalizedName, ...byName });
    } else if (options.alsoInclude?.(item)) {
      matches.push({ item, normalizedName, score: 0, edits: 0 });
    }
  }

  return matches.sort(
    (left, right) =>
      right.score - left.score ||
      left.edits - right.edits ||
      (left.normalizedName < right.normalizedName ? -1 : left.normalizedName > right.normalizedName ? 1 : 0),
  );
}
