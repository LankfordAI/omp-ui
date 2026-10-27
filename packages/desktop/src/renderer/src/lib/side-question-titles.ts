/** btw record id → the typed side command (issue #955). rpc strips omp's own
 *  title, so omp-ui keeps its own; best-effort persistence like share-privacy.ts. */
const KEY = "omp-ui.sideQuestionTitles";
export const SIDE_QUESTION_TITLE_LIMIT = 500;

type TitlePair = [id: string, title: string];

/** The stored pairs; anything unreadable or malformed counts as empty. */
function loadPairs(): TitlePair[] {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(KEY);
  } catch {
    return []; // No storage: titles fall back to the question text.
  }
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const pairs: TitlePair[] = [];
  for (const entry of parsed) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      typeof entry[0] !== "string" ||
      typeof entry[1] !== "string"
    )
      return [];
    pairs.push([entry[0], entry[1]]);
  }
  return pairs;
}

/** Stored as [id, title] pairs, oldest first — array order survives numeric-looking ids. */
export function loadSideQuestionTitles(): Record<string, string> {
  return Object.fromEntries(loadPairs());
}

/** Moves/inserts id as newest, prunes to the newest LIMIT, persists, returns the lookup. */
export function rememberSideQuestionTitle(id: string, title: string): Record<string, string> {
  const pairs = loadPairs().filter(([candidate]) => candidate !== id);
  pairs.push([id, title]);
  const kept = pairs.slice(-SIDE_QUESTION_TITLE_LIMIT);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    // Persistence is best-effort; the returned lookup still titles this session.
  }
  return Object.fromEntries(kept);
}
