import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  VIBE_COMMAND,
  VIBE_STATUS_KEY,
  parseVibeSnapshot,
  type VibeSnapshot,
  type VibeWorker,
} from "./vibe";
import { vibeExtensionPath, writeVibeExtension } from "./vibe-extension";
import { typecheckGeneratedExtension } from "./generated-extension-test-utils";

const dirs: string[] = [];

function tempLineage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-vibe-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ fixtures

interface Worker {
  id: string;
  cli: string;
  state: string;
  killed: boolean;
  model: string | null;
  turns: number;
  queued: number;
  turnMessage: string | null;
  currentTool: string | null;
  lastIntent: string | null;
  createdAt: number;
}

interface LifecycleEntry {
  action: string;
  id: string;
  cli?: string;
  agent?: string;
  childSessionFile?: string;
  createdAt?: number;
  turn?: number;
  reason?: string;
}

interface Options {
  planMode?: boolean;
  goalStatus?: string | null;
  /** Transcript entries the fake getEntries reports verbatim. */
  entries?: Array<{ type: string; customType?: string; mode?: string; data?: unknown }>;
  /** Session members the fake refuses to expose. */
  without?: string[];
  /** vibe_* tools whose execute rejects. */
  throwing?: string[];
}

interface Session {
  id: string;
  prompts: string[];
  modes: { mode: string; data?: Record<string, unknown> }[];
  events: { type: string; [key: string]: unknown }[];
  enabledTools: string[];
  vibeState: { enabled: boolean } | undefined;
  workers: Worker[];
  killCalls: string[];
  spawnCalls: Array<Record<string, unknown>>;
  isStreaming: boolean;
  planMode: boolean;
  goalStatus: string | null;
  activateCalls: string[][];
  deactivateCalls: string[][];
  disposeCalls: number;
  listeners: ((event: { type: string }) => void)[];
  prompt(text: string): Promise<boolean>;
  fire(event: { type: string; [key: string]: unknown }): void;
  addWorker(worker: Worker): void;
  addLifecycle(entry: LifecycleEntry): void;
  [key: string]: unknown;
}

interface Harness {
  AgentSession: new (id: string, options?: Options) => Session;
  invoke: (args: string) => Promise<void>;
  arm: () => Promise<void>;
  command: (request: { command: string; args?: string; sessionId?: string }) => Promise<void>;
  snapshot: () => VibeSnapshot;
  statuses: VibeSnapshot[];
}

/** Serves the module specifier the generated bridge's literal import resolves to. */
function fakeRequire(specifier: string): unknown {
  if (specifier === "@oh-my-pi/pi-coding-agent/tools/vibe") {
    return { createVibeTools: (): unknown[] => [], VIBE_TOOL_NAMES: [] };
  }
  throw new Error("generated bridge required an unowned module: " + specifier);
}

/** A module space where the vibe tool module does not resolve. */
function throwRequire(specifier: string): unknown {
  throw new Error("Cannot find package '@oh-my-pi/pi-coding-agent' from " + specifier);
}

