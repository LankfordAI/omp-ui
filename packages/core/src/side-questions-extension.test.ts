import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BTW_BUSY_REFUSAL,
  BTW_COMMAND,
  BTW_NO_MODEL_MESSAGE,
  BTW_STATUS_KEY,
  btwAskMessage,
  btwCancelMessage,
  btwPromptText,
  btwRefreshMessage,
  parseBtwRecord,
  parseBtwSnapshot,
  type BtwSnapshot,
} from "./side-questions";
import {
  sideQuestionsExtensionPath,
  writeSideQuestionsExtension,
} from "./side-questions-extension";
import { typecheckGeneratedExtension } from "./generated-extension-test-utils";

const dirs: string[] = [];
const nodeRequire = createRequire(import.meta.url);

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ fixtures

interface EphemeralOptions {
  promptText: string;
  history?: unknown[];
  conversationKey?: string;
  onTextDelta?: (delta: string) => void;
  signal?: AbortSignal;
}

/** One controllable in-flight ephemeral turn. */
interface Turn {
  options: EphemeralOptions;
  delta(text: string): void;
  resolve(reply: string): void;
  reject(error: Error): void;
}

class FakeAgentSession {
  turns: Turn[] = [];
  sessionId = "sess-1";
  artifactsDir: string | null;
  model: { api: string; provider: string; id: string } | null = {
    api: "anthropic-messages",
    provider: "anthropic",
    id: "sonnet",
  };
  sessionManager: Record<string, unknown>;
  runEphemeralTurn?: (options: EphemeralOptions) => Promise<{ replyText: string }>;

