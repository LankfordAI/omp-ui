// The composer argument line of `/seance`, parsed renderer-side (issue #885)
// so the consult dialog can prefill from it. Mirrors omp's own usage for its
// TUI `/seance`: `[session id|path] [--model selector]` — at most one
// positional, `--model` once in either `--model X` or `--model=X` form, any
// other leading dash token refused.

export interface SeanceArgs {
  /** Session id or transcript path, exactly as typed; absent for bare `/seance`. */
  source?: string;
  /** Consultant-model selector; absent keeps omp's saved-model fallback. */
  model?: string;
  /** omp's usage sentence when the line cannot parse. */
  error?: string;
}

/** omp's TUI usage line, reused verbatim as the advisory. */
export const SEANCE_USAGE = "usage: /seance [session id|path] [--model selector]";

/**
 * Parses the argument tail of a `/seance` line (the leading command already
 * stripped). Flags may precede or follow the positional; a second positional,
 * a repeated or value-less `--model`, and any unknown flag are refused.
 */
export function parseSeanceArgs(args: string): SeanceArgs {
  const trimmed = args.trim();
  const tokens = trimmed === "" ? [] : trimmed.split(/\s+/);
  const parsed: SeanceArgs = {};
  let modelSeen = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (token === "--model" || token.startsWith("--model=")) {
      if (modelSeen) return { error: `${SEANCE_USAGE} — --model may appear only once` };
      modelSeen = true;
      // Bare `--model` consumes the next token as its value; `--model=X` is
      // self-contained and the following token stays an ordinary positional.
      const inline = token.startsWith("--model=") ? token.slice("--model=".length) : "";
      const value = inline !== "" ? inline : tokens[i + 1] ?? "";
      if (inline === "") i += 1;
      if (value === "" || value.startsWith("-")) {
        return { error: `${SEANCE_USAGE} — --model needs a selector` };
      }
      parsed.model = value;
      continue;
    }
    if (token.startsWith("-") && token !== "-") {
      return { error: `${SEANCE_USAGE} — unknown flag “${token}”` };
    }
    if (parsed.source !== undefined) {
      return { error: `${SEANCE_USAGE} — at most one session may be consulted` };
    }
    parsed.source = token;
  }
  return parsed;
}
