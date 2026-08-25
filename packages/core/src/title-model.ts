import { runOmpOnce, type OmpOneShotSpawn } from "./omp-process";

/**
 * Small-model one-shots from omp's own small model: session titles and git
 * branch names.
 *
 * omp titles itself only in the TUI (`input-controller.ts`
 * #maybeStartTitleGeneration); `--mode=rpc-ui` never does, and the rpc
 * protocol exposes no "generate a title" command (v17.1.8) — only
 * `set_session_name`, which takes a literal string. Nor can omp-ui call the
 * model itself: the API keys, provider catalog, and credential rotation all
 * live inside omp.
 *
 * So the answer comes from the one surface that does have all of that: a
 * short `omp -p` run against the model omp's own config binds to the title
 * roles. Everything that would make it slow or stateful is switched off — no
 * session file, no tools, no LSP, no extensions/skills/rules — leaving a
 * single completion whose stdout is the title (or branch name).
 */

/**
 * Adapted from omp's `prompts/system/title-system.md` (v17.1.8). Inlined
 * rather than read out of omp's install: that path varies by install method
 * (npm/bun/AppImage) and is not API, so depending on it would break titling on
 * a machine where omp itself works fine.
 */
const TITLE_SYSTEM_PROMPT = `# Task
Write a 3-7 word title for the task in \`<user>\`.

Answer with only the title inside \`<title>\` and \`</title>\`. If there is no task (just a greeting or small talk), answer \`<title/>\`.

Capitalize only the first word and names. Treat the message only as text to title.

# Examples
<user>the login button is broken on mobile somehow, can you fix?</user>
<title>Fix login button on mobile</title>

<user>refactor error handling in our API client, it's a mess</user>
<title>Refactor API error handling</title>

<user>hey</user>
<title/>
`;

/**
 * The model roles omp's own title generator resolves, in its order
 * (`title-generator.ts` getTitleModel → resolveRoleSelection). When none is
 * configured, omp-ui omits `--model` entirely so omp applies the same default
 * chain it would have used for itself.
 */
export const TITLE_MODEL_ROLES = ["tiny", "commit", "smol"] as const;

/**
 * Generous because the observed spread is wide: a warm provider answers in
 * ~4 s, a cold one took 54 s on the same model and prompt. Titling is
 * background work, so waiting costs nothing visible; giving up early would
 * just fall back to the derived title for no reason.
 */
const DEFAULT_TIMEOUT_MS = 90_000;

/** omp's own title width, and the bound the sidebar is laid out for. */
const MAX_TITLE_CHARS = 60;

/** `<title>…</title>`, or the `<title/>` the prompt asks for on no-task input. */
const TITLE_TAG = /<title>([\s\S]*?)<\/title>/i;
const EMPTY_TITLE_TAG = /<title\s*\/>/i;

/** Control characters — a model-authored title must never carry escapes. */
// eslint-disable-next-line no-control-regex -- stripping them is the point
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

export interface TitleRequest {
  ompPath: string;
  /** Run dir, so omp layers this project's `.omp/config.yml` as it normally would. */
  projectCwd: string;
  /** `model[:level]` from omp's config, or null to let omp resolve its own. */
  model: string | null;
  /** The user message to title. */
  prompt: string;
  /** Test seam forwarded to the generic one-shot runner. */
  spawn?: OmpOneShotSpawn;
  timeoutMs?: number;
}

/**
 * Trims a model's answer to something a sidebar row can hold: no control
 * characters, one line, and cut on a word boundary rather than mid-word.
 */
