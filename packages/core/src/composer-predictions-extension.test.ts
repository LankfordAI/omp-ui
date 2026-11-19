import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMPOSER_PREDICTION_MAX_CHARS,
  COMPOSER_PREDICTIONS_COMMAND,
  COMPOSER_PREDICTIONS_REQUEST_PREFIX,
  COMPOSER_PREDICTIONS_STATUS_BYTE_LIMIT,
  COMPOSER_PREDICTIONS_STATUS_KEY,
  COMPOSER_PREDICTION_USAGE_PURPOSE,
  composerPredictionRequestMessage,
  parseComposerPredictionsSnapshot,
  type ComposerPredictionsSnapshot,
} from "./composer-predictions";
import {
  composerPredictionsExtensionPath,
  writeComposerPredictionsExtension,
} from "./composer-predictions-extension";
import { transpileGeneratedExtension, typecheckGeneratedExtension } from "./generated-extension-test-utils";

const dirs: string[] = [];

function tempLineage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-predictions-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ fixtures

/** The literal specifier the generated bridge imports (ADR-0036). */
const REGISTRY_MODULE = "@oh-my-pi/pi-coding-agent/config/registry";

interface SideTurnCall {
  promptText: string;
  maxTokens?: number;
  minimizeEffort?: boolean;
  signal?: AbortSignal;
  onUsage?: (message: Record<string, unknown>) => void;
}

interface Session {
  settings: { values: Record<string, unknown> };
  model: unknown;
  isStreaming: boolean;
  isCompacting: boolean;
  ephemeralMaxTokensPreservesRequest: () => boolean;
  /** Fake-only backing for the method above. */
  preservesRequest: boolean;
  prompts: string[];
  prompt(text: string): Promise<boolean>;
}

interface HarnessOptions {
  /** Effective composer.* values for the fake registry. */
  settings?: Record<string, unknown>;
  /** False: the literal registry specifier does not resolve. */
  module?: boolean;
  /** False: ctx.runEphemeralTurn is absent (pre-side-turn host). */
  sideTurn?: boolean;
  /** How runEphemeralTurn settles. Default: a one-line prediction. */
  reply?: (call: SideTurnCall) => Promise<{ replyText?: unknown }>;
  /** ctx.sessionManager surface; default id "sess-1" with leaf "leaf-1". */
  manager?: Record<string, unknown>;
}

interface Harness {
  AgentSession: new () => Session;
  invoke: (args: string) => Promise<void>;
  arm: () => Promise<void>;
  request: (requestId: string) => Promise<void>;
  snapshot: () => ComposerPredictionsSnapshot;
  statuses: ComposerPredictionsSnapshot[];
  /** Resolves with the first published snapshot satisfying `pred`; every publish re-checks. */
  until: (pred: (snapshot: ComposerPredictionsSnapshot) => boolean) => Promise<ComposerPredictionsSnapshot>;
  sideTurnCalls: SideTurnCall[];
  /** Every journaled model_usage entry: [usage, owner]. */
  usage: Array<[Record<string, unknown>, { sessionId: string; parentId: string | null }]>;
  emit: (event: string) => void;
}