function harness(options: { vibeModule?: boolean } = {}): Harness {
  const file = writeVibeExtension(tempLineage());
  const source = fs.readFileSync(file, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const loaded = { exports: {} as { default?: (api: unknown) => void } };
  Function("module", "exports", "require", outputText)(
    loaded,
    loaded.exports,
    options.vibeModule === false ? throwRequire : fakeRequire,
  );
  const factory = loaded.exports.default;
  if (!factory) throw new Error("generated vibe extension has no default factory");

  const statuses: VibeSnapshot[] = [];
  let handler: ((args: string, ctx: Record<string, unknown>) => Promise<void>) | undefined;
  let spawnSequence = 0;

  class FakeAgentSession {
    id: string;
    prompts: string[] = [];
    modes: { mode: string; data?: Record<string, unknown> }[] = [];
    events: { type: string; [key: string]: unknown }[] = [];
    enabledTools: string[];
    vibeState: { enabled: boolean } | undefined = undefined;
    workers: Worker[] = [];
    killCalls: string[] = [];
    spawnCalls: Array<Record<string, unknown>> = [];
    isStreaming = false;
    planMode: boolean;
    goalStatus: string | null;
    activateCalls: string[][] = [];
    deactivateCalls: string[][] = [];
    disposeCalls = 0;
    listeners: ((event: { type: string }) => void)[] = [];
    private entries: Array<{ type: string; customType?: string; mode?: string; data?: unknown }>;
    private readonly throwing: Set<string>;
    /** Tools getToolByName answers with once activateVibeTools has mounted them. */
    private mounted = false;

    constructor(id: string, options: Options = {}) {
      this.id = id;
      this.enabledTools = ["read", "grep", "write", "todo"];
      this.planMode = options.planMode ?? false;
      this.goalStatus = options.goalStatus ?? null;
      this.entries = options.entries ?? [];
      this.throwing = new Set(options.throwing ?? []);
      for (const name of options.without ?? []) {
        // omp's surface lives on the prototype: shadow the own slot with
        // undefined so the bridge's probe sees a missing member.
        Object.defineProperty(this, name, { value: undefined, configurable: true });
      }
    }

    // --- omp surface the bridge drives -------------------------------------

    sessionManager = {
      getSessionId: (): string => this.id,
      appendModeChange: (mode: string, data?: Record<string, unknown>): string => {
        this.modes.push({ mode, ...(data ? { data } : {}) });
        return "entry-" + this.modes.length;
      },
      getEntries: (): Array<{ type: string; customType?: string; mode?: string; data?: unknown }> =>
        this.entries,
    };

    getVibeModeState(): { enabled: boolean } | undefined {
      return this.vibeState;
    }

    setVibeModeState(state: { enabled: boolean } | undefined): void {
      this.vibeState = state;
    }

    activateVibeTools(keep: string[]): Promise<void> {
      this.activateCalls.push([...keep]);
      this.mounted = true;
      this.enabledTools = [...keep, "vibe_spawn", "vibe_send", "vibe_wait", "vibe_kill", "vibe_list"];
      return Promise.resolve();
    }

    deactivateVibeTools(restore: string[]): Promise<void> {
      this.deactivateCalls.push([...restore]);
      this.mounted = false;
      this.enabledTools = [...restore];
      return Promise.resolve();
    }

    /** omp's teardown awaits the body but resolves undefined. */
    async runModeExitTeardown(work: () => Promise<unknown>): Promise<void> {
      await work();
    }

    getToolByName(name: string): { execute: (...args: unknown[]) => unknown } | undefined {
      if (!this.mounted) return undefined;
      return { execute: (...args: unknown[]) => this.runTool(name, args) };
    }

    getEnabledToolNames(): string[] {
      return [...this.enabledTools];
    }

    getPlanModeState(): { enabled: boolean } | undefined {
      return this.planMode ? { enabled: true } : undefined;
    }

    getGoalModeState(): { goal?: { status: string } } | undefined {
      return this.goalStatus === null ? undefined : { goal: { status: this.goalStatus } };
    }

    getAgentId(): string {
      return "Main";
    }

    hasBuiltInTool(name: string): boolean {
      return name === "read" || name === "todo";
    }

    subscribe(listener: (event: { type: string }) => void): () => void {
      this.listeners.push(listener);
      return () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      };
    }

    prompt(text: string): Promise<boolean> {
      this.prompts.push(text);
      return Promise.resolve(true);
    }

    dispose(): void {
      this.disposeCalls += 1;
    }

    // --- test-side drivers -------------------------------------------------

    /** The vibe_* tools' shared execute: worker semantics live only here. */
    private runTool(name: string, args: unknown[]): unknown {
      if (this.throwing.has(name)) throw new Error(name + " exploded");
      const input = (args[1] ?? {}) as Record<string, unknown>;
      const text = (body: string, details: Record<string, unknown>): unknown => ({
        content: [{ type: "text", text: body }],
        details,
      });
      if (name === "vibe_list") {
        return text("roster", { screens: this.workers.map((w) => ({ ...w })) });
      }
      if (name === "vibe_spawn") {
        spawnSequence += 1;
        const id = typeof input.name === "string" ? input.name : "Worker" + spawnSequence;
        const cli = input.cli === "good" ? "good" : "fast";
        const worker: Worker = {
          id,
          cli,
          state: "running",
          killed: false,
          model: "vllm/qwen:medium",
          turns: 1,
          queued: 0,
          turnMessage: "start",
          currentTool: null,
          lastIntent: null,
          createdAt: 1000,
        };
        this.workers.push(worker);
        this.spawnCalls.push({ ...input, id });
        this.addLifecycle({
          action: "spawn",
          id,
          cli,
          agent: cli === "good" ? "task" : "sonic",
          childSessionFile: id + ".jsonl",
          createdAt: 1000,
        });
        return text("Spawned " + cli + " session `" + id + "`.", {
          screens: this.workers.map((w) => ({ ...w })),
          spawned: { id, cli },
        });
      }
      if (name === "vibe_send") {
        const worker = this.workers.find((w) => w.id === input.session);
        if (worker === undefined || worker.killed) throw new Error("no such session");
        worker.state = "running";
        return text("Queued for " + worker.id + ".", { screens: this.workers.map((w) => ({ ...w })) });
      }
      if (name === "vibe_wait") {
        for (const worker of this.workers) if (worker.state === "running") worker.state = "idle";
        return text("settled", { screens: this.workers.map((w) => ({ ...w })) });
      }
      if (name === "vibe_kill") {
        const worker = this.workers.find((w) => w.id === input.session);
        if (worker === undefined) throw new Error("no such session");
        worker.killed = true;
        worker.state = "dead";
        this.killCalls.push(worker.id);
        this.addLifecycle({ action: "tombstone", id: worker.id, reason: "explicit-kill" });
        return text("Killed session `" + worker.id + "`.", { screens: this.workers.map((w) => ({ ...w })) });
      }
      throw new Error("unknown tool: " + name);
    }

    addWorker(worker: Worker): void {
      this.workers.push(worker);
    }

    addLifecycle(entry: LifecycleEntry): void {
      this.entries.push({ type: "custom", customType: "vibe-session-lifecycle", data: entry });
    }

    fire(event: { type: string; [key: string]: unknown }): void {
      this.events.push(event);
      for (const listener of [...this.listeners]) listener(event);
    }
  }

  factory({
    pi: { AgentSession: FakeAgentSession },
    registerCommand: (name: string, options: { handler: typeof handler }): void => {
      expect(name).toBe(VIBE_COMMAND);
      handler = options.handler;
    },
  });

  const invoke = async (args: string): Promise<void> => {
    if (!handler) throw new Error("generated extension registered no command");
    await handler(args, {
      ui: {
        setStatus: (key: string, text: string | undefined): void => {
          expect(key).toBe(VIBE_STATUS_KEY);
          const snapshot = parseVibeSnapshot(text);
          if (snapshot === null) throw new Error("published a snapshot the shared wire parser rejects");
          statuses.push(snapshot);
        },
        notify: (): void => undefined,
      },
    });
    await Promise.resolve();
  };

  return {
    AgentSession: FakeAgentSession as unknown as Harness["AgentSession"],
    invoke,
    arm: async (): Promise<void> => {
      await flush();
      await invoke("");
    },
    command: ({ command, args = "", sessionId }): Promise<void> => {
      const snapshot = statuses.at(-1);
      return invoke(
        "command " +
          JSON.stringify({
            requestId: "req-" + command + "-" + statuses.length,
            sessionId: sessionId ?? snapshot?.sessionId ?? "unknown",
            processKey: snapshot?.processKey ?? "",
            command,
            args,
          }),
      );
    },
    snapshot: (): VibeSnapshot => {
      const value = statuses.at(-1);
      if (!value) throw new Error("the bridge published no snapshot");
      return value;
    },
    statuses,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

/** Binds a root by prompting, then arms the bridge as the spawner's first command does. */
async function armed(h: Harness, id = "session-a", options: Options = {}): Promise<Session> {
  const root = new h.AgentSession(id, options);
  await root.prompt("hello");
  await h.arm();
  return root;
}

function worker(over: Partial<VibeWorker> = {}): VibeWorker {
  return {
    id: "W1",
    cli: "fast",
    state: "running",
    killed: false,
    model: "vllm/qwen:medium",
    turns: 1,
    queued: 0,
    turnMessage: null,
    currentTool: null,
    lastIntent: null,
    createdAt: 1000,
    ...over,
  };
}

// ------------------------------------------------------------------- tests

describe("writeVibeExtension", () => {
  it("writes the bridge into the lineage dir and is rewritten on every spawn", () => {
    const lineage = path.join(tempLineage(), "nested");
    const file = writeVibeExtension(lineage);
    expect(file).toBe(vibeExtensionPath(lineage));
    expect(fs.existsSync(file)).toBe(true);
    fs.writeFileSync(file, "// stale\n", "utf8");
    writeVibeExtension(lineage);
    expect(fs.readFileSync(file, "utf8")).toContain(JSON.stringify(VIBE_STATUS_KEY));
  });

  it("emits a generated source that strictly typechecks and carries the wire contract", () => {
    const file = writeVibeExtension(tempLineage());
    typecheckGeneratedExtension(file);
    const source = fs.readFileSync(file, "utf8");
    for (const constant of [VIBE_COMMAND, VIBE_STATUS_KEY]) {
      expect(source).toContain(JSON.stringify(constant));
    }
    expect(source).toContain(JSON.stringify("omp-ui:mode-transition"));
    expect(source).toContain(JSON.stringify("vibe-session-lifecycle"));
    // omp's own surface drives everything: the bridge writes no transcript
    // field of its own beyond omp's mode entries.
    expect(source).not.toContain("appendCustomEntry");
  });
});

describe("vibe bridge arm and availability", () => {
  it("publishes an available snapshot on a bare arm without touching the model", async () => {
    const h = harness();
    const root = await armed(h);
    const snapshot = h.snapshot();
    expect(snapshot.available).toBe(true);
    expect(snapshot.unavailable).toBeNull();
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.workers).toEqual([]);
    expect(root.prompts).toEqual(["hello"]);
    expect(root.activateCalls).toEqual([]);
  });

  it("reports unavailable when the vibe module cannot resolve", async () => {
    const h = harness({ vibeModule: false });
    await armed(h, "session-nomodule");
    const snapshot = h.snapshot();
    expect(snapshot.available).toBe(false);
    expect(snapshot.unavailable).toContain("vibe tools");
  });

  it("reports unavailable with a reason when a session API is missing", async () => {
    const h = harness();
    await armed(h, "session-m", { without: ["activateVibeTools"] });
    const snapshot = h.snapshot();
    expect(snapshot.available).toBe(false);
    expect(snapshot.unavailable).toContain("activateVibeTools");
  });

  it("binds the root once and never retargets to a descendant session", async () => {
    const h = harness();
    const root = await armed(h, "root");
    const descendant = new h.AgentSession("descendant");
    await descendant.prompt("subagent work");
    await h.command({ command: "toggle", sessionId: root.id });
    expect(root.vibeState).toEqual({ enabled: true });
    expect(descendant.vibeState).toBeUndefined();
    expect(descendant.activateCalls).toEqual([]);
  });

  it("ignores a command addressed to another process", async () => {
    const h = harness();
    const root = await armed(h);
    await h.invoke(
      "command " +
        JSON.stringify({
          requestId: "req-x",
          sessionId: root.id,
          processKey: "omp-ui-someone-elses",
          command: "toggle",
          args: "",
        }),
    );
    expect(root.vibeState).toBeUndefined();
    expect(root.activateCalls).toEqual([]);
  });
});

describe("vibe enter and exit", () => {
  it("enters through omp's activate and arms the mode", async () => {
    const h = harness();
    const root = await armed(h);
    await h.command({ command: "toggle", sessionId: root.id });
    expect(root.activateCalls).toEqual([["read", "todo"]]);
    expect(root.vibeState).toEqual({ enabled: true });
    expect(root.modes.at(-1)?.mode).toBe("vibe");
    const snapshot = h.snapshot();
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.workers).toEqual([]);
  });

  it("exits through omp's deactivate and clears the roster", async () => {
    const h = harness();
    const root = await armed(h);
    await h.command({ command: "toggle", sessionId: root.id });
    root.addWorker(worker({ id: "W1" }));
    await h.command({ command: "toggle", sessionId: root.id });
    expect(root.vibeState).toBeUndefined();
    expect(root.modes.at(-1)?.mode).toBe("none");
    expect(root.killCalls).toEqual(["W1"]);
    expect(h.snapshot().enabled).toBe(false);
    expect(h.snapshot().workers).toEqual([]);
  });

  it("refuses to enter while plan mode owns the slot", async () => {
    const h = harness();
    const root = await armed(h, "session-plan", { planMode: true });
    await h.command({ command: "toggle", sessionId: root.id });
    expect(root.vibeState).toBeUndefined();
    expect(h.snapshot().result?.ok).toBe(false);
    expect(h.snapshot().result?.text).toContain("plan mode");
  });

  it("refuses to enter while an unfinished goal owns the slot", async () => {
    const h = harness();
    const root = await armed(h, "session-goal", { goalStatus: "paused" });
    await h.command({ command: "toggle", sessionId: root.id });
    expect(root.vibeState).toBeUndefined();
    expect(h.snapshot().result?.text).toContain("goal");
  });

  it("refuses to enter while the session is busy", async () => {
    const h = harness();
    const root = await armed(h);
    root.isStreaming = true;
    await h.command({ command: "toggle", sessionId: root.id });
    expect(root.vibeState).toBeUndefined();
    expect(h.snapshot().result?.ok).toBe(false);
  });
});