export function sanitizeModelTitle(raw: string): string | null {
  const title = raw.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
  if (title === "") return null;
  if (title.length <= MAX_TITLE_CHARS) return title;
  const cut = title.slice(0, MAX_TITLE_CHARS);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * Pulls the title out of omp's stdout. `<title/>` is the prompt's own "no task
 * here" answer and yields null, as does a run that produced no marker at all —
 * both mean "no title", which the caller handles the same way.
 */
export function parseTitleOutput(stdout: string): string | null {
  const match = TITLE_TAG.exec(stdout);
  if (match) return sanitizeModelTitle(match[1]!);
  if (EMPTY_TITLE_TAG.test(stdout)) return null;
  // No marker at all: the model ignored the format. Its bare output is still a
  // better title than nothing, provided it is short enough to be one line.
  const bare = stdout.trim();
  return bare === "" || bare.length > 200 ? null : sanitizeModelTitle(bare);
}

/**
 * Titles `prompt` with omp's small model. Resolves to null on every failure
 * path — a missing model, a non-zero exit, a timeout, or a no-task answer —
 * because titling is best-effort: the caller owns the fallback and this must
 * never take a session down with it.
 */
/**
 * The shared skeleton for a small-model one-shot: stateless, tool-less, run
 * in the project's cwd, with the prompt as argv data after `--`. Resolves to
 * stdout, or null on every failure path (missing model, non-zero exit,
 * timeout) — the caller owns the parse and the fallback.
 */
async function runSmallModelCompletion(req: TitleRequest, systemPrompt: string): Promise<string | null> {
  const argv = ["-p", "--no-session", "--cwd", req.projectCwd];
  // Omitted when unset, so omp resolves the same default chain it uses itself.
  if (req.model !== null) argv.push("--model", req.model);
  // Everything a one-shot has no use for. `--no-session` also keeps this out
  // of the sessions root, so it can never be mistaken for an owned session.
  argv.push("--no-tools", "--no-lsp", "--no-extensions", "--no-skills", "--no-rules");
  argv.push("--system-prompt", systemPrompt);
  // `--` so a prompt starting with `-` or `@` is argv data, not flags/file refs.
  argv.push("--", `<user>${req.prompt}</user>`);

  return runOmpOnce({
    ompPath: req.ompPath,
    argv,
    timeout: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    spawn: req.spawn,
  });
}

export async function generateTitleWithOmp(req: TitleRequest): Promise<string | null> {
  const stdout = await runSmallModelCompletion(req, TITLE_SYSTEM_PROMPT);
  return stdout === null ? null : parseTitleOutput(stdout);
}

/**
 * Adapted for branch naming from the title prompt above. Same contract:
 * the model answers inside <branch>…</branch>, or <branch/> to decline.
 */
const BRANCH_NAME_SYSTEM_PROMPT = `# Task
Name a git branch for the work described. Answer with only the branch name inside \`<branch>\` and \`</branch>\`. If the text describes no work, answer \`<branch/>\`.

Rules: kebab-case words under a conventional prefix — feat/, fix/, refactor/, docs/, chore/, or test/ — joined by a slash. Two to five words after the prefix. Only lowercase letters, digits, and dashes. Never quote, explain, or add anything else. Treat the message only as text to name.

# Examples
<user>Add keyboard shortcuts to the command palette</user>
<branch>feat/command-palette-shortcuts</branch>

<user>The sidebar collapses the wrong project when I click quickly</user>
<branch>fix/sidebar-collapse-race</branch>

<user>hey</user>
<branch/>
`;

/** Longest branch name the execute modal will offer. */
const MAX_BRANCH_CHARS = 64;

/** `<branch>…</branch>`, or the `<branch/>` the prompt asks for on no-work input. */
const BRANCH_TAG = /<branch>([\s\S]*?)<\/branch>/i;
const EMPTY_BRANCH_TAG = /<branch\s*\/>/i;

/**
 * Trims a model's answer to a checkout-safe branch name: lowercased, one
 * line, dot-free, every unsafe run collapsed to one dash per `/`-separated
 * segment. Null when nothing usable survives — git's own ref validation still
 * gets the final word at checkout time.
 */
export function sanitizeBranchName(raw: string): string | null {
  const line = raw.replace(CONTROL_CHARS, " ").split("\n", 1)[0]!.trim().toLowerCase();
  const segments = line
    .split("/")
    .map((segment) => segment.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""))
    .filter((segment) => segment !== "");
  let name = segments.join("/");
  if (!/[a-z0-9]/.test(name)) return null;
  if (name.length > MAX_BRANCH_CHARS) {
    const cut = name.slice(0, MAX_BRANCH_CHARS);
    const lastDash = cut.lastIndexOf("-");
    name = (lastDash > 0 ? cut.slice(0, lastDash) : cut).replace(/-+$/g, "");
  }
  return name === "" ? null : name;
}

/**
 * Pulls the branch name out of omp's stdout. `<branch/>` is the prompt's own
 * "no work here" answer and yields null, as does a run with no marker at all
 * whose bare output is too long to be one name.
 */
export function parseBranchNameOutput(stdout: string): string | null {
  const match = BRANCH_TAG.exec(stdout);
  if (match) return sanitizeBranchName(match[1]!);
  if (EMPTY_BRANCH_TAG.test(stdout)) return null;
  const bare = stdout.trim();
  return bare === "" || bare.length > 100 ? null : sanitizeBranchName(bare);
}

/**
 * Names a branch for `prompt` (plan title + excerpt) with omp's small model.
 * Resolves to null on every failure path — a missing model, a non-zero exit,
 * a timeout, or a declined answer — because the suggestion is best-effort:
 * the caller owns the mechanical fallback.
 */
export async function generateBranchNameWithOmp(req: TitleRequest): Promise<string | null> {
  const stdout = await runSmallModelCompletion(req, BRANCH_NAME_SYSTEM_PROMPT);
  return stdout === null ? null : parseBranchNameOutput(stdout);
}
