import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HINDSIGHT_AUTO_RETAIN_ENV,
  RpcClient,
  privateChildEnv,
  resolveOmpBinary,
  writePrivateOverlay,
} from "@omp-ui/core";

/**
 * End-to-end proof for issue #1094 against the REAL `omp --mode=rpc-ui`
 * binary and a controlled LOCAL Hindsight sink — no real memory destination
 * is ever contacted, and no real provider is billed (the model rides a
 * scripted loopback SSE completion exactly like async-jobs-live.test.ts).
 *
 * Three scopes over the same isolated HOME/project; every one talks to the
 * sink with `memory.backend: hindsight` and `hindsight.retainEveryNTurns: 1`
 * so one real turn is enough to trip the cadence:
 *
 * 1. Ordinary session, HINDSIGHT_AUTO_RETAIN exported true: the ordinary
 *    cadence retains — the sink receives the retain POST carrying the canary
 *    prompt text (ordinary sessions keep honoring their own settings).
 * 2. Private session, same export, real overlay + production child-env pin
 *    (privateChildEnv): the sink receives NO retain submission ever — not at
 *    the agent_end cadence and not across SIGTERM — while its recall request
 *    still reaches the sink (write-quiet, never read-quiet).
 * 3. Control for sink sensitivity and the documented env trap: the overlay
 *    written but WITHOUT the child pin, env exported true — upstream's
 *    env-backed handle outranks config layers, so this scope retains. If the
 *    harness could not observe a submission at all, scope 2 would prove
 *    nothing; scope 3 is what makes its silence meaningful.
 *
 * Real timers throughout (the awaited actor is an OS process over pipes);
 * every wait ends on an observed frame or sink condition.
 */

const ompPath = resolveOmpBinary();

/** Older binaries predate the hindsight gate entirely; skip the whole file. */
function binaryPublishesHindsightAutoRetain(): boolean {
  if (ompPath === null) return false;
  try {
    const out = execFileSync(ompPath, ["config", "list", "--json"], {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    return Object.keys(JSON.parse(out) as Record<string, unknown>).includes("hindsight.autoRetain");
  } catch {
    return false;
  }
}

const hindsightLive = ompPath !== null && binaryPublishesHindsightAutoRetain();

const MODELS_YML = (baseUrl: string): string =>
  [
    "providers:",
    "  hsprobe:",
    "    baseUrl: " + baseUrl,
    "    api: openai-completions",
    "    apiKey: none",
    "    models:",
    "      - id: inert",
    "        name: inert",
    "        contextWindow: 131072",
    "        maxTokens: 128",
    "",
  ].join("\n");

const AGENT_CONFIG = (sinkUrl: string): string =>
  [
    "startup:",
    "  checkUpdate: false",
    "retry:",
    "  enabled: false",
    "compaction:",
    "  enabled: false",
    "memory:",
    "  backend: hindsight",
    "hindsight:",
    "  apiUrl: " + sinkUrl,
    "  # No mental-model bootstrap noise: this proof asserts on retain traffic.",
    "  mentalModelsEnabled: false",
    "",
  ].join("\n");

/** One turn is the whole cadence: agent_end must retain immediately. */
const PROJECT_CONFIG = ["hindsight:", "  retainEveryNTurns: 1", ""].join("\n");

const CANARY = "sink-canary-1094 retention proof prompt";

interface Frame {
  type: string;
}

interface SinkHit {
  method: string;
  url: string;
  body: string;
}

interface Scope {
  base: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
  hits: SinkHit[];
}

/** The retain endpoint is POST /v1/default/banks/<bank>/memories exactly;
 *  recall rides the same prefix + "/recall" and must never be counted as a
 *  transcript submission. */
function retainHits(scope: Scope): SinkHit[] {
  return scope.hits.filter(
    (hit) => hit.method === "POST" && new URL(hit.url, "http://x").pathname.endsWith("/memories"),
  );
}

function recallHits(scope: Scope): SinkHit[] {
  return scope.hits.filter(
    (hit) => hit.method === "POST" && new URL(hit.url, "http://x").pathname.endsWith("/memories/recall"),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error("timeout waiting for " + what);
    await sleep(25);
  }
}

interface Fixture {
  providerUrl: string;
  sinkUrl: string;
  close(): Promise<void>;
}

/** Scripted SSE provider (one short "ok" completion per request) + the
 *  Hindsight sink, both on loopback. The sink records every hit verbatim. */
async function startServers(hits: SinkHit[]): Promise<Fixture> {
  const provider = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const chunk = (delta: Record<string, unknown>, finishReason: string | null): string =>
        "data: " +
        JSON.stringify({
          id: "hsprobe",
          object: "chat.completion.chunk",
          created: 0,
          model: "inert",
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(finishReason === null ? {} : { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
        }) +
        "\n\n";
      response.end(
        chunk({ role: "assistant", content: "ok" }, null) + chunk({}, "stop") + "data: [DONE]\n\n",
      );
    });
  });
  const sink = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      hits.push({
        method: request.method ?? "?",
        url: request.url ?? "?",
        body: Buffer.concat(chunks).toString("utf8"),
      });
      // Everything the client asks for succeeds with an empty object; this
      // proof asserts on what reaches the sink, never on server semantics.
      response.writeHead(200, { "Content-Type": "application/json" }).end("{}");
    });
  });
  await Promise.all([
    new Promise<void>((resolve, reject) => {
      provider.once("error", reject);
      provider.listen(0, "127.0.0.1", resolve);
    }),
    new Promise<void>((resolve, reject) => {
      sink.once("error", reject);
      sink.listen(0, "127.0.0.1", resolve);
    }),
  ]);
  const providerAddress = provider.address();
  const sinkAddress = sink.address();
  if (providerAddress === null || typeof providerAddress === "string") throw new Error("no provider port");
  if (sinkAddress === null || typeof sinkAddress === "string") throw new Error("no sink port");
  return {
    providerUrl: "http://127.0.0.1:" + providerAddress.port + "/v1",
    sinkUrl: "http://127.0.0.1:" + sinkAddress.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        provider.closeAllConnections();
        sink.closeAllConnections();
        let open = 2;
        const done = (): void => {
          open -= 1;
          if (open === 0) resolve();
        };
        provider.close((error) => (error ? reject(error) : done()));
        sink.close((error) => (error ? reject(error) : done()));
      }),
  };
}

