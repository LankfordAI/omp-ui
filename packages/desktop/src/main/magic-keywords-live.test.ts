import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  RpcClient,
  resolveFileMentions,
  resolveOmpBinary,
  writeCapabilitiesExtension,
} from "@omp-ui/core";
import {
  CAPABILITIES_STATUS_KEY,
  capabilitiesMessage,
  parseCapabilitySnapshot,
  type CapabilitySnapshot,
} from "@omp-ui/core/capabilities";
import {
  keywordsIn,
  MAGIC_KEYWORDS,
  withoutAccidentalKeywords,
} from "@omp-ui/core/magic-keywords";

/**
 * Live drift guards for the magic-keyword contract (issues #662, #663, #664,
 * #665) against the REAL `omp --mode=rpc-ui` binary — the same skip-when-no-
 * binary discipline as capability-control-live.test.ts.
 *
 * Every case sends genuine prompts, so the provider must never be reached:
 * the scope's models.yml points `kwprobe/inert` at port 9 (discard), and
 * retry is off — the provider connection is refused at once and the turn
 * dies. The notices are computed and frame-published long before that, in
 * the prompt path itself, so each case reads the `custom` message_start
 * frames that precede the first `user` message_start and then kills the run.
 * Nothing here waits for `agent_end`: the unreachable provider never ends
 * promptly. Real timers throughout — the awaited actor is an OS process.
 */

const ompPath = resolveOmpBinary();

const MODELS_YML = `providers:
  kwprobe:
    baseUrl: http://127.0.0.1:9/v1
    api: openai-completions
    apiKey: none
    models:
      - id: inert
        name: inert
        contextWindow: 4096
        maxTokens: 128
`;

const CONFIG_YML = `startup:
  checkUpdate: false
retry:
  enabled: false
`;

/** A prompt carrying all four words, each in matchable standalone prose. */
const ALL_WORDS = "ultrathink orchestrate workflowz jevify";

interface Frame {
  type: string;
  statusKey?: string;
  statusText?: string;
  message?: { role?: string; customType?: string };
}

interface Scope {
  base: string;
  project: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(25);
  }
}

interface ScopeOptions {
  /** The `--tools` roster, comma-separated; omp's default when omitted. */
  tools?: string;
  /** `--config` overlay files written into the scope and passed by path. */
  overlays?: { name: string; yaml: string }[];
  /** Extension sources written into the scope and passed with `-e`. */
  extensions?: { name: string; source: string }[];
  /** Append the generated capabilities bridge to the extensions. */
  capabilitiesExtension?: boolean;
  initialCommands?: { type: "prompt"; message: string }[];
  /** Verbatim contents of the project's `.omp/config.yml`. */
  projectConfig?: string;
}

function spawnScope(options: ScopeOptions): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-keyword-"));
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(home, ".omp", "agent", "models.yml"), MODELS_YML);
  fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), CONFIG_YML);
  const extensions = (options.extensions ?? []).map((ext) => {
    const file = path.join(base, ext.name);
    fs.writeFileSync(file, ext.source);
    return file;
  });
  if (options.capabilitiesExtension === true) extensions.push(writeCapabilitiesExtension(lineage));
  const overlays = (options.overlays ?? []).map((overlay) => {
    const file = path.join(base, overlay.name);
    fs.writeFileSync(file, overlay.yaml);
    return file;
  });
  if (options.projectConfig !== undefined) {
    fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
    fs.writeFileSync(path.join(project, ".omp", "config.yml"), options.projectConfig);
  }
  const frames: Frame[] = [];
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
  };
  const client = new RpcClient({
    cwd: project,
    lineageDir: lineage,
    ompPath: ompPath!,
    model: "kwprobe/inert",
    extensions,
    configOverlays: overlays,
    initialCommands: options.initialCommands ?? [],
    spawnProcess: (bin, args, extra) => {
      const finalArgs = options.tools === undefined ? args : [...args, `--tools=${options.tools}`];
      const proc = spawn(bin, finalArgs, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...extra, ...env },
      });
      return {
        stdin: proc.stdin,
        stdout: proc.stdout,
        stderr: proc.stderr,
        kill: (signal) => void proc.kill(signal),
        onExit: (cb) => proc.on("exit", (code) => cb(code)),
        onSpawnError: (cb) => proc.on("error", cb),
      };
    },
    onFrame: (frame) => frames.push(frame as Frame),
    onExit: () => markExited(),
    onError: () => {},
  });
  return { base, project, frames, client, exited };
}

/**
 * Sends one prompt and returns the notice custom types omp attached: every
 * `custom` message_start before the first `user` message_start from `from`.
 * The turn then dies on the refused provider; nothing waits for its end.
 */
async function noticesFor(scope: Scope, message: string, first: boolean): Promise<string[]> {
  const from = scope.frames.length;
  scope.client.send({ type: first ? "prompt" : "abort_and_prompt", message } as never);
  const userAt = await waitFor(
    () => {
      const index = scope.frames.findIndex(
        (frame, i) => i >= from && frame.type === "message_start" && frame.message?.role === "user",
      );
      return index >= 0 ? index : undefined;
    },
    25_000,
    "the prompt's user message_start",
  );
  const notices: string[] = [];
  for (let i = from; i < userAt; i++) {
    const frame = scope.frames[i]!;
    if (frame.type === "message_start" && frame.message?.role === "custom" && frame.message.customType) {
      notices.push(frame.message.customType);
    }
  }
  return notices;
}

/** What omp would fire for `text` under `tools`, per the port and the table. */
function expectedNotices(text: string, tools: readonly string[]): string[] {
  const armed = keywordsIn(text);
  return MAGIC_KEYWORDS.filter(
    (keyword) => armed.has(keyword.word) && keyword.requires.every((t) => tools.includes(t)),
  ).map((keyword) => `${keyword.id}-notice`);
}

