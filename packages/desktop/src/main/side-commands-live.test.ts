import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  RpcClient,
  compareVersions,
  readInstalledOmpVersion,
  resolveOmpBinary,
  writeSideCommandsExtension,
} from "@omp-ui/core";
import {
  SIDE_COMMANDS_COMMAND,
  SIDE_COMMANDS_STATUS_KEY,
  parseSideCommandsSnapshot,
  sideCommandRenderMessage,
  sideCommandsArmMessage,
  type SideCommandRenderRequest,
  type SideCommandsSnapshot,
} from "@omp-ui/core/side-commands";

/**
 * Live drift guard for the side-commands bridge (issue #955) against the REAL
 * `omp --mode=rpc-ui`: omp loads the generated extension, the arm publishes
 * the live session's `side: true` file commands over `omp-ui:side-commands`,
 * a render request expands one command with omp's own
 * `renderFileSlashCommand` (argument splitting plus Handlebars), a non-side
 * command answers `not-side`, and a render sent while a main turn is
 * streaming answers without queuing and without a transcript row.
 *
 * A hermetic HOME points `sideprobe/inert` at a loopback provider that holds
 * every completion open, so the main turn stays streaming until the scope is
 * killed. Real timers throughout: the awaited actor is an OS process, and
 * every wait polls an observed frame, never a guessed duration.
 *
 * Skips without an omp binary, and below omp 18.13.0 (the first omp whose
 * file commands carry `side`).
 */

const ompPath = resolveOmpBinary();
const SIDE_COMMANDS_FLOOR = "18.13.0";

