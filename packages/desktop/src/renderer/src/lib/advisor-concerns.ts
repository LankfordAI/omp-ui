/**
 * Shared core for collecting and formatting advisor findings out of a native
 * transcript. Both consumers live on top of this: the plan-execute fold
 * (ADR-0009) and the idle-session advisor auto-reply (issue #104). They share
 * one collector and one renderer so the settle decision — "is there a new
 * finding worth acting on?" — can never disagree with the block that is
 * actually dispatched.
 */
import type { AdvisorNote, RenderItem } from "./transcript";

export function noteKey(n: AdvisorNote): string {
  return `${n.advisor ?? ""}|${n.severity ?? ""}|${n.note}`;
}

/**
 * Advisor findings appended to the transcript after `fromIndex`: standalone
 * advisory cards plus notes attached to tool results (the advisor comments on
 * the plan's propose tool result and also posts its end-of-turn card). One
 * review can arrive in both shapes, so notes are deduped on
 * `advisor|severity|note` before the fold — the settle decision and the fold
 * are this one function, so they can never disagree.
 */
export function collectNewConcerns(items: RenderItem[], fromIndex: number): AdvisorNote[] {
  const seen = new Set<string>();
  const notes: AdvisorNote[] = [];
  for (const item of items.slice(fromIndex)) {
    const itemNotes = item.kind === "advisory" || item.kind === "tool" ? (item.notes ?? []) : [];
    for (const note of itemNotes) {
      const key = noteKey(note);
      if (seen.has(key)) continue;
      seen.add(key);
      notes.push(note);
    }
  }
  return notes;
}

/** Renders concerns as an explicit instruction block under `lead`, or null when none. */
export function renderConcernsBlock(notes: AdvisorNote[], lead: string): string | null {
  if (notes.length === 0) return null;
  const lines = notes.map((note) => {
    const severity = note.severity ?? "note";
    const who = note.advisor ? ` (${note.advisor})` : "";
    return `- [${severity}]${who} ${note.note}`;
  });
  return `${lead}\n\n${lines.join("\n")}`;
}
