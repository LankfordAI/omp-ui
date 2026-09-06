/**
 * Two-stage completion for the composer's slash palette.
 *
 * Stage one is the command word (`/goa`): the palette fuzzy-searches the whole
 * roster and owns that ranking itself. Stage two begins at the first
 * whitespace after the word (`/goal s`): the word is resolved exactly and only
 * that command's subcommands are offered, filtered by everything typed after
 * it. Pure, like fuzzy.ts and mentions.ts, so the composer can decide whether
 * a palette exists at all before rendering one — an absent palette is what
 * lets Enter submit and Escape abort.
 */
import { fuzzyMatch } from "./fuzzy";
import type { SlashCommandInfo } from "./rpc-types";

export type Subcommand = NonNullable<SlashCommandInfo["subcommands"]>[number];

export interface SubcommandMatch {
  subcommand: Subcommand;
  /** Indices of `subcommand.name` the needle consumed, for emphasis. */
  hits: number[];
}

export type SlashCompletion =
  /** The command word is still being typed; the palette searches the roster. */
  | { stage: "command"; needle: string }
  /** The word names a command with subcommands; `matches` is never empty. */
  | { stage: "subcommand"; command: SlashCommandInfo; needle: string; matches: SubcommandMatch[] };

/** `/word`, then optionally whitespace and the rest of the line (newlines included). */
const DRAFT = /^\/(\S*)(?:\s+([\s\S]*))?$/;

/** Exact, case-sensitive lookup by name or alias — the word is finished, so nothing fuzzy. */
export function findCommand(
  commands: readonly SlashCommandInfo[],
  word: string,
): SlashCommandInfo | undefined {
  return commands.find((c) => c.name === word || c.aliases?.includes(word) === true);
}

/**
 * What the palette can offer for `text`, or null when there is nothing to
 * offer: not a slash draft, a word no command advertises, a command without
 * subcommands, or an argument no subcommand name matches.
 *
 * Stage two matches names only — never descriptions. The remainder is often a
 * free-form argument, and an open palette steals Enter, so precision outranks
 * recall here. fuzzyMatch also rejects a needle longer than the haystack, so
 * any argument longer than the longest sibling name hides the palette outright.
 */
export function slashCompletion(
  text: string,
  commands: readonly SlashCommandInfo[],
): SlashCompletion | null {
  const m = DRAFT.exec(text);
  if (m === null) return null;
  const word: string = m[1];
  const rest: string | undefined = m[2];
  if (rest === undefined) return { stage: "command", needle: word };
  const command = findCommand(commands, word);
  const subcommands = command?.subcommands;
  if (command === undefined || subcommands === undefined || subcommands.length === 0) return null;
  const scored: (SubcommandMatch & { score: number })[] = [];
  for (const subcommand of subcommands) {
    const hit = fuzzyMatch(subcommand.name, rest);
    if (hit !== null) scored.push({ subcommand, hits: hit.hits, score: hit.score });
  }
  if (scored.length === 0) return null;
  // Stable: ties keep omp's advertised order (`on`, `off`, `status`), which
  // reads as documentation the way an alphabetical sort would not.
  scored.sort((a, b) => b.score - a.score);
  return {
    stage: "subcommand",
    command,
    needle: rest,
    matches: scored.map(({ subcommand, hits }) => ({ subcommand, hits })),
  };
}