function harness(options: HarnessOptions = {}): Harness {
  const file = writeComposerPredictionsExtension(tempLineage());
  const outputText = transpileGeneratedExtension(fs.readFileSync(file, "utf8"), "cjs");
  const settings = options.settings ?? { "composer.predictions": true };
  const fakeRequire = (specifier: string): unknown => {
    if (options.module === false) {
      throw new Error("Cannot find package '@oh-my-pi/pi-coding-agent' from " + specifier);
    }
    if (specifier === REGISTRY_MODULE) {
      return {
        lookup: (id: string) => ({
          get: (scoped: unknown) =>
            (scoped as { values?: Record<string, unknown> } | null)?.values?.[id],
        }),
      };
    }
    throw new Error("generated bridge required an unowned module: " + specifier);
  };
  const loaded = { exports: {} as { default?: (api: unknown) => void } };
  Function("module", "exports", "require", outputText)(loaded, loaded.exports, fakeRequire);
  const factory = loaded.exports.default;
  if (!factory) throw new Error("generated bridge has no default factory");

  const statuses: ComposerPredictionsSnapshot[] = [];
  const sideTurnCalls: SideTurnCall[] = [];
  const usage: Harness["usage"] = [];
  const publishWaiters: Array<() => void> = [];
  const events: Record<string, Array<() => void>> = {};
  let handler: ((args: string, ctx: Record<string, unknown>) => Promise<void> | void) | undefined;

  class FakeAgentSession {
    settings = { values: { ...settings } };
    model: unknown = { provider: "probe", id: "inert" };
    isStreaming = false;
    isCompacting = false;
    preservesRequest = true;
    ephemeralMaxTokensPreservesRequest(): boolean {
      return this.preservesRequest;
    }
    prompts: string[] = [];
    prompt(text: string): Promise<boolean> {
      this.prompts.push(text);
      return Promise.resolve(true);
    }
  }

  factory({
    pi: { AgentSession: FakeAgentSession },
    on: (event: string, cb: () => void): void => {
      (events[event] ??= []).push(cb);
    },
    registerCommand: (name: string, registered: { handler: typeof handler }): void => {
      expect(name).toBe(COMPOSER_PREDICTIONS_COMMAND);
      handler = registered.handler;
    },
  });

  const journal = new Map<string, { parentId: string | null }>();
  let leaf = "leaf-1";
  const manager =
    options.manager ?? {
      getSessionId: () => "sess-1",
      getLeafId: () => leaf,
      getEntry: (id: string) => journal.get(id),
      // Upstream's own semantics: the entry parents to owner.parentId and the
      // journal leaf advances onto it when nothing moved meanwhile — the exact
      // move the bridge's staleness walk must see as bookkeeping, not a new
      // message (pinned by the live proof on both tags).
      appendModelUsage: (
        entry: Record<string, unknown>,
        owner: { sessionId: string; parentId: string | null },
      ): string => {
        const id = `usage-${journal.size + 1}`;
        journal.set(id, { parentId: owner.parentId });
        usage.push([entry, owner]);
        if (leaf === owner.parentId) leaf = id;
        return id;
      },
    };

  const invoke = async (args: string): Promise<void> => {
    if (!handler) throw new Error("generated bridge registered no command");
    const ctx: Record<string, unknown> = {
      ui: {
        setStatus: (key: string, text: string | undefined): void => {
          expect(key).toBe(COMPOSER_PREDICTIONS_STATUS_KEY);
          const snapshot = parseComposerPredictionsSnapshot(text);
          if (snapshot === null) throw new Error("published a snapshot the wire parser rejects: " + text);
          statuses.push(snapshot);
          for (const wake of publishWaiters.splice(0)) wake();
        },
      },
      sessionManager: manager,
    };
    if (options.sideTurn !== false) {
      ctx.runEphemeralTurn = async (call: SideTurnCall) => {
        sideTurnCalls.push(call);
        const reply = options.reply ?? (async () => ({ replyText: "Sounds good, go ahead." }));
        return reply(call);
      };
    }
    await handler(args, ctx);
  };

  const until = async (
    pred: (snapshot: ComposerPredictionsSnapshot) => boolean,
  ): Promise<ComposerPredictionsSnapshot> => {
    for (;;) {
      const last = statuses.at(-1);
      if (last !== undefined && pred(last)) return last;
      // A real signal: the bridge's own publish wakes this, never a timer.
      await new Promise<void>((wake) => publishWaiters.push(wake));
    }
  };

  return {
    AgentSession: FakeAgentSession as unknown as Harness["AgentSession"],
    invoke,
    arm: () => invoke(""),
    request: (requestId) =>
      // omp hands the handler everything after the command name.
      invoke(composerPredictionRequestMessage({ requestId }).slice(`/${COMPOSER_PREDICTIONS_COMMAND} `.length)),
    snapshot: (): ComposerPredictionsSnapshot => {
      const value = statuses.at(-1);
      if (!value) throw new Error("the bridge published no snapshot");
      return value;
    },
    statuses,
    until,
    sideTurnCalls,
    usage,
    emit: (event) => {
      for (const cb of events[event] ?? []) cb();
    },
  };
}

