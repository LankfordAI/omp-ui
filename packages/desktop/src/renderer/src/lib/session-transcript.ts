import type { RenderItem } from "./transcript";

/**
 * The transcript digest the re-titling one-shot reads (issue #433): the
 * session's USER/ASSISTANT turns in order, newest preserved. Only exchange
 * kinds contribute — tool cards, plans, advisories, notices, irc, markers,
 * and command rows are process, not subject, and Prompt 2 would only have to
 * be told to ignore them.
 *
 * Budgets mirror T3 Code's `formatThreadTitleContext`: 8 000 characters total,
 * walked newest-first. When that cuts, the first user section is pinned (its
 * text under the 2 000-char budget, tail-marked when over) ahead of the
 * truncation marker, so the session's original subject survives a long
 * transcript.
 */

const TOTAL_BUDGET_CHARS = 8_000;
const FIRST_USER_BUDGET_CHARS = 2_000;
const EARLIER_MARKER = "[Earlier content truncated]";
const FIRST_USER_MARKER = "[First user message truncated]";

export interface TitleTranscript {
  readonly text: string;
  readonly userTurns: number;
  readonly assistantTurns: number;
}

interface Section {
  readonly role: "USER" | "ASSISTANT";
  readonly text: string;
}

const sectionText = (section: Section): string => `${section.role}: ${section.text}`;

export function buildTitleTranscript(items: readonly RenderItem[]): TitleTranscript {
  const sections: Section[] = [];
  let userTurns = 0;
  let assistantTurns = 0;
  let firstUserIdx = -1;
  for (const item of items) {
    if (item.kind !== "user" && item.kind !== "assistant") continue;
    const text = item.text.trim();
    if (text === "") continue;
    if (item.kind === "user") {
      userTurns += 1;
      if (firstUserIdx === -1) firstUserIdx = sections.length;
    } else {
      assistantTurns += 1;
    }
    sections.push({ role: item.kind === "user" ? "USER" : "ASSISTANT", text });
  }
  const counts = { userTurns, assistantTurns };
  const rendered = sections.map(sectionText);
  const joined = rendered.join("\n\n");
  if (joined.length <= TOTAL_BUDGET_CHARS) return { text: joined, ...counts };

  // Cut: pin the first user turn (the original subject), then keep the
  // newest sections that fit. The pinned section is walked out of the tail,
  // never duplicated.
  const firstUser = firstUserIdx === -1 ? undefined : sections[firstUserIdx];
  const pinned =
    firstUser === undefined
      ? undefined
      : firstUser.text.length <= FIRST_USER_BUDGET_CHARS
        ? sectionText(firstUser)
        : `USER: ${firstUser.text.slice(0, FIRST_USER_BUDGET_CHARS)}\n${FIRST_USER_MARKER}`;
  const head =
    pinned === undefined ? `${EARLIER_MARKER}\n\n` : `${pinned}\n\n${EARLIER_MARKER}\n\n`;
  const tailBudget = TOTAL_BUDGET_CHARS - head.length;
  const kept: string[] = [];
  let size = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    if (i === firstUserIdx) continue;
    const section = rendered[i]!;
    const cost = kept.length === 0 ? section.length : section.length + 2;
    if (size + cost > tailBudget) break;
    kept.unshift(section);
    size += cost;
  }
  const last = rendered[rendered.length - 1]!;
  if (kept.length === 0 && rendered.length > 0 && last !== pinned) {
    // One oversized turn is the whole session so far: keep its newest tail.
    kept.push(last.slice(-Math.max(0, tailBudget)));
  }
  return { text: `${head}${kept.join("\n\n")}`, ...counts };
}
