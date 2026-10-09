import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
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
import { reduceAgentEvent, type ObservedTabRuntime } from "../renderer/src/store/slices/reduce-agent-event";
import { rpcTabState } from "../renderer/src/test/fixtures";

/**
 * Live drift guards for the magic-keyword contract (issues #662, #663, #664,
 * #665, #726) against the REAL `omp --mode=rpc-ui` binary — the same
 * skip-when-no-binary discipline as capability-control-live.test.ts.
 *
 * Every scope isolates its model, config, HOME and lineage. Matrix prompts
 * use an unreachable loopback provider; the queued-input proof uses a local
 * deterministic SSE provider whose completion boundary the test controls.
 * Neither path can bill a model provider. Captured notice/user frames are
 * reduced by the renderer's real pure reducer, not a second keyword reducer.
 * Real timers throughout — the awaited actor is an OS process.
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
  id?: string;
  success?: boolean;
  data?: { isStreaming?: boolean; queuedMessages?: { steering: string[]; followUp: string[] } };
  statusKey?: string;
  statusText?: string;
  message?: { role?: string; customType?: string; display?: boolean };
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
  /** A deterministic loopback provider; otherwise use the unreachable model. */
  providerBaseUrl?: string;
}

function spawnScope(options: ScopeOptions): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-keyword-"));
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(
    path.join(home, ".omp", "agent", "models.yml"),
    options.providerBaseUrl === undefined
      ? MODELS_YML
      : MODELS_YML
          .replace("http://127.0.0.1:9/v1", options.providerBaseUrl)
          .replace("contextWindow: 4096", "contextWindow: 131072"),
  );
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

/** Captures the entire notice/user input batch, including both message edges. */
async function inputFramesFor(scope: Scope, message: string, first: boolean): Promise<Frame[]> {
  const from = scope.frames.length;
  scope.client.send({ type: first ? "prompt" : "abort_and_prompt", message } as never);
  const userEndAt = await waitFor(
    () => {
      const index = scope.frames.findIndex(
        (frame, i) => i >= from && frame.type === "message_end" && frame.message?.role === "user",
      );
      return index >= 0 ? index : undefined;
    },
    25_000,
    "the prompt's user message_end",
  );
  return scope.frames.slice(from, userEndAt + 1);
}

function noticeTypes(frames: readonly Frame[]): string[] {
  return frames.flatMap((frame) =>
    frame.type === "message_start" && frame.message?.role === "custom" && frame.message.customType
      ? [frame.message.customType]
      : [],
  );
}

function inputLifecycle(frames: readonly Frame[]) {
  return frames.flatMap<{ type: string; role: string; customType?: string; display?: boolean }>((frame) => {
    if (frame.type !== "message_start" && frame.type !== "message_end") return [];
    const message = frame.message;
    if (message?.role === "custom") {
      return [{ type: frame.type, role: message.role, customType: message.customType, display: message.display }];
    }
    return message?.role === "user" ? [{ type: frame.type, role: message.role }] : [];
  });
}

function expectedInputLifecycle(notices: readonly string[]) {
  return [
    ...notices.flatMap((customType) => [
      { type: "message_start", role: "custom", customType, display: false },
      { type: "message_end", role: "custom", customType, display: false },
    ]),
    { type: "message_start", role: "user" },
    { type: "message_end", role: "user" },
  ];
}

/** Apply only the actual reducer's state patches; never infer activation from text. */
function activeKeywordsAfter(frames: readonly Frame[]) {
  let tab = rpcTabState();
  let runtime: ObservedTabRuntime = {
    quietWedgeNotified: false,
    timedOutCommands: [],
    pendingTurnKeywords: [],
    keywordInputBatchStarted: false,
    liveRecap: [],
    planReadSequence: 0,
    livePendingFeedback: [],
    pendingNotices: [],
    slashCommandItems: new Map(),
    capabilitiesGeneration: 0,
    vibeRequests: new Map(),
    lastFrameAt: 0,
  };
  for (const [index, frame] of frames.entries()) {
    const reduction = reduceAgentEvent(tab, { ...runtime, lastFrameAt: index }, frame);
    tab = { ...tab, ...reduction.patch.rpc };
    runtime = { ...runtime, ...reduction.patch.runtime };
  }
  return tab.activeTurnKeywords;
}