/** Binds a root by prompting, as omp's first dispatched prompt does. */
async function bound(h: Harness, tune?: (session: Session) => void): Promise<Session> {
  const session = new h.AgentSession();
  tune?.(session);
  await session.prompt("hello");
  return session;
}

// Executor form because the node tsconfig lib predates Promise.withResolvers
// — the exception limits-live.test.ts documents.
const deferred = <T,>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

/** Resolves when the request settles: a result-bearing publish is the real signal. */
const settledWith = (requestId: string) => (snapshot: ComposerPredictionsSnapshot): boolean =>
  snapshot.result?.requestId === requestId;

// ------------------------------------------------------------------- tests

describe("writeComposerPredictionsExtension", () => {
  it("writes the bridge into the lineage dir and is rewritten on every spawn", () => {
    const lineage = path.join(tempLineage(), "nested");
    const file = writeComposerPredictionsExtension(lineage);
    expect(file).toBe(composerPredictionsExtensionPath(lineage));
    expect(fs.existsSync(file)).toBe(true);
    fs.writeFileSync(file, "// stale\n", "utf8");
    writeComposerPredictionsExtension(lineage);
    expect(fs.readFileSync(file, "utf8")).toContain(JSON.stringify(COMPOSER_PREDICTIONS_STATUS_KEY));
  });

  it("emits a generated source that strictly typechecks and carries the wire contract", () => {
    const file = writeComposerPredictionsExtension(tempLineage());
    typecheckGeneratedExtension(file);
    const source = fs.readFileSync(file, "utf8");
    for (const constant of [
      COMPOSER_PREDICTIONS_COMMAND,
      COMPOSER_PREDICTIONS_STATUS_KEY,
      COMPOSER_PREDICTIONS_REQUEST_PREFIX,
      COMPOSER_PREDICTION_USAGE_PURPOSE,
    ]) {
      expect(source).toContain(JSON.stringify(constant));
    }
    expect(source).toContain(String(COMPOSER_PREDICTIONS_STATUS_BYTE_LIMIT));
    expect(source).toContain(String(COMPOSER_PREDICTION_MAX_CHARS));
    expect(source).toContain(JSON.stringify(REGISTRY_MODULE));
  });
});

describe("composer-predictions bridge arm", () => {
  it("publishes available when the setting reads on and side turns exist", async () => {
    const h = harness();
    await bound(h);
    await h.arm();
    expect(h.snapshot()).toMatchObject({ available: true, unavailable: null, result: null });
  });

  it("publishes settings-off without ever sending a request", async () => {
    const h = harness({ settings: { "composer.predictions": false } });
    await bound(h);
    await h.arm();
    expect(h.snapshot()).toMatchObject({ available: false, unavailable: "settings-off" });
  });

  it("publishes missing-api on a host without ctx.runEphemeralTurn", async () => {
    const h = harness({ sideTurn: false });
    await bound(h);
    await h.arm();
    expect(h.snapshot()).toMatchObject({ available: false, unavailable: "missing-api" });
  });

  it("publishes settings-unreadable when the registry does not resolve", async () => {
    const h = harness({ module: false });
    await bound(h);
    await h.arm();
    expect(h.snapshot()).toMatchObject({ available: false, unavailable: "settings-unreadable" });
  });

  it("publishes no-session before any prompt binds a root", async () => {
    const h = harness();
    await h.arm();
    expect(h.snapshot()).toMatchObject({ available: false, unavailable: "no-session" });
  });

  it("throws on malformed request args rather than asking a guess", async () => {
    const h = harness();
    await bound(h);
    await expect(h.invoke("nonsense")).rejects.toThrow(COMPOSER_PREDICTIONS_COMMAND);
    await expect(h.invoke(`${COMPOSER_PREDICTIONS_REQUEST_PREFIX}{"requestId":""}`)).rejects.toThrow(
      "malformed",
    );
    await expect(
      h.invoke(`${COMPOSER_PREDICTIONS_REQUEST_PREFIX}{"requestId":"a","extra":1}`),
    ).rejects.toThrow("malformed");
    expect(h.sideTurnCalls).toHaveLength(0);
  });
});

