import { spawn } from "node:child_process";
import * as path from "node:path";

/**
 * Session titles from omp's own small model.
 *
 * omp titles itself only in the TUI (`input-controller.ts`
 * #maybeStartTitleGeneration); `--mode=rpc-ui` never does, and the rpc
 * protocol exposes no "generate a title" command (v17.1.8) — only
 * `set_session_name`, which takes a literal string. Nor can omp-ui call the
 * model itself: the API keys, provider catalog, and credential rotation all
 * live inside omp.
 *
 * So the title comes from the one surface that does have all of that: a short
 * `omp -p` run against the model omp's own config binds to the title roles.
 * Everything that would make it slow or stateful is switched off — no session
 * file, no tools, no LSP, no extensions/skills/rules — leaving a single
 * completion whose stdout is the title.
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

export interface TitleProcess {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(): void;
  onExit(cb: (code: number | null) => void): void;
  onSpawnError(cb: (err: Error) => void): void;
}

export type TitleSpawnFn = (
  ompPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => TitleProcess;

export interface TitleRequest {
  ompPath: string;
  /** Run dir, so omp layers this project's `.omp/config.yml` as it normally would. */
  projectCwd: string;
  /** `model[:level]` from omp's config, or null to let omp resolve its own. */
  model: string | null;
  /** The user message to title. */
  prompt: string;
  /** Test seam — defaults to child_process.spawn over pipes. */
  spawnProcess?: TitleSpawnFn;
  timeoutMs?: number;
}

function defaultSpawn(ompPath: string, args: string[], env: NodeJS.ProcessEnv): TitleProcess {
  const child = spawn(ompPath, args, { stdio: ["ignore", "pipe", "pipe"], env });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => child.kill(),
    onExit: (cb) => child.on("close", cb),
    onSpawnError: (cb) => child.on("error", cb),
  };
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
export async function generateTitleWithOmp(req: TitleRequest): Promise<string | null> {
  const args = ["-p", "--no-session", "--cwd", req.projectCwd];
  // Omitted when unset, so omp resolves the same default chain it uses itself.
  if (req.model !== null) args.push("--model", req.model);
  // Everything a title run has no use for. `--no-session` also keeps this out
  // of the sessions root, so it can never be mistaken for an owned session.
  args.push("--no-tools", "--no-lsp", "--no-extensions", "--no-skills", "--no-rules");
  args.push("--system-prompt", TITLE_SYSTEM_PROMPT);
  // `--` so a prompt starting with `-` or `@` is argv data, not flags/file refs.
  args.push("--", `<user>${req.prompt}</user>`);

  // Same shim-proofing as spawnOmp: keep the resolved binary's dir on PATH.
  const env = {
    ...process.env,
    PATH: [path.dirname(req.ompPath), process.env.PATH].filter(Boolean).join(path.delimiter),
  };

  const spawnProcess = req.spawnProcess ?? defaultSpawn;
  let child: TitleProcess;
  try {
    child = spawnProcess(req.ompPath, args, env);
  } catch {
    return null;
  }

  return new Promise<string | null>((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (title: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(title);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, req.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    // Drained but discarded: omp writes its "Working..." spinner here, and an
    // unread pipe would eventually stall the child.
    child.stderr.on("data", () => {});
    child.onSpawnError(() => finish(null));
    child.onExit((code) => finish(code === 0 ? parseTitleOutput(stdout) : null));
  });
}