async function killScope(scope: Scope): Promise<void> {
  scope.client.kill();
  const exitedNow = await Promise.race([
    scope.exited.then(() => true),
    sleep(8_000).then(() => false),
  ]);
  if (!exitedNow) scope.client.kill("SIGKILL");
  await sleep(150);
  fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const KW_TABLE_EXT = `
let table = null;
import("@oh-my-pi/pi-coding-agent/modes/magic-keywords").then(
  (mod) => { table = mod.MAGIC_KEYWORDS; },
  () => undefined,
);
export default function (pi) {
  pi.registerCommand("kw-table", {
    description: "publish omp's magic keyword table",
    handler: async (_args, ctx) => { ctx.ui.setStatus("kw-table", JSON.stringify(table ?? [])); },
  });
}
`;

let scope: Scope | null = null;
afterEach(async () => {
  if (scope !== null) {
    await killScope(scope);
    scope = null;
  }
});

describe.skipIf(ompPath === null)("magic keywords on the real runtime", () => {
  it("omp's exported table equals the port's", async () => {
    scope = spawnScope({ extensions: [{ name: "kw-table.ts", source: KW_TABLE_EXT }] });
    const before = scope.frames.length;
    scope.client.send({ type: "prompt", message: "/kw-table" } as never);
    const published = await waitFor(
      () =>
        scope!.frames
          .slice(before)
          .find((f) => f.type === "extension_ui_request" && f.statusKey === "kw-table")?.statusText,
      25_000,
      "the kw-table status publish",
    );
    const rows = JSON.parse(published) as Array<Record<string, unknown>>;
    expect(rows.map((row) => ({ id: row.id, word: row.word, hue: row.hue, requires: row.requires })))
      .toEqual(MAGIC_KEYWORDS.map((k) => ({ id: k.id, word: k.word, hue: [...k.hue], requires: [...k.requires] })));
  }, 60_000);

  it("the firing matrix equals the port and the table", async () => {
    const corpus = [
      ALL_WORDS,
      "`orchestrate` and <b>jevify</b>\n\n```\nworkflowz\n```\n\nsee orchestrate.ts, jevify_rate, re-ultrathink",
      "ULTRATHINK Orchestrate, don't jevify",
    ];
    const rosters = ["read,bash,task,eval", "read,bash,task", "read,bash,eval", "read,bash"];
    for (const tools of rosters) {
      scope = spawnScope({ tools });
      for (let i = 0; i < corpus.length; i++) {
        const notices = await noticesFor(scope, corpus[i]!, i === 0);
        expect(notices, `${tools} :: ${JSON.stringify(corpus[i])}`).toEqual(
          expectedNotices(corpus[i]!, tools.split(",")),
        );
      }
      await killScope(scope);
      scope = null;
    }
  }, 120_000);

  it("each magicKeywords setting switch drops exactly its notice", async () => {
    for (const keyword of MAGIC_KEYWORDS) {
      scope = spawnScope({
        overlays: [{ name: `kw-${keyword.id}.yml`, yaml: `magicKeywords:\n  ${keyword.id}: false\n` }],
      });
      const notices = await noticesFor(scope, ALL_WORDS, true);
      expect(notices).toEqual(
        MAGIC_KEYWORDS.filter((k) => k.id !== keyword.id).map((k) => `${k.id}-notice`),
      );
      await killScope(scope);
      scope = null;
    }
    scope = spawnScope({
      overlays: [{ name: "kw-all.yml", yaml: "magicKeywords:\n  enabled: false\n" }],
    });
    expect(await noticesFor(scope, ALL_WORDS, true)).toEqual([]);
  }, 180_000);

  it("the bridge gate reports the layered settings", async () => {
    scope = spawnScope({
      capabilitiesExtension: true,
      initialCommands: [{ type: "prompt", message: capabilitiesMessage() }],
      projectConfig: "magicKeywords:\n  orchestrate: false\n",
      overlays: [{ name: "kw-overlay.yml", yaml: "magicKeywords:\n  jevify: false\n" }],
    });
    const snapshot = await waitFor<CapabilitySnapshot>(() => {
      const published = scope!.frames
        .filter(
          (f) => f.type === "extension_ui_request" && f.statusKey === CAPABILITIES_STATUS_KEY,
        )
        .map((f) => parseCapabilitySnapshot(f.statusText))
        .reverse()
        .find((s): s is CapabilitySnapshot => s !== null);
      return published !== undefined && published.magicKeywords.status === "available"
        ? published
        : undefined;
    }, 30_000, "a snapshot with an available keyword section");
    const section = snapshot.magicKeywords;
    if (section.status !== "available") return;
    expect(section.items.map((row) => row.enabled)).toEqual([true, false, true, false]);
  }, 90_000);

  it("inert quoting holds against the real matcher", async () => {
    scope = spawnScope({});
    const quoted = withoutAccidentalKeywords(
      (q) => `Seed\n\n${q.block("We orchestrate the RPC calls\n```\nopen", "markdown")}\n\nProceed.`,
    );
    expect(await noticesFor(scope, `ultrathink\n\n${quoted}`, true)).toEqual(["ultrathink-notice"]);

    fs.writeFileSync(
      path.join(scope.project, "notes.md"),
      "notes\n```\njevify the retries\n",
    );
    const { contextText } = await resolveFileMentions(
      scope.project,
      "steer now @notes.md",
    );
    expect(await noticesFor(scope, "steer now" + contextText, false)).toEqual([]);
  }, 90_000);
});
