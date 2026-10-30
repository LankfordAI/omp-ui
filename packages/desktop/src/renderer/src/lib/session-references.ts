/**
 * Session references (issue #984, ADR-0085): another saved session handed to
 * this one's prompt. The rpc `prompt` frame has no field for them, so — like
 * the annotations block (ADR-0077) — they ride the prompt text as an
 * omp-ui-authored block the transcript derivation parses back into chips.
 *
 * The block LEADS the prompt, ahead of any annotations block and the typed
 * draft, so the model knows what it was handed before the request about it:
 *
 *     <session references>
 *     <the fixed seance hint line>
 *     - title: Fix the deploy pipeline
 *       session: 019faeab-…
 *       machine: austin-desktop
 *       path: /home/austin/.omp/agent/sessions/…/…_019faeab-….jsonl
 *     </session references>
 *
 *     the typed draft
 *
 * Every field is one line with `<`, `>`, CR and LF removed, so no body line
 * can close the block early. The whole block is one tag section, which omp's
 * keyword masking skips: a title containing `ultrathink` arms nothing.
 */
import type { SessionReference } from "@omp-ui/core/types";

const BLOCK_OPEN = "<session references>";
const BLOCK_CLOSE = "</session references>";

/** Model-facing, fixed: the parse requires it verbatim. */
export const SESSION_REFERENCE_HINT =
  "The user referenced these other omp-ui sessions. Each path is that session's saved transcript on this machine as of this prompt. " +
  'To consult one without resuming it, call the task tool with agent "seance" and sourceSession set to its path; in plan mode, read the file instead.';

function oneLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ").replace(/[<>]/g, "").trim();
}

/**
 * A reference in a composer draft: the resolved facts plus the instance that
 * owns the referenced session (null = this app). A reference is valid only in
 * a session owned by the same instance — its path exists nowhere else.
 */
export interface DraftSessionReference extends SessionReference {
  instanceId: string | null;
}

/** Prepends the session references block; a prompt without references is unchanged. */
export function withSessionReferenceContext(message: string, refs: readonly SessionReference[]): string {
  if (refs.length === 0) return message;
  const entries = refs.flatMap((ref) => [
    `- title: ${oneLine(ref.title) || "New session"}`,
    `  session: ${oneLine(ref.sessionId)}`,
    `  machine: ${oneLine(ref.machine)}`,
    `  path: ${ref.path.replace(/[\r\n]/g, "")}`,
  ]);
  const block = [BLOCK_OPEN, SESSION_REFERENCE_HINT, ...entries, BLOCK_CLOSE].join("\n");
  return message === "" ? block : `${block}\n\n${message}`;
}

const FIELDS = ["- title: ", "  session: ", "  machine: ", "  path: "] as const;

/** The body's entries, or null when any line breaks the grammar above. */
function parseBody(lines: readonly string[]): SessionReference[] | null {
  if (lines[0] !== SESSION_REFERENCE_HINT || lines.length < 5 || (lines.length - 1) % 4 !== 0) return null;
  const out: SessionReference[] = [];
  for (let i = 1; i < lines.length; i += 4) {
    const values: string[] = [];
    for (let f = 0; f < FIELDS.length; f++) {
      const line = lines[i + f]!;
      if (!line.startsWith(FIELDS[f]!)) return null;
      values.push(line.slice(FIELDS[f]!.length));
    }
    const [title, sessionId, machine, path] = values as [string, string, string, string];
    if (sessionId === "" || path === "") return null;
    out.push({ title, sessionId, machine, path });
  }
  return out;
}

/**
 * Removes only a proven leading session references block, mirroring
 * `splitAnnotationContext`: a lookalike anywhere else — or a block whose body
 * does not parse — passes through untouched.
 */
export function splitSessionReferenceContext(text: string): { text: string; references: SessionReference[] } {
  if (!text.startsWith(`${BLOCK_OPEN}\n`)) return { text, references: [] };
  const close = text.indexOf(`\n${BLOCK_CLOSE}`, BLOCK_OPEN.length);
  if (close === -1) return { text, references: [] };
  const after = close + 1 + BLOCK_CLOSE.length;
  if (after !== text.length && !text.startsWith("\n\n", after)) return { text, references: [] };
  const references = parseBody(text.slice(BLOCK_OPEN.length + 1, close).split("\n"));
  if (references === null) return { text, references: [] };
  return { text: text.slice(after === text.length ? after : after + 2), references };
}
