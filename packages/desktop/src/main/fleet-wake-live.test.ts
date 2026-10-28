import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient, resolveOmpBinary, writeFleetWakeExtension } from "@omp-ui/core";
import {
  FLEET_WAKE_CUSTOM_TYPE,
  FLEET_WAKE_STATUS_KEY,
  fleetWakeArmMessage,
  fleetWakeCommandId,
  type FleetWakeCard,
} from "@omp-ui/core/fleet-wake";

/**
 * Live proof for the generated fleet-wake bridge (#957) against the real
 * `omp --mode=rpc-ui` binary, with only that bridge loaded. A local
 * OpenAI-compatible SSE provider holds every completion until the test
 * releases it, so turn boundaries are observed rather than timed, and no
 * path can bill a model provider. HOME/XDG and the lineage are isolated per
 * scope. Real timers throughout: the awaited actor is an OS process.
 *
 * The claims are the ones the orchestrating session would notice if they broke:
 * 1. An arm on an idle session lands a visible fleet-wake message carrying the
 *    card and starts exactly one turn.
 * 2. An arm while a turn streams queues as a follow-up: no new model request
 *    until the running completion ends, then a second turn delivers it.
 * 3. Re-arming a wake the transcript already holds (a resumed process, the
 *    crash-after-persist case) adds no second copy and acknowledges the id.
 */

const ompPath = resolveOmpBinary();

const MODELS_YML = `providers:
  fleetprobe:
    baseUrl: http://127.0.0.1:9/v1
    api: openai-completions
    apiKey: none
    models:
      - id: inert
        name: inert
        contextWindow: 131072
        maxTokens: 128
`;

const CONFIG_YML = `startup:
  checkUpdate: false
retry:
  enabled: false
`;

interface Frame {
  type: string;
  id?: string;
  method?: string;
  success?: boolean;
  status?: string;
  data?: { sessionId?: string; isStreaming?: boolean };
  statusKey?: string;
  statusText?: string;
  message?: { role?: string; customType?: string; display?: boolean; content?: unknown; details?: unknown };
}

interface Dirs {
  base: string;
  project: string;
  lineage: string;
  home: string;
}