describe("vibe worker commands", () => {
  it("spawns through the mounted tool and reports the roster", async () => {
    const h = harness();
    const root = await armed(h);
    await h.command({ command: "toggle", sessionId: root.id });
    await h.command({ command: "spawn", args: JSON.stringify({ cli: "good", prompt: "fix it" }), sessionId: root.id });
    expect(root.spawnCalls[0]).toMatchObject({ cli: "good", prompt: "fix it" });
    const snapshot = h.snapshot();
    expect(snapshot.workers).toHaveLength(1);
    expect(snapshot.workers[0]).toMatchObject({ cli: "good", state: "running" });
  });

  it("rejects a spawn with no prompt before touching the tool", async () => {
    const h = harness();
    const root = await armed(h);
    await h.command({ command: "toggle", sessionId: root.id });
    await h.command({ command: "spawn", args: JSON.stringify({ prompt: "  " }), sessionId: root.id });
    expect(root.spawnCalls).toEqual([]);
    expect(h.snapshot().result?.ok).toBe(false);
  });

  it("keeps a well-formed worker name and drops a bad one", async () => {
    const h = harness();
    const root = await armed(h);
    await h.command({ command: "toggle", sessionId: root.id });
    await h.command({ command: "spawn", args: JSON.stringify({ prompt: "x", name: "my_worker" }), sessionId: root.id });
    await h.command({ command: "spawn", args: JSON.stringify({ prompt: "y", name: "bad name!" }), sessionId: root.id });
    expect(root.spawnCalls[0]?.name).toBe("my_worker");
    expect("name" in (root.spawnCalls[1] ?? {})).toBe(false);
  });

  it("kills a worker through the tool and keeps it as a dead tombstone", async () => {
    const h = harness();
    const root = await armed(h);
    await h.command({ command: "toggle", sessionId: root.id });
    await h.command({ command: "spawn", args: JSON.stringify({ prompt: "go" }), sessionId: root.id });
    const id = String(root.spawnCalls[0]?.id);
    await h.command({ command: "kill", args: JSON.stringify({ session: id }), sessionId: root.id });
    expect(root.killCalls).toEqual([id]);
    expect(h.snapshot().workers[0]).toMatchObject({ id, state: "dead", killed: true });
  });

  it("clamps the wait timeout into the tool's range", async () => {
    const h = harness();
    const root = await armed(h);
    await h.command({ command: "toggle", sessionId: root.id });
    await h.command({ command: "spawn", args: JSON.stringify({ prompt: "go" }), sessionId: root.id });
    await h.command({ command: "wait", args: JSON.stringify({ timeout: 99_999 }), sessionId: root.id });
    expect(h.snapshot().result?.ok).toBe(true);
    expect(root.workers.every((w) => w.state !== "running")).toBe(true);
  });

  it("settles a tool failure as a failed result, not a thrown command", async () => {
    const h = harness();
    const root = await armed(h, "session-fail", { throwing: ["vibe_spawn"] });
    await h.command({ command: "toggle", sessionId: root.id });
    await h.command({ command: "spawn", args: JSON.stringify({ prompt: "go" }), sessionId: root.id });
    expect(h.snapshot().result?.ok).toBe(false);
    expect(h.snapshot().result?.text).toContain("vibe_spawn exploded");
  });

  it("refuses a worker command while the mode is off", async () => {
    const h = harness();
    const root = await armed(h);
    await h.command({ command: "send", args: JSON.stringify({ session: "W1", message: "hi" }), sessionId: root.id });
    expect(h.snapshot().result?.ok).toBe(false);
    expect(h.snapshot().result?.text).toContain("off");
  });

  it("lists live workers in text", async () => {
    const h = harness();
    const root = await armed(h);
    await h.command({ command: "toggle", sessionId: root.id });
    root.addWorker(worker({ id: "Alpha", state: "running" }));
    await h.command({ command: "list", sessionId: root.id });
    expect(h.snapshot().result?.text).toContain("Alpha");
    expect(h.snapshot().result?.text).toContain("running");
  });
});