async function spawnScope(fixture: Fixture, hits: SinkHit[], opts: { privateSession: boolean; pin: boolean }): Promise<Scope> {
  // Both scopes run with the user's export present; only the pinned spawn
  // carries the child-env override (production: privateChildEnv(record.private)).
  vi.stubEnv(HINDSIGHT_AUTO_RETAIN_ENV, "true");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-hslive-"));
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
  fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
  fs.mkdirSync(lineage, { recursive: true });
  fs.writeFileSync(path.join(home, ".omp", "agent", "models.yml"), MODELS_YML(fixture.providerUrl));
  fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), AGENT_CONFIG(fixture.sinkUrl));
  fs.writeFileSync(path.join(project, ".omp", "config.yml"), PROJECT_CONFIG);
  const overlay = writePrivateOverlay(lineage, opts.privateSession);
  const frames: Frame[] = [];
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  const client = new RpcClient({
    cwd: project,
    lineageDir: lineage,
    ompPath: ompPath!,
    model: "hsprobe/inert",
    configOverlays: overlay === null ? [] : [overlay],
    childEnv: privateChildEnv(opts.pin),
    spawnProcess: (bin, args, extra) => {
      const env: NodeJS.ProcessEnv = {
        ...extra,
        HOME: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local", "share"),
      };
      // Keep the production-computed retention gate, but never inherit a
      // real Hindsight destination, token, or other setting override.
      for (const key of Object.keys(env)) {
        if (key.startsWith("HINDSIGHT_") && key !== HINDSIGHT_AUTO_RETAIN_ENV) delete env[key];
      }
      const proc = spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env,
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
  return { base, frames, client, exited, hits };
}

/** One run of the scripted turn: prompt with the canary, wait for its
 *  agent_end (which is where upstream's retention listener fires). */
async function runTurn(scope: Scope): Promise<void> {
  scope.client.send({ type: "prompt", message: CANARY } as never);
  await waitFor(
    () => (scope.frames.some((frame) => frame.type === "agent_end") ? true : undefined),
    120_000,
    "the canary turn's agent_end",
  );
}

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dispose of disposers.splice(0)) await dispose();
});

async function makeScope(opts: { privateSession: boolean; pin: boolean }): Promise<Scope> {
  const hits: SinkHit[] = [];
  const fixture = await startServers(hits);
  const scope = await spawnScope(fixture, hits, opts);
  disposers.push(async () => {
    scope.client.kill();
    const exitedNow = await Promise.race([
      scope.exited.then(() => true),
      sleep(8_000).then(() => false),
    ]);
    if (!exitedNow) scope.client.kill("SIGKILL");
    await sleep(150);
    fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    await fixture.close();
  });
  return scope;
}

describe.skipIf(!hindsightLive)("Hindsight retention on the real runtime against a local sink", () => {
  it("an ordinary session retains at the cadence, carrying the transcript", { timeout: 300_000 }, async () => {
    const scope = await makeScope({ privateSession: false, pin: false });
    await runTurn(scope);
    const retained = await waitFor(
      () => (retainHits(scope).length > 0 ? retainHits(scope) : undefined),
      60_000,
      "the ordinary cadence retain",
    );
    expect(retained[0]!.body).toContain(CANARY);
  });

  it("a private session never submits transcript content, pin plus overlay", { timeout: 300_000 }, async () => {
    const scope = await makeScope({ privateSession: true, pin: true });
    await runTurn(scope);
    // The agent_end path is fire-and-forget-async: give it the retain queue's
    // full 5 s flush ceiling twice over before reading the silence as proof.
    await sleep(12_000);
    expect(retainHits(scope)).toHaveLength(0);
    // Recall is the read channel and stays alive (write-quiet, not
    // read-quiet): the first-turn auto recall reaches the sink.
    expect(recallHits(scope).length).toBeGreaterThan(0);
    // The boundary path is silent too: SIGTERM must not flush a retain.
    scope.client.kill();
    await Promise.race([scope.exited, sleep(8_000)]);
    await sleep(2_000);
    expect(retainHits(scope)).toHaveLength(0);
  });

  it("the overlay alone loses to the exported env var — why the child pin exists", { timeout: 300_000 }, async () => {
    // Control scope: real overlay, env exported true, NO child pin (the
    // pre-#1094 behavior). Upstream's env handle outranks the config layers,
    // so this one retains: proof the sink observes submissions at all, and
    // proof the pin — not luck — is what keeps the private scope silent.
    const scope = await makeScope({ privateSession: true, pin: false });
    await runTurn(scope);
    const retained = await waitFor(
      () => (retainHits(scope).length > 0 ? retainHits(scope) : undefined),
      60_000,
      "the control scope's env-driven retain",
    );
    expect(retained[0]!.body).toContain(CANARY);
  });
});