const MODELS_YML = (baseUrl: string): string => `providers:
  sideprobe:
    baseUrl: ${baseUrl}
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

const SITREP_MD = `---
description: Situation report
side: true
---
Give a sitrep about $ARGUMENTS. First arg: $1. Handlebars: {{ARGUMENTS}}`;

const PLAIN_MD = `---
description: An ordinary prompt command
---
Say plainly: $ARGUMENTS`;

const SITREP_TEXT = "Give a sitrep about alpha beta gamma. First arg: alpha. Handlebars: alpha beta gamma";

interface Frame {
  type: string;
  id?: string;
  success?: boolean;
  statusKey?: string;
  statusText?: string;
  message?: unknown;
  commands?: Array<{ name?: string }>;
}

interface Scope {
  base: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}

interface HeldProvider {
  baseUrl: string;
  close(): Promise<void>;
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

/** Streams one assistant chunk per completion and never ends it: the turn stays streaming. */
async function heldProvider(): Promise<HeldProvider> {
  const held: ServerResponse[] = [];
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    request.on("end", () => {
      held.push(response);
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      response.write(
        `data: ${JSON.stringify({
          id: "held",
          object: "chat.completion.chunk",
          created: 0,
          model: "inert",
          choices: [{ index: 0, delta: { role: "assistant", content: "working" }, finish_reason: null }],
        })}\n\n`,
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no loopback provider port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const response of held) response.destroy();
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function spawnScope(baseUrl: string): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-side-commands-live-"));
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  const home = path.join(base, "home");
  const commands = path.join(project, ".omp", "commands");
  fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(commands, { recursive: true });
  fs.writeFileSync(path.join(home, ".omp", "agent", "models.yml"), MODELS_YML(baseUrl));
  fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), CONFIG_YML);
  fs.writeFileSync(path.join(commands, "sitrep.md"), SITREP_MD);
  fs.writeFileSync(path.join(commands, "plain.md"), PLAIN_MD);
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
    model: "sideprobe/inert",
    extensions: [writeSideCommandsExtension(lineage)],
    spawnProcess: (bin, args, extra) => {
      const proc = spawn(bin, args, {
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
  return { base, frames, client, exited };
}

async function kill(scope: Scope): Promise<void> {
  scope.client.kill();
  const exitedNow = await Promise.race([scope.exited.then(() => true), sleep(8_000).then(() => false)]);
  if (!exitedNow) scope.client.kill("SIGKILL");
  await sleep(150);
  fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const disposers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

/** The first parseable side-commands snapshot at or after `from` that satisfies `match`. */
function snapshotAfter(
  scope: Scope,
  from: number,
  match: (snapshot: SideCommandsSnapshot) => boolean,
): SideCommandsSnapshot | undefined {
  for (let i = from; i < scope.frames.length; i++) {
    const frame = scope.frames[i]!;
    if (frame.type !== "extension_ui_request" || frame.statusKey !== SIDE_COMMANDS_STATUS_KEY) continue;
    const snapshot = parseSideCommandsSnapshot(frame.statusText);
    if (snapshot !== null && match(snapshot)) return snapshot;
  }
  return undefined;
}

/** Sends one render and waits for the snapshot carrying its result. */
async function render(scope: Scope, request: SideCommandRenderRequest): Promise<SideCommandsSnapshot> {
  const from = scope.frames.length;
  scope.client.send({ type: "prompt", message: sideCommandRenderMessage(request) } as never);
  return waitFor(
    () => snapshotAfter(scope, from, (snapshot) => snapshot.result?.requestId === request.requestId),
    30_000,
    `the ${request.requestId} render result`,
  );
}

/** Transcript frames carrying `needle`; a side command must never produce one. */
function transcriptCarrying(scope: Scope, needle: string): Frame[] {
  return scope.frames.filter(
    (f) =>
      (f.type === "message_start" || f.type === "message_update" || f.type === "message_end") &&
      JSON.stringify(f.message ?? "").includes(needle),
  );
}

describe.skipIf(!ompPath)("side-commands bridge live (real omp)", () => {
  let version: string | null = null;
  beforeAll(async () => {
    version = await readInstalledOmpVersion(ompPath!);
  });

  it("publishes the side set and renders with omp's own expander, mid-turn included", { timeout: 180_000 }, async (ctx) => {
    if (version === null || compareVersions(version, SIDE_COMMANDS_FLOOR) < 0) {
      return ctx.skip(`omp ${version ?? "unknown"} predates side file commands (${SIDE_COMMANDS_FLOOR})`);
    }
    const provider = await heldProvider();
    const scope = spawnScope(provider.baseUrl);
    disposers.push(async () => {
      await kill(scope);
      await provider.close();
    });
    // omp calls setSlashCommands before it announces the catalog, so the
    // live list carries both file commands once this frame lands.
    scope.client.send({ type: "get_state", id: "ready-probe" } as never);
    await waitFor(
      () =>
        scope.frames.find(
          (f) =>
            f.type === "available_commands_update" &&
            (f.commands ?? []).some((c) => c.name === "sitrep") &&
            (f.commands ?? []).some((c) => c.name === SIDE_COMMANDS_COMMAND),
        ),
      90_000,
      "sitrep and the bridge command in available_commands_update",
    );

    // 1. The arm binds the root through the prompt wrapper and publishes
    //    exactly the side: true file commands.
    const armFrom = scope.frames.length;
    scope.client.send({ type: "prompt", message: sideCommandsArmMessage() } as never);
    const armed = await waitFor(() => snapshotAfter(scope, armFrom, () => true), 30_000, "the armed snapshot");
    expect(armed.available, `unavailable: ${armed.unavailable}`).toBe(true);
    expect(armed.unavailable).toBeNull();
    expect(armed.commands).toEqual(["sitrep"]);

    // 2. omp's renderFileSlashCommand: shell-style argument split, $1, and Handlebars.
    const rendered = await render(scope, { requestId: "r1", name: "sitrep", args: 'alpha "beta gamma"' });
    expect(rendered.result).toEqual({ requestId: "r1", ok: true, question: SITREP_TEXT });
    expect(rendered.revision).toBeGreaterThan(armed.revision);

    // 3. A file command without side: true is not the bridge's to render.
    const plain = await render(scope, { requestId: "r2", name: "plain", args: "anything" });
    expect(plain.result).toEqual({ requestId: "r2", ok: false, reason: "not-side", message: null });

    // 4. Mid-turn: the held provider keeps the main turn streaming, and the
    //    render still answers without queuing behind it or steering it.
    const turnFrom = scope.frames.length;
    scope.client.send({ type: "prompt", message: "hello" } as never);
    await waitFor(
      () => (scope.frames.some((f, i) => i >= turnFrom && f.type === "agent_start") ? true : undefined),
      60_000,
      "the main turn's agent_start",
    );
    const midTurn = await render(scope, { requestId: "r3", name: "sitrep", args: 'alpha "beta gamma"' });
    expect(midTurn.result).toEqual({ requestId: "r3", ok: true, question: SITREP_TEXT });
    expect(scope.frames.slice(turnFrom).some((f) => f.type === "agent_end")).toBe(false);

    // The expanded text rode only the status channel, never the transcript.
    expect(transcriptCarrying(scope, "Give a sitrep")).toEqual([]);
  });
});