  constructor(artifactsDir: string | null) {
    this.artifactsDir = artifactsDir;
    this.sessionManager = {
      getSessionId: () => this.sessionId,
      getArtifactsDir: () => this.artifactsDir,
      getLeafId: () => "leaf-1",
    };
    this.runEphemeralTurn = (options) =>
      // Promise.withResolvers needs ES2024; this package's lib is ES2022.
      new Promise((resolve, reject) => {
        this.turns.push({
          options,
          delta: (text) => options.onTextDelta?.(text),
          resolve: (reply) => resolve({ replyText: reply }),
          reject,
        });
        options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
  }

  prompt(): Promise<boolean> {
    return Promise.resolve(true);
  }
}

interface Harness {
  send(message: string): Promise<void>;
  statuses: BtwSnapshot[];
  latest(): BtwSnapshot;
  session: FakeAgentSession;
  historyDir(): string;
  events: Map<string, (...args: unknown[]) => void>;
  ui: { setStatus(key: string, text: string | undefined): void };
}

async function armed(options: { artifacts?: boolean; withoutEphemeral?: boolean } = {}): Promise<Harness> {
  const lineage = tempDir("omp-ui-btw-lineage-");
  const artifacts = options.artifacts === false ? null : tempDir("omp-ui-btw-artifacts-");
  const file = writeSideQuestionsExtension(lineage);
  expect(file).toBe(sideQuestionsExtensionPath(lineage));
  const { outputText } = ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const loaded = { exports: {} as { default?: (api: unknown) => void } };
  Function("module", "exports", "require", outputText)(loaded, loaded.exports, nodeRequire);
  const factory = loaded.exports.default;
  if (!factory) throw new Error("generated extension has no default factory");

  const statuses: BtwSnapshot[] = [];
  const events = new Map<string, (...args: unknown[]) => void>();
  let handler: ((args: string, ctx: Record<string, unknown>) => Promise<void>) | undefined;
  factory({
    pi: { AgentSession: FakeAgentSession },
    registerCommand: (name: string, opts: { handler: typeof handler }): void => {
      expect(name).toBe(BTW_COMMAND);
      handler = opts.handler;
    },
    on: (name: string, listener: (...args: unknown[]) => void): void => {
      events.set(name, listener);
    },
  });
  const ui = {
    setStatus: (key: string, text: string | undefined): void => {
      expect(key).toBe(BTW_STATUS_KEY);
      const snapshot = parseBtwSnapshot(text);
      if (snapshot === null) throw new Error("published a snapshot the shared wire parser rejects");
      statuses.push(snapshot);
    },
  };

  const session = new FakeAgentSession(artifacts);
  if (options.withoutEphemeral) session.runEphemeralTurn = undefined;
  // omp routes the slash line through prompt(), which binds the root.
  await (FakeAgentSession.prototype.prompt as (this: FakeAgentSession) => Promise<boolean>).call(session);

  return {
    send: async (message) => {
      if (!handler) throw new Error("no command registered");
      const [, args] = /^\/\S+\s*([\s\S]*)$/.exec(message) ?? [];
      await handler(args ?? "", { ui });
    },
    statuses,
    latest: () => {
      const value = statuses.at(-1);
      if (value === undefined) throw new Error("no snapshot published");
      return value;
    },
    session,
    historyDir: () => path.join(artifacts ?? "", "btw-history"),
    events,
    ui,
  };
}

const ask = (question: string, extra: { topicId?: string } = {}): string =>
  btwAskMessage({ requestId: "r", question, ...extra });

function entryFiles(dir: string): string[] {
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith(".json")) : [];
}

function readEntry(dir: string, name: string): NonNullable<ReturnType<typeof parseBtwRecord>> {
  const parsed = parseBtwRecord(fs.readFileSync(path.join(dir, name), "utf8"));
  if (parsed === null) throw new Error(`${name} is not a valid omp history record`);
  return parsed;
}

// --------------------------------------------------------------------- tests

describe("side-questions extension", () => {
  it("writes a strict TypeScript extension omp can load", () => {
    typecheckGeneratedExtension(writeSideQuestionsExtension(tempDir("omp-ui-btw-check-")));
  });

  it("asks: writes a running record, streams growing answers, then completes the file", async () => {
    const h = await armed();
    await h.send(ask("what changed?"));

    // The ack returned without a model turn; the record is already on disk and running.
    const [name] = entryFiles(h.historyDir());
    const running = readEntry(h.historyDir(), name);
    expect(running).toMatchObject({ question: "what changed?", status: "running", leafId: "leaf-1" });
    expect(h.latest().active).toMatchObject({ question: "what changed?", answer: "" });

    const turn = h.session.turns[0];
    expect(turn.options.promptText).toBe(btwPromptText("what changed?"));
    expect(turn.options.history).toEqual([]);

    turn.delta("one ");
    turn.delta("two");
    await vi.waitFor(() => expect(h.latest().active?.answer).toBe("one two"));

    turn.resolve("one two three");
    await vi.waitFor(() => expect(h.latest().active).toBeNull());
    expect(h.latest().topics[0]).toMatchObject({ status: "complete", answer: "one two three" });
    await vi.waitFor(() =>
      expect(readEntry(h.historyDir(), name)).toMatchObject({
        status: "complete",
        answer: "one two three",
      }),
    );
  });

  it("refuses a second question while one runs, without disturbing the first", async () => {
    const h = await armed();
    await h.send(ask("first"));
    await h.send(ask("second"));
    expect(h.latest().busy).toBe(BTW_BUSY_REFUSAL);
    expect(h.latest().active?.question).toBe("first");
    expect(h.session.turns).toHaveLength(1);
    expect(entryFiles(h.historyDir())).toHaveLength(1);

    // The refusal line is one-shot: the next publish clears it.
    h.session.turns[0].resolve("done");
    await vi.waitFor(() => expect(h.latest().active).toBeNull());
    expect(h.latest().busy).toBeUndefined();
  });

  it("cancels mid-stream: the record settles cancelled and the run is aborted", async () => {
    const h = await armed();
    await h.send(ask("slow one"));
    const [name] = entryFiles(h.historyDir());
    h.session.turns[0].delta("partial");
    await h.send(btwCancelMessage({ requestId: "c" }));
    expect(h.session.turns[0].options.signal?.aborted).toBe(true);
    expect(h.latest().active).toBeNull();
    expect(h.latest().topics[0]).toMatchObject({ status: "cancelled" });
    await vi.waitFor(() => expect(readEntry(h.historyDir(), name).status).toBe("cancelled"));
    // The abort rejection arriving late must not resurrect or error the record.
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(h.latest().topics[0].status).toBe("cancelled");
  });

  it("follows up on a completed topic with only that topic's turns as side history", async () => {
    const h = await armed();
    await h.send(ask("root"));
    h.session.turns[0].resolve("root answer");
    await vi.waitFor(() => expect(h.latest().active).toBeNull());
    const topicId = h.latest().topics[0].id;

    await h.send(ask("more?", { topicId }));
    const followUp = h.session.turns[1];
    const history = followUp.options.history as { role: string; content: { text: string }[] }[];
    expect(history.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(history[0].content[0].text).toBe(btwPromptText("root"));
    expect(history[1].content[0].text).toBe("root answer");
    // omp keys a turn by the index after the last incomplete prior turn: all complete → 0.
    expect(followUp.options.conversationKey).toBe(`btw:${topicId}:0`);

    followUp.resolve("follow answer");
    await vi.waitFor(() => expect(h.latest().active).toBeNull());
    expect(h.latest().topics).toHaveLength(1);
    expect(h.latest().topics[0].turns.map((t) => t.question)).toEqual(["root", "more?"]);
    const record = readEntry(h.historyDir(), entryFiles(h.historyDir())[0]);
    expect(record.followUps).toHaveLength(1);
    expect(record.followUps?.[0]).toMatchObject({ question: "more?", answer: "follow answer" });
  });

  it("refuses a follow-up on an unknown topic", async () => {
    const h = await armed();
    await h.send(ask("x", { topicId: "nope" }));
    expect(h.latest().busy).toMatch(/unavailable/);
    expect(h.session.turns).toHaveLength(0);
  });

  it("settles a failed turn as an error record carrying the message", async () => {
    const h = await armed();
    await h.send(ask("boom?"));
    h.session.turns[0].reject(new Error("Active session changed during ephemeral turn; retry."));
    await vi.waitFor(() => expect(h.latest().topics[0]?.status).toBe("error"));
    expect(h.latest().topics[0].error).toMatch(/retry/);
    const name = entryFiles(h.historyDir())[0];
    await vi.waitFor(() => expect(readEntry(h.historyDir(), name).status).toBe("error"));
  });

  it("publishes omp's own sentence when the session has no model", async () => {
    const h = await armed();
    h.session.model = null;
    await h.send(ask("hello?"));
    expect(h.latest().active).toBeNull();
    expect(h.latest().topics[0]).toMatchObject({ status: "error", error: BTW_NO_MODEL_MESSAGE });
    expect(h.session.turns).toHaveLength(0);
  });

  it("refresh marks stale running records interrupted, as omp's loader does", async () => {
    const h = await armed();
    fs.mkdirSync(h.historyDir(), { recursive: true });
    const stale = {
      id: "old-1",
      leafId: null,
      question: "left running",
      answer: "half",
      status: "running",
      createdAt: 1,
      updatedAt: 2,
    };
    fs.writeFileSync(path.join(h.historyDir(), "entry-old-1.json"), JSON.stringify(stale));
    // Records that violate omp's grammar are skipped, never fatal.
    fs.writeFileSync(path.join(h.historyDir(), "entry-bad.json"), JSON.stringify({ ...stale, id: "bad", x: 1 }));
    fs.writeFileSync(path.join(h.historyDir(), "entry-mismatch.json"), JSON.stringify({ ...stale, id: "other" }));

    await h.send(btwRefreshMessage({ requestId: "r" }));
    expect(h.latest().topics.map((t) => [t.id, t.status])).toEqual([["old-1", "interrupted"]]);
    expect(h.latest().active).toBeNull();
  });

  it("re-keys on a session change: another session's topics never leak", async () => {
    const h = await armed();
    await h.send(ask("in session one"));
    h.session.turns[0].resolve("a");
    await vi.waitFor(() => expect(h.latest().topics).toHaveLength(1));

    const other = tempDir("omp-ui-btw-artifacts-");
    h.session.sessionId = "sess-2";
    h.session.artifactsDir = other;
    await h.send(btwRefreshMessage({ requestId: "r" }));
    expect(h.latest().topics).toEqual([]);
  });

  it("keeps topics in memory until the session has an artifacts dir, then persists them", async () => {
    const h = await armed({ artifacts: false });
    await h.send(ask("early"));
    h.session.turns[0].resolve("answer");
    await vi.waitFor(() => expect(h.latest().topics[0]?.status).toBe("complete"));

    const dir = tempDir("omp-ui-btw-artifacts-");
    h.session.artifactsDir = dir;
    await h.send(btwRefreshMessage({ requestId: "r" }));
    const files = entryFiles(path.join(dir, "btw-history"));
    expect(files).toHaveLength(1);
    expect(readEntry(path.join(dir, "btw-history"), files[0])).toMatchObject({
      question: "early",
      status: "complete",
    });
    expect(h.latest().topics).toHaveLength(1);
  });

  it("surfaces a revision conflict on the topic instead of clobbering the file", async () => {
    const h = await armed();
    await h.send(ask("contested"));
    const name = entryFiles(h.historyDir())[0];
    // Another writer (omp's TUI in a terminal tab) rewrites the record.
    const theirs = { ...readEntry(h.historyDir(), name), answer: "theirs" };
    fs.writeFileSync(path.join(h.historyDir(), name), JSON.stringify(theirs) + "\n");

    h.session.turns[0].resolve("ours");
    await vi.waitFor(() => expect(h.latest().topics[0]?.status).toBe("error"));
    expect(h.latest().topics[0].error).toMatch(/conflict/);
    expect(readEntry(h.historyDir(), name).answer).toBe("theirs");
  });

  it("degrades to available:false when runEphemeralTurn is missing, and breaks nothing", async () => {
    const h = await armed({ withoutEphemeral: true });
    await h.send(ask("anything"));
    expect(h.latest()).toMatchObject({ available: false, active: null, topics: [] });
    expect(h.latest().unavailableReason).toMatch(/cannot answer side questions/);
    expect(entryFiles(h.historyDir())).toEqual([]);
  });

  it("republishes from disk on session events once armed", async () => {
    const h = await armed();
    await h.send(btwRefreshMessage({ requestId: "r" }));
    const before = h.statuses.length;
    h.events.get("session_switch")?.({}, { ui: h.ui });
    await vi.waitFor(() => expect(h.statuses.length).toBeGreaterThan(before));
  });

  it("truncates a huge answer in the snapshot while the file keeps the full text", async () => {
    const h = await armed();
    await h.send(ask("long"));
    const big = "x".repeat(100_000);
    h.session.turns[0].resolve(big);
    await vi.waitFor(() => expect(h.latest().topics[0]?.status).toBe("complete"));
    expect(h.latest().topics[0].answer.length).toBeLessThan(big.length);
    expect(h.latest().topics[0].answer).toMatch(/truncated/);
    const name = entryFiles(h.historyDir())[0];
    await vi.waitFor(() => expect(readEntry(h.historyDir(), name).answer).toBe(big));
  });
});