interface Scope {
  dirs: Dirs;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
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

function makeDirs(providerBaseUrl: string): Dirs {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-fleetwake-"));
  const dirs = {
    base,
    project: path.join(base, "proj"),
    lineage: path.join(base, "lin"),
    home: path.join(base, "home"),
  };
  fs.mkdirSync(path.join(dirs.home, ".omp", "agent"), { recursive: true });
  fs.mkdirSync(dirs.lineage, { recursive: true });
  fs.mkdirSync(dirs.project, { recursive: true });
  fs.writeFileSync(
    path.join(dirs.home, ".omp", "agent", "models.yml"),
    MODELS_YML.replace("http://127.0.0.1:9/v1", providerBaseUrl),
  );
  fs.writeFileSync(path.join(dirs.home, ".omp", "agent", "config.yml"), CONFIG_YML);
  return dirs;
}

interface SpawnOptions {
  initialCommands?: { type: "prompt"; message: string; id?: string }[];
  resumeSessionId?: string;
}

/** Spawns omp with only the generated fleet-wake bridge, written the way every rpc spawn writes it. */
function spawnScope(dirs: Dirs, options: SpawnOptions = {}): Scope {
  const frames: Frame[] = [];
  const { promise: exited, resolve: markExited } = Promise.withResolvers<void>();
  const env = {
    ...process.env,
    HOME: dirs.home,
    XDG_CONFIG_HOME: path.join(dirs.home, ".config"),
    XDG_DATA_HOME: path.join(dirs.home, ".local", "share"),
  };
  const client = new RpcClient({
    cwd: dirs.project,
    lineageDir: dirs.lineage,
    ompPath: ompPath!,
    model: "fleetprobe/inert",
    ...(options.resumeSessionId !== undefined ? { resumeSessionId: options.resumeSessionId } : {}),
    extensions: [writeFleetWakeExtension(dirs.lineage)],
    initialCommands: options.initialCommands ?? [],
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
  return { dirs, frames, client, exited };
}

interface ControlledProvider {
  baseUrl: string;
  requests: ServerResponse[];
  complete(index: number): void;
  close(): Promise<void>;
}

/** Local OpenAI-compatible stream, held until the test releases each completion. */
async function controlledProvider(): Promise<ControlledProvider> {
  const requests: ServerResponse[] = [];
  const chunk = (index: number, delta: { role?: string; content?: string }, finishReason: "stop" | null) =>
    `data: ${JSON.stringify({
      id: `fleetprobe-${index}`,
      object: "chat.completion.chunk",
      created: 0,
      model: "inert",
      choices: [{ index: 0, delta, finish_reason: finishReason }],
      ...(finishReason === "stop" ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
    })}\n\n`;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    request.on("end", () => {
      const index = requests.length;
      requests.push(response);
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      response.write(chunk(index, { role: "assistant", content: "fixture reply" }, null));
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
    requests,
    complete(index: number) {
      const response = requests[index];
      if (response === undefined || response.writableEnded) throw new Error(`no held request ${index}`);
      response.end(chunk(index, {}, "stop") + "data: [DONE]\n\n");
    },
    close: () => new Promise<void>((resolve, reject) => {
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

let requestSequence = 0;
async function request(scope: Scope, command: Record<string, unknown>): Promise<Frame> {
  const id = `fleet-wake-live-${++requestSequence}`;
  scope.client.send({ ...command, id } as never);
  return waitFor(
    () => scope.frames.find((frame) => frame.type === "response" && frame.id === id),
    25_000,
    `the response to ${command.type}`,
  );
}

async function stopProcess(scope: Scope): Promise<void> {
  scope.client.kill();
  const exitedNow = await Promise.race([
    scope.exited.then(() => true),
    sleep(8_000).then(() => false),
  ]);
  if (!exitedNow) scope.client.kill("SIGKILL");
  await sleep(150);
}

function card(wakeId: string): FleetWakeCard {
  return {
    wakeId,
    dispatchId: wakeId.split(".")[0]!,
    kind: "result",
    title: "Probe child",
    machine: "this computer",
    childTabId: "tab-probe-child",
    outcome: "complete",
  };
}

const armFor = (wakeId: string, text: string) => ({
  type: "prompt" as const,
  id: fleetWakeCommandId(wakeId),
  message: fleetWakeArmMessage({ card: card(wakeId), text }),
});

/** Every fleet-wake custom message_end at or after `from`. */
function wakeEnds(scope: Scope, from = 0): Frame[] {
  return scope.frames.filter(
    (frame, i) =>
      i >= from &&
      frame.type === "message_end" &&
      frame.message?.role === "custom" &&
      frame.message.customType === FLEET_WAKE_CUSTOM_TYPE,
  );
}

function agentEnds(scope: Scope): number {
  return scope.frames.filter((frame) => frame.type === "agent_end").length;
}

const scopes: Scope[] = [];
const bases: string[] = [];
let provider: ControlledProvider | null = null;
afterEach(async () => {
  for (const scope of scopes.splice(0)) await stopProcess(scope);
  for (const base of bases.splice(0)) fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (provider !== null) {
    await provider.close();
    provider = null;
  }
});

function track(scope: Scope): Scope {
  scopes.push(scope);
  return scope;
}

async function freshDirs(): Promise<{ dirs: Dirs; provider: ControlledProvider }> {
  provider = await controlledProvider();
  const dirs = makeDirs(provider.baseUrl);
  bases.push(dirs.base);
  return { dirs, provider };
}

describe.skipIf(ompPath === null)("fleet wake bridge on the real runtime", () => {
  it("an idle arm lands one visible fleet-wake message and starts one turn", { timeout: 120_000 }, async () => {
    const { dirs, provider: model } = await freshDirs();
    const wakeId = "fd-idle.result";
    const text = "Fleet result probe text";
    const scope = track(spawnScope(dirs, { initialCommands: [armFor(wakeId, text)] }));

    const [delivered] = await waitFor(
      () => {
        const ends = wakeEnds(scope);
        return ends.length > 0 ? ends : undefined;
      },
      60_000,
      "the fleet-wake message_end",
    );
    expect(delivered!.message).toMatchObject({
      role: "custom",
      customType: FLEET_WAKE_CUSTOM_TYPE,
      display: true,
      details: { wakeId },
    });
    expect(JSON.stringify(delivered!.message?.content)).toContain(text);
    await waitFor(() => scope.frames.some((f) => f.type === "agent_start") ? true : undefined, 25_000, "agent_start");
    await waitFor(() => model.requests.length === 1 ? true : undefined, 25_000, "the wake turn's model request");

    model.complete(0);
    await waitFor(() => agentEnds(scope) > 0 ? true : undefined, 25_000, "the wake turn's agent_end");
    // A get_state round trip orders after every frame omp emitted before it.
    expect((await request(scope, { type: "get_state" })).data).toMatchObject({ isStreaming: false });
    expect(model.requests).toHaveLength(1);
    expect(wakeEnds(scope)).toHaveLength(1);
    expect(scope.frames.filter((f) => f.type === "extension_ui_request" && f.method === "notify")).toEqual([]);
  });

  it("an arm during a running turn waits for it, then runs as a follow-up", { timeout: 120_000 }, async () => {
    const { dirs, provider: model } = await freshDirs();
    const wakeId = "fd-busy.result";
    const scope = track(spawnScope(dirs));
    const accepted = await request(scope, { type: "prompt", message: "hello" });
    expect(accepted.success).toBe(true);
    await waitFor(() => model.requests.length === 1 ? true : undefined, 25_000, "the held user completion");

    const beforeArm = scope.frames.length;
    const arm = armFor(wakeId, "Busy probe text");
    scope.client.send(arm as never);
    // The arm's prompt_result settles once the bridge has handed the message
    // to omp; held mid-turn, it must queue, so no second request may start.
    const settled = await waitFor(
      () => scope.frames.find((f) => f.type === "prompt_result" && f.id === arm.id),
      25_000,
      "the busy arm's prompt_result",
    );
    expect(settled.status).toBe("completed");
    expect(scope.frames.filter((f) => f.type === "response" && f.id === arm.id && f.success === false)).toEqual([]);
    expect(model.requests).toHaveLength(1);
    expect(wakeEnds(scope, beforeArm)).toEqual([]);
    const state = await request(scope, { type: "get_state" });
    expect(state.data).toMatchObject({ isStreaming: true });

    model.complete(0);
    await waitFor(() => model.requests.length === 2 ? true : undefined, 25_000, "the follow-up wake request");
    const ends = wakeEnds(scope, beforeArm);
    expect(ends).toHaveLength(1);
    expect(ends[0]!.message).toMatchObject({ display: true, details: { wakeId } });

    model.complete(1);
    await waitFor(() => scope.frames.some((f) => f.type === "agent_end") ? true : undefined, 25_000, "agent_end");
    expect((await request(scope, { type: "get_state" })).data).toMatchObject({ isStreaming: false });
    expect(model.requests).toHaveLength(2);
    expect(wakeEnds(scope)).toHaveLength(1);
  });

  it("re-arming a wake the resumed branch already holds adds no copy and acknowledges it", { timeout: 180_000 }, async () => {
    const { dirs, provider: model } = await freshDirs();
    const wakeId = "fd-again.result";
    const first = track(spawnScope(dirs, { initialCommands: [armFor(wakeId, "Again probe text")] }));
    await waitFor(() => model.requests.length === 1 ? true : undefined, 60_000, "the first wake request");
    model.complete(0);
    await waitFor(() => agentEnds(first) > 0 ? true : undefined, 25_000, "the first wake turn's agent_end");
    expect(wakeEnds(first)).toHaveLength(1);
    const state = await request(first, { type: "get_state" });
    const sessionId = state.data?.sessionId;
    expect(typeof sessionId).toBe("string");
    await stopProcess(scopes.splice(scopes.indexOf(first), 1)[0]!);

    // A new process (main re-arms whatever the ledger still stages) on the same transcript.
    const second = track(
      spawnScope(dirs, { resumeSessionId: sessionId!, initialCommands: [armFor(wakeId, "Again probe text")] }),
    );
    const ack = await waitFor(
      () =>
        second.frames.find(
          (f) => f.type === "extension_ui_request" && f.method === "setStatus" && f.statusKey === FLEET_WAKE_STATUS_KEY,
        ),
      60_000,
      "the fleet-wake acknowledgement",
    );
    expect(JSON.parse(ack.statusText!)).toEqual({ wakeId });
    await waitFor(
      () => second.frames.find((f) => f.type === "prompt_result" && f.id === fleetWakeCommandId(wakeId)),
      25_000,
      "the re-arm's prompt_result",
    );
    expect((await request(second, { type: "get_state" })).data).toMatchObject({ isStreaming: false });
    expect(wakeEnds(second)).toEqual([]);
    expect(second.frames.filter((f) => f.type === "agent_start")).toEqual([]);
    expect(model.requests).toHaveLength(1);
  });
});