describe("vibe restore after resume", () => {
  it("reconstructs a parked roster from lifecycle entries with no live scope", async () => {
    const h = harness();
    await armed(h, "session-resume", {
      entries: [
        {
          type: "custom",
          customType: "vibe-session-lifecycle",
          data: { action: "spawn", id: "OldWorker", cli: "fast", agent: "sonic", childSessionFile: "OldWorker.jsonl", createdAt: 5 },
        },
        { type: "custom", customType: "vibe-session-lifecycle", data: { action: "turn-settled", id: "OldWorker", turn: 1 } },
      ],
    });
    const snapshot = h.snapshot();
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.workers).toHaveLength(1);
    expect(snapshot.workers[0]).toMatchObject({ id: "OldWorker", state: "parked", turns: 1 });
  });

  it("drops a worker an explicit kill removed from the roster", async () => {
    const h = harness();
    await armed(h, "session-killed", {
      entries: [
        { type: "custom", customType: "vibe-session-lifecycle", data: { action: "spawn", id: "Gone", cli: "fast", agent: "sonic", childSessionFile: "Gone.jsonl", createdAt: 5 } },
        { type: "custom", customType: "vibe-session-lifecycle", data: { action: "tombstone", id: "Gone", reason: "explicit-kill" } },
      ],
    });
    expect(h.snapshot().workers).toEqual([]);
  });

  it("re-arms a transcript that never exited vibe mode over the dead scope", async () => {
    const h = harness();
    const root = await armed(h, "session-live", {
      entries: [
        { type: "mode_change", mode: "vibe" },
        { type: "custom", customType: "vibe-session-lifecycle", data: { action: "spawn", id: "Parked", cli: "good", agent: "task", childSessionFile: "Parked.jsonl", createdAt: 5 } },
      ],
    });
    expect(root.vibeState).toEqual({ enabled: true });
    expect(root.activateCalls.length).toBe(1);
    const snapshot = h.snapshot();
    expect(snapshot.enabled).toBe(true);
  });
});