/** What omp would fire for `text` under `tools`, per the port and the table. */
function expectedNotices(text: string, tools: readonly string[]): string[] {
  const armed = keywordsIn(text);
  return MAGIC_KEYWORDS.filter(
    (keyword) => armed.has(keyword.word) && keyword.requires.every((t) => tools.includes(t)),
  ).map((keyword) => `${keyword.id}-notice`);
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
      id: `kwprobe-${index}`,
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
  const id = `keyword-live-${++requestSequence}`;
  scope.client.send({ ...command, id } as never);
  return waitFor(
    () => scope.frames.find((frame) => frame.type === "response" && frame.id === id),
    25_000,
    `the response to ${command.type}`,
  );
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
let provider: ControlledProvider | null = null;
afterEach(async () => {
  if (scope !== null) {
    await killScope(scope);
    scope = null;
  }
  if (provider !== null) {
    await provider.close();
    provider = null;
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

  it("publishes hidden canonical notice start/end pairs before consuming the user", async () => {
    scope = spawnScope({ tools: "read,bash,task,eval" });
    const frames = await inputFramesFor(scope, ALL_WORDS, true);
    const notices = ["ultrathink-notice", "orchestrate-notice", "workflow-notice", "jevify-notice"];
    expect(inputLifecycle(frames)).toEqual(expectedInputLifecycle(notices));
    expect(frames.filter((frame) => frame.type === "agent_start" || frame.type === "turn_start").map((frame) => frame.type))
      .toEqual(["agent_start", "turn_start"]);
    const firstNoticeAt = frames.findIndex((frame) => frame.type === "message_start" && frame.message?.role === "custom");
    expect(frames.findIndex((frame) => frame.type === "turn_start")).toBeLessThan(firstNoticeAt);
    const userAt = frames.findIndex((frame) => frame.type === "message_start" && frame.message?.role === "user");
    expect(userAt).toBeGreaterThan(0);
    expect(activeKeywordsAfter(frames.slice(0, userAt))).toEqual([]);
    expect(activeKeywordsAfter(frames.slice(0, userAt + 1))).toEqual(MAGIC_KEYWORDS.map((keyword) => keyword.word));
    expect(activeKeywordsAfter(frames)).toEqual(MAGIC_KEYWORDS.map((keyword) => keyword.word));
  }, 60_000);

  it("accepts a queued keyword without notices, then activates it only when consumed in the same run", async () => {
    provider = await controlledProvider();
    scope = spawnScope({ tools: "read,bash,task,eval", providerBaseUrl: provider.baseUrl });
    const initial = await inputFramesFor(scope, "ultrathink", true);
    expect(inputLifecycle(initial)).toEqual(expectedInputLifecycle(["ultrathink-notice"]));
    expect(activeKeywordsAfter(initial)).toEqual(["ultrathink"]);
    await waitFor(() => provider!.requests.length === 1 ? true : undefined, 25_000, "the held initial completion");

    const beforeQueue = scope.frames.length;
    const accepted = await request(scope, { type: "prompt", message: "workflowz", streamingBehavior: "followUp" });
    expect(accepted.success).toBe(true);
    const queued = await request(scope, { type: "get_state" });
    expect(queued.success).toBe(true);
    expect(queued.data).toMatchObject({ isStreaming: true, queuedMessages: { followUp: ["workflowz"] } });
    const acceptedThrough = scope.frames.indexOf(queued) + 1;
    expect(inputLifecycle(scope.frames.slice(beforeQueue, acceptedThrough))).toEqual([]);
    expect(activeKeywordsAfter(scope.frames.slice(0, acceptedThrough))).toEqual(["ultrathink"]);

    provider.complete(0);
    const consumedAt = await waitFor(() => {
      const index = scope!.frames.findIndex((frame, i) =>
        i >= beforeQueue && frame.type === "message_end" && frame.message?.role === "user",
      );
      return index >= 0 ? index : undefined;
    }, 25_000, "the queued follow-up's user message_end");
    const consumed = scope.frames.slice(0, consumedAt + 1);
    expect(inputLifecycle(consumed.slice(beforeQueue))).toEqual(expectedInputLifecycle(["workflow-notice"]));
    expect(consumed.filter((frame) => frame.type === "agent_start")).toHaveLength(1);
    expect(consumed.filter((frame) => frame.type === "agent_end")).toHaveLength(0);
    const followUpUserAt = consumed.findIndex((frame, i) =>
      i >= beforeQueue && frame.type === "message_start" && frame.message?.role === "user",
    );
    expect(activeKeywordsAfter(consumed.slice(0, followUpUserAt))).toEqual(["ultrathink"]);
    expect(activeKeywordsAfter(consumed.slice(0, followUpUserAt + 1))).toEqual(["workflowz"]);
    expect(activeKeywordsAfter(consumed)).toEqual(["workflowz"]);
    await waitFor(() => provider!.requests.length === 2 ? true : undefined, 25_000, "the held follow-up completion");

    provider.complete(1);
    const endedAt = await waitFor(() => {
      const index = scope!.frames.findIndex((frame, i) => i > consumedAt && frame.type === "agent_end");
      return index >= 0 ? index : undefined;
    }, 25_000, "the shared run's agent_end");
    expect(activeKeywordsAfter(scope.frames.slice(0, endedAt + 1))).toEqual([]);
    expect(provider.requests).toHaveLength(2);
  }, 120_000);

  it("the firing matrix equals the port and the table", async () => {
    const corpus = [
      ALL_WORDS,
      "`orchestrate` and <b>jevify</b>\n\n```\nworkflowz\n```\n\nsee orchestrate.ts, jevify_rate, re-ultrathink",
      "ULTRATHINK Orchestrate, don't jevify",
      "`ultrathink orchestrate workflowz jevify`",
    ];
    const rosters = ["read,bash,task,eval", "read,bash,task", "read,bash,eval", "read,bash"];
    for (const tools of rosters) {
      scope = spawnScope({ tools });
      for (let i = 0; i < corpus.length; i++) {
        const frames = await inputFramesFor(scope, corpus[i]!, i === 0);
        const expected = expectedNotices(corpus[i]!, tools.split(","));
        const label = `${tools} :: ${JSON.stringify(corpus[i])}`;
        expect(noticeTypes(frames), label).toEqual(expected);
        expect(inputLifecycle(frames), label).toEqual(expectedInputLifecycle(expected));
        expect(activeKeywordsAfter(frames), label).toEqual(
          MAGIC_KEYWORDS.filter((keyword) => expected.includes(`${keyword.id}-notice`)).map((keyword) => keyword.word),
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
      const frames = await inputFramesFor(scope, ALL_WORDS, true);
      const enabled = MAGIC_KEYWORDS.filter((k) => k.id !== keyword.id);
      expect(noticeTypes(frames)).toEqual(enabled.map((k) => `${k.id}-notice`));
      expect(inputLifecycle(frames)).toEqual(expectedInputLifecycle(enabled.map((k) => `${k.id}-notice`)));
      expect(activeKeywordsAfter(frames)).toEqual(enabled.map((k) => k.word));
      expect(activeKeywordsAfter(frames)).not.toContain(keyword.word);
      await killScope(scope);
      scope = null;
    }
    scope = spawnScope({
      overlays: [{ name: "kw-all.yml", yaml: "magicKeywords:\n  enabled: false\n" }],
    });
    const frames = await inputFramesFor(scope, ALL_WORDS, true);
    expect(noticeTypes(frames)).toEqual([]);
    expect(inputLifecycle(frames)).toEqual(expectedInputLifecycle([]));
    expect(activeKeywordsAfter(frames)).toEqual([]);
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
    const quotedFrames = await inputFramesFor(scope, `ultrathink\n\n${quoted}`, true);
    expect(noticeTypes(quotedFrames)).toEqual(["ultrathink-notice"]);
    expect(activeKeywordsAfter(quotedFrames)).toEqual(["ultrathink"]);

    fs.writeFileSync(
      path.join(scope.project, "notes.md"),
      "notes\n```\njevify the retries\n",
    );
    const { contextText } = await resolveFileMentions(
      scope.project,
      "steer now @notes.md",
    );
    const mentionFrames = await inputFramesFor(scope, "steer now" + contextText, false);
    expect(noticeTypes(mentionFrames)).toEqual([]);
    expect(activeKeywordsAfter(mentionFrames)).toEqual([]);
  }, 90_000);
});