describe("composer-predictions bridge request", () => {
  it("runs one side turn and publishes the single choice correlated by requestId", async () => {
    const h = harness();
    await bound(h);
    await h.arm();
    await h.request("req-1");
    const settled = await h.until(settledWith("req-1"));
    expect(h.sideTurnCalls).toHaveLength(1);
    expect(settled.result).toEqual({ requestId: "req-1", ok: true, choices: ["Sounds good, go ahead."] });
  });

  it("sends upstream's effort settings: minimizeEffort plus the cache-safe cap", async () => {
    const h = harness();
    await bound(h);
    await h.arm();
    await h.request("req-1");
    await h.until(settledWith("req-1"));
    expect(h.sideTurnCalls[0]).toMatchObject({ minimizeEffort: true, maxTokens: 1024 });
    expect(h.sideTurnCalls[0]!.promptText).toContain("NO_PREDICTION");
  });

  it("omits the cap when the model's request would change", async () => {
    const h = harness();
    await bound(h, (s) => {
      s.preservesRequest = false;
    });
    await h.arm();
    await h.request("req-1");
    await h.until(settledWith("req-1"));
    expect(h.sideTurnCalls[0]!.maxTokens).toBeUndefined();
  });

  it("journals the billed request as model_usage under composer-prediction", async () => {
    const h = harness({
      reply: async (call) => {
        call.onUsage?.({
          api: "openai-completions",
          provider: "probe",
          model: "inert",
          usage: { input: 10, output: 2 },
          stopReason: "stop",
        });
        return { replyText: "Sounds good." };
      },
    });
    await bound(h);
    await h.arm();
    await h.request("req-1");
    const settled = await h.until(settledWith("req-1"));
    // The journaled entry moved the leaf onto itself; the reply must still be
    // offered — its own bookkeeping never reads as a new message.
    expect(settled.result).toEqual({ requestId: "req-1", ok: true, choices: ["Sounds good."] });
    expect(h.usage).toHaveLength(1);
    const [entry, owner] = h.usage[0]!;
    expect(entry.purpose).toBe(COMPOSER_PREDICTION_USAGE_PURPOSE);
    expect(entry.usage).toEqual({ input: 10, output: 2 });
    expect(owner).toEqual({ sessionId: "sess-1", parentId: "leaf-1" });
  });

  it("a real new message after journaling still retires the reply as stale", async () => {
    let leaf = "leaf-1";
    const journal = new Map<string, { parentId: string | null }>();
    const gate = deferred<{ replyText?: unknown }>();
    const h = harness({
      manager: {
        getSessionId: () => "sess-1",
        getLeafId: () => leaf,
        getEntry: (id: string) => journal.get(id),
        appendModelUsage: (
          _entry: Record<string, unknown>,
          owner: { sessionId: string; parentId: string | null },
        ): string => {
          const id = "usage-1";
          journal.set(id, { parentId: owner.parentId });
          if (leaf === owner.parentId) leaf = id;
          return id;
        },
      },
      reply: (call) => {
        // Usage lands mid-turn, moving the leaf onto the journal entry; then
        // the user sends a real message on top of it.
        call.onUsage?.({ usage: { input: 1 } });
        leaf = "user-message-2";
        return gate.promise;
      },
    });
    await bound(h);
    await h.arm();
    await h.request("req-1");
    gate.resolve({ replyText: "Too late." });
    const settled = await h.until(settledWith("req-1"));
    expect(settled.result).toEqual({ requestId: "req-1", ok: false, reason: "stale" });
  });

  it("asks for up to four alternatives when the setting is on, parsed one per line", async () => {
    const h = harness({
      settings: { "composer.predictions": true, "composer.predictionAlternatives": true },
      reply: async () => ({
        replyText:
          "Run the tests\n" +
          "- Run the tests again\n" +
          "run the tests\n" +
          "Deploy it\n" +
          "Ship the fix\n" +
          "One more thing\n" +
          "And another",
      }),
    });
    await bound(h);
    await h.arm();
    await h.request("req-1");
    const settled = await h.until(settledWith("req-1"));
    expect(h.sideTurnCalls[0]!.promptText).toContain("up to 4 different messages");
    expect(settled.result?.ok === true && settled.result.choices).toEqual([
      "Run the tests",
      // "- Run the tests again" is a DIFFERENT intent once its marker goes;
      // only exact case/punctuation folds drop ("run the tests").
      "Run the tests again",
      "Deploy it",
      "Ship the fix",
    ]);
  });

  it("declines a skip reply as skipped without choices", async () => {
    const h = harness({ reply: async () => ({ replyText: "NO_PREDICTION" }) });
    await bound(h);
    await h.arm();
    await h.request("req-1");
    const settled = await h.until(settledWith("req-1"));
    expect(settled.result).toEqual({ requestId: "req-1", ok: false, reason: "skipped" });
  });

  it("drops a rambling reply over the length cap", async () => {
    const h = harness({ reply: async () => ({ replyText: "x".repeat(COMPOSER_PREDICTION_MAX_CHARS + 1) }) });
    await bound(h);
    await h.arm();
    await h.request("req-1");
    const settled = await h.until(settledWith("req-1"));
    expect(settled.result).toMatchObject({ ok: false, reason: "skipped" });
  });

  it("strips wrapping quotes from the reply", async () => {
    const h = harness({ reply: async () => ({ replyText: '"Ship it"' }) });
    await bound(h);
    await h.arm();
    await h.request("req-1");
    const settled = await h.until(settledWith("req-1"));
    expect(settled.result).toMatchObject({ ok: true, choices: ["Ship it"] });
  });

  it("refuses the request as off when the setting flipped after arming, billing nothing", async () => {
    const h = harness();
    const session = await bound(h);
    await h.arm();
    expect(h.snapshot().available).toBe(true);
    // A live `omp config set composer.predictions false` lands through the
    // registry re-read: no billed request may follow.
    session.settings.values["composer.predictions"] = false;
    await h.request("req-1");
    expect(h.sideTurnCalls).toHaveLength(0);
    const settled = await h.until(settledWith("req-1"));
    expect(settled.result).toEqual({ requestId: "req-1", ok: false, reason: "off" });
  });

  it("refuses while streaming or compacting without a request", async () => {
    const h = harness();
    const session = await bound(h);
    await h.arm();
    session.isStreaming = true;
    await h.request("req-1");
    expect(h.sideTurnCalls).toHaveLength(0);
    const settled = await h.until(settledWith("req-1"));
    expect(settled.result).toEqual({ requestId: "req-1", ok: false, reason: "busy" });
    session.isStreaming = false;
    session.isCompacting = true;
    await h.request("req-2");
    expect(h.sideTurnCalls).toHaveLength(0);
    const settled2 = await h.until(settledWith("req-2"));
    expect(settled2.result).toMatchObject({ requestId: "req-2", reason: "busy" });
  });

  it("refuses without a model or a session journal id", async () => {
    const h = harness();
    const session = await bound(h);
    await h.arm();
    session.model = undefined;
    await h.request("req-1");
    const settled = await h.until(settledWith("req-1"));
    expect(settled.result).toMatchObject({ reason: "unavailable" });

    const noId = harness({ manager: { appendModelUsage: () => "id" } });
    await bound(noId);
    await noId.arm();
    await noId.request("req-2");
    expect(noId.sideTurnCalls).toHaveLength(0);
    const settled2 = await noId.until(settledWith("req-2"));
    expect(settled2.result).toMatchObject({ requestId: "req-2", reason: "unavailable" });
  });

  it("marks a request stale when the leaf moved before the reply", async () => {
    let leaf = "leaf-1";
    const gate = deferred<{ replyText?: unknown }>();
    const h = harness({
      manager: {
        getSessionId: () => "sess-1",
        getLeafId: () => leaf,
        appendModelUsage: () => "id",
      },
      reply: () => gate.promise,
    });
    await bound(h);
    await h.arm();
    await h.request("req-1");
    // In flight: the publish that went out with the ack carries no result.
    expect(h.statuses.filter((s) => s.result !== null)).toHaveLength(0);
    leaf = "leaf-2"; // a new message moved the conversation
    gate.resolve({ replyText: "Too late." });
    const settled = await h.until(settledWith("req-1"));
    expect(settled.result).toEqual({ requestId: "req-1", ok: false, reason: "stale" });
  });

  it("aborts and retires the in-flight request when a new turn starts", async () => {
    const gate = deferred<{ replyText?: unknown }>();
    const h = harness({ reply: () => gate.promise });
    await bound(h);
    await h.arm();
    await h.request("req-1");
    expect(h.sideTurnCalls[0]!.signal?.aborted).toBe(false);
    h.emit("agent_start");
    // cancelInflight retires synchronously: aborted, then a stale result the
    // late continuation must not overwrite.
    expect(h.sideTurnCalls[0]!.signal?.aborted).toBe(true);
    expect(h.snapshot().result).toEqual({ requestId: "req-1", ok: false, reason: "stale" });
    gate.resolve({ replyText: "Too late." });
    // One microtask drain: the bridge's early-return continuation runs (and
    // publishes nothing) before this resolves.
    await Promise.resolve();
    expect(h.snapshot().result).toMatchObject({ requestId: "req-1", reason: "stale" });
  });

  it("reports a failed side turn as failed", async () => {
    const h = harness({
      reply: async () => {
        throw new Error("Model rejected the request");
      },
    });
    await bound(h);
    await h.arm();
    await h.request("req-1");
    const settled = await h.until(settledWith("req-1"));
    expect(settled.result).toEqual({ requestId: "req-1", ok: false, reason: "failed" });
  });

  it("supersedes an earlier in-flight request; the first never publishes", async () => {
    const gate = deferred<{ replyText?: unknown }>();
    let first = true;
    const h = harness({
      reply: () => (first ? gate.promise : Promise.resolve({ replyText: "Second one." })),
    });
    await bound(h);
    await h.arm();
    await h.request("req-1");
    first = false;
    await h.request("req-2");
    const settled = await h.until(settledWith("req-2"));
    expect(settled.result).toMatchObject({ requestId: "req-2", ok: true, choices: ["Second one."] });
    gate.resolve({ replyText: "Too late." });
    // The superseded continuation returns early; the next drain proves no
    // publish followed it.
    await Promise.resolve();
    expect(h.statuses.every((s) => s.result === null || s.result.requestId === "req-2")).toBe(true);
  });

  it("publishes a request whose reply is not text as skipped", async () => {
    const h = harness({ reply: async () => ({}) });
    await bound(h);
    await h.arm();
    await h.request("req-1");
    const settled = await h.until(settledWith("req-1"));
    expect(settled.result).toMatchObject({ reason: "skipped" });
  });

  it("keeps an unreadable setting from billing: absent registry values refuse as unavailable", async () => {
    const h = harness({ settings: {} }); // registry resolves, values absent → undefined
    await bound(h);
    await h.arm();
    expect(h.snapshot()).toMatchObject({ available: false, unavailable: "settings-unreadable" });
    await h.request("req-1");
    expect(h.sideTurnCalls).toHaveLength(0);
    const settled = await h.until(settledWith("req-1"));
    expect(settled.result).toMatchObject({ reason: "unavailable" });
  });

  it("stays inside the status byte cap for four maximum-length choices", async () => {
    const h = harness({
      settings: { "composer.predictions": true, "composer.predictionAlternatives": true },
      reply: async () => ({
        replyText: Array.from({ length: 4 }, (_, i) => `${i}`.padEnd(COMPOSER_PREDICTION_MAX_CHARS, "y")).join("\n"),
      }),
    });
    await bound(h);
    await h.arm();
    await h.request("req-1");
    const settled = await h.until(settledWith("req-1"));
    expect(settled.result?.ok === true && settled.result.choices.length).toBe(4);
    expect(JSON.stringify(settled).length).toBeLessThan(COMPOSER_PREDICTIONS_STATUS_BYTE_LIMIT);
  });
});