describe("parseVibeSnapshot", () => {
  const base = {
    version: 1,
    processKey: "p",
    sessionId: "s",
    revision: 1,
    available: true,
    unavailable: null,
    enabled: false,
    workers: [],
    result: null,
  };

  it("accepts a valid snapshot from an object or a JSON string", () => {
    expect(parseVibeSnapshot(base)).toMatchObject({ available: true, workers: [] });
    expect(parseVibeSnapshot(JSON.stringify(base))).toMatchObject({ revision: 1 });
  });

  it("rejects malformed shape, agreement violations, and bad workers", () => {
    expect(parseVibeSnapshot(null)).toBeNull();
    expect(parseVibeSnapshot({ ...base, version: 2 })).toBeNull();
    expect(parseVibeSnapshot({ ...base, available: true, unavailable: "x" })).toBeNull();
    expect(parseVibeSnapshot({ ...base, workers: [{ id: "bad id", cli: "fast", state: "running", killed: false, model: null, turns: 0, queued: 0, createdAt: 0 }] })).toBeNull();
    expect(parseVibeSnapshot({ ...base, workers: [{ ...worker(), killed: true, state: "running" }] })).toBeNull();
    expect(parseVibeSnapshot({ ...base, workers: [{ ...worker(), state: "parked", queued: 3 }] })).toBeNull();
  });
});
