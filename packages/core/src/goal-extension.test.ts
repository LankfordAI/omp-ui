import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GOAL_COMMAND,
  GOAL_STATUS_KEY,
  goalArmMessage,
  goalMessage,
  parseGoalSnapshot,
  parseGoalCommandRequest,
  type GoalSnapshot,
} from "./goal";
import { goalExtensionPath, writeGoalExtension } from "./goal-extension";

const dirs: string[] = [];

function tempLineage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-goal-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ fixtures

type Status = "active" | "paused" | "budget-limited" | "complete" | "dropped";

interface GoalRecord {
  id: string;
  objective: string;
  status: Status;
  tokenBudget?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

interface ModeState {
  enabled: boolean;
  mode: string;
  goal: GoalRecord;
}

interface Options {
  /** The goal saved in the branch context, exactly as omp's modeData carries it. */
  saved?: { mode: "goal" | "goal_paused"; goal: GoalRecord } | null;
  planMode?: boolean;
  vibeMode?: boolean;
  goalSetting?: boolean | null;
  enabledTools?: string[];
  knownTools?: string[];
  /** Session or runtime members the fake refuses to expose. */
  without?: string[];
  /** Runtime members that answer by throwing. */
  throwing?: string[];
}

interface Harness {
  AgentSession: new (id: string, options?: Options) => Session;
  invoke: (args: string) => Promise<void>;
  arm: () => Promise<void>;
  command: (request: { command: string; args: string; sessionId?: string }) => Promise<void>;
  snapshot: () => GoalSnapshot;
  statuses: GoalSnapshot[];
  answer: (value: string | boolean | undefined) => void;
  dialogs: { kind: string; title: string }[];
}

interface Session {
  id: string;
  state: ModeState | null;
  prompts: string[];
  turns: { customType: string; content: string; display: boolean; attribution: string }[];
  modes: { mode: string; data?: Record<string, unknown> }[];
  events: { type: string; [key: string]: unknown }[];
  runStates: (string | undefined)[];
  enabledTools: string[];
  knownTools: string[];
  presentations: { enabled: string[]; mounted: string[] }[];
  isStreaming: boolean;
  isAborting: boolean;
  isCompacting: boolean;
  hasPostPromptWork: boolean;
  queuedMessageCount: number;
  planMode: boolean;
  vibeMode: boolean;
  goalSetting: boolean | null;
  turnGate: { promise: Promise<void>; resolve: () => void } | null;
  /** Set when the fake refuses a turn the way AgentBusyError does. */
  turnRejects: boolean;
  abortCalls: number;
  disposeCalls: number;
  sessionChangeListeners: (() => void)[];
  prompt(text: string): Promise<boolean>;
  fire(event: { type: string; [key: string]: unknown }): void;
  emitRunState(state?: string): void;
  [key: string]: unknown;
}

/** Transpiles the generated file and instantiates one factory per fake class. */
function harness(): Harness {
  const file = writeGoalExtension(tempLineage());
  const source = fs.readFileSync(file, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const loaded = { exports: {} as { default?: (api: unknown) => void } };
  Function("module", "exports", outputText)(loaded, loaded.exports);
  const factory = loaded.exports.default;
  if (!factory) throw new Error("generated goal extension has no default factory");

  const statuses: GoalSnapshot[] = [];
  const dialogs: { kind: string; title: string }[] = [];
  const queued: (string | boolean | undefined)[] = [];
  /** Dialogs consume answers in order, so one command can drive several. */
  const nextAnswer = (): string | boolean | undefined => queued.shift();
  let handler:
    | ((args: string, ctx: Record<string, unknown>) => Promise<void>)
    | undefined;

  let goalSequence = 0;
  const unfinished = (state: ModeState | null): boolean =>
    state !== null && state.goal.status !== "complete" && state.goal.status !== "dropped";

  class FakeAgentSession {
    id: string;
    state: ModeState | null = null;
    prompts: string[] = [];
    turns: { customType: string; content: string; display: boolean; attribution: string }[] = [];
    modes: { mode: string; data?: Record<string, unknown> }[] = [];
    events: { type: string; [key: string]: unknown }[] = [];
    runStates: (string | undefined)[] = [];
    enabledTools: string[];
    knownTools: string[];
    presentations: { enabled: string[]; mounted: string[] }[] = [];
    isStreaming = false;
    isAborting = false;
    turnWaiters: (() => void)[] = [];
    hasPostPromptWork = false;
    queuedMessageCount = 0;
    planMode: boolean;
    vibeMode: boolean;
    goalSetting: boolean | null;
    turnGate: { promise: Promise<void>; resolve: () => void } | null = null;
    turnRejects = false;
    abortCalls = 0;
    disposeCalls = 0;
    sessionChangeListeners: (() => void)[] = [];
    saved: { mode: string; goal?: GoalRecord } | null;
    listeners: ((event: { type: string }) => void)[] = [];
    runStateListeners: ((state?: string) => void)[] = [];

    constructor(id: string, options: Options = {}) {
      this.id = id;
      this.enabledTools = options.enabledTools ?? ["read", "grep"];
      this.knownTools = options.knownTools ?? ["read", "grep", "goal", "write"];
      this.planMode = options.planMode ?? false;
      this.vibeMode = options.vibeMode ?? false;
      this.goalSetting = options.goalSetting === undefined ? true : options.goalSetting;
      this.saved = options.saved
        ? { mode: options.saved.mode, goal: options.saved.goal }
        : null;
      const runtime = this.goalRuntime as Record<string, unknown>;
      for (const name of options.without ?? []) delete runtime[name];
      for (const name of options.throwing ?? []) {
        runtime[name] = () => {
          throw new Error(name + " exploded");
        };
      }
      for (const name of options.without ?? []) {
        if (RUNTIME_NAMES.indexOf(name) < 0) delete (this as Record<string, unknown>)[name];
      }
    }

    // --- omp surface the bridge drives -------------------------------------

    settings = {
      get: (key: string): unknown => (key === "goal.enabled" ? this.goalSetting : undefined),
    };

    sessionManager = {
      getSessionId: (): string => this.id,
      buildSessionContext: (): { mode: string; modeData?: Record<string, unknown> } => ({
        mode: this.saved?.mode ?? "none",
        ...(this.saved?.goal ? { modeData: { goal: this.saved.goal } } : {}),
      }),
      appendModeChange: (mode: string, data?: Record<string, unknown>): string => {
        this.modes.push({ mode, ...(data ? { data } : {}) });
        this.saved = mode === "none" ? null : { mode, goal: (data?.goal as GoalRecord) ?? undefined };
        return "entry-" + this.modes.length;
      },
    };

    goalRuntime = {
      createGoal: (input: { objective: string; tokenBudget?: number }): ModeState => {
        if (unfinished(this.state)) throw new Error("cannot create a new goal because this session already has a goal");
        this.state = { enabled: true, mode: "active", goal: this.record(input.objective, input.tokenBudget) };
        this.persist();
        this.fire({ type: "goal_updated", goal: this.state.goal, state: this.state });
        return this.state;
      },
      replaceGoal: (input: { objective: string; tokenBudget?: number }): ModeState => {
        if (this.state === null || !this.state.enabled) throw new Error("cannot replace goal because no goal is active");
        this.state = { enabled: true, mode: "active", goal: this.record(input.objective, input.tokenBudget) };
        this.persist();
        this.fire({ type: "goal_updated", goal: this.state.goal, state: this.state });
        return this.state;
      },
      resumeGoal: (): ModeState => {
        if (this.state === null) throw new Error("No paused goal.");
        if (this.state.goal.status === "complete") throw new Error("Goal is already complete.");
        this.state = {
          enabled: true,
          mode: "active",
          goal: { ...this.state.goal, status: "active", updatedAt: Date.now() },
        };
        this.persist();
        this.fire({ type: "goal_updated", goal: this.state.goal, state: this.state });
        return this.state;
      },
      pauseGoal: (): ModeState | undefined => {
        if (this.state === null) return undefined;
        const status: Status =
          this.state.goal.status === "active" || this.state.goal.status === "budget-limited"
            ? "paused"
            : this.state.goal.status;
        this.state = { enabled: false, mode: "active", goal: { ...this.state.goal, status, updatedAt: Date.now() } };
        this.persist();
        this.fire({ type: "goal_updated", goal: this.state.goal, state: this.state });
        return this.state;
      },
      dropGoal: (): GoalRecord | undefined => {
        if (this.state === null) return undefined;
        const dropped = { ...this.state.goal, status: "dropped" as Status, updatedAt: Date.now() };
        this.fire({ type: "goal_updated", goal: dropped, state: { enabled: false, mode: "active", goal: dropped } });
        this.state = null;
        this.modes.push({ mode: "none" });
        this.saved = null;
        return dropped;
      },
      onBudgetMutated: (budget: number | undefined): ModeState | undefined => {
        if (this.state === null) return undefined;
        const goal = { ...this.state.goal, tokenBudget: budget, updatedAt: Date.now() };
        let status = goal.status;
        let enabled = this.state.enabled;
        if (budget !== undefined && goal.tokensUsed >= budget && status === "active") status = "budget-limited";
        else if (status === "budget-limited") {
          status = "active";
          enabled = true;
        }
        this.state = { enabled, mode: "active", goal: { ...goal, status } };
        this.persist();
        this.fire({ type: "goal_updated", goal: this.state.goal, state: this.state });
        return this.state;
      },
      onThreadResumed: (): ModeState | undefined => {
        if (this.state === null) return undefined;
        if (this.state.goal.status === "active") {
          this.state = {
            enabled: false,
            mode: "active",
            goal: { ...this.state.goal, status: "paused", updatedAt: Date.now() },
          };
          this.persist();
          this.fire({ type: "goal_updated", goal: this.state.goal, state: this.state });
          return this.state;
        }
        this.fire({ type: "goal_updated", goal: this.state.goal, state: this.state });
        return this.state;
      },
      clearAccounting: (): void => undefined,
      buildContinuationPrompt: (): string | undefined =>
        this.state !== null && this.state.enabled && this.state.goal.status === "active"
          ? "continue toward " + this.state.goal.objective
          : undefined,
    };

    getGoalModeState(): ModeState | undefined {
      return this.state ?? undefined;
    }

    setGoalModeState(state: ModeState | undefined): void {
      this.state = state ?? null;
    }

    getPlanModeState(): { enabled: boolean } | undefined {
      return this.planMode ? { enabled: true } : undefined;
    }

    getVibeModeState(): { enabled: boolean } | undefined {
      return this.vibeMode ? { enabled: true } : undefined;
    }

    getEnabledToolNames(): string[] {
      return [...this.enabledTools];
    }

    getMountedXdevToolNames(): string[] {
      return [];
    }

    getAllToolInfos(): { name: string }[] {
      return this.knownTools.map((name) => ({ name }));
    }

    setActiveToolPresentation(enabled: string[], mounted: string[]): Promise<void> {
      this.presentations.push({ enabled: [...enabled], mounted: [...mounted] });
      this.enabledTools = [...enabled];
      return Promise.resolve();
    }

    runToolRegistryMutation(work: () => Promise<unknown>): Promise<unknown> {
      return work();
    }

    prompt(text: string): Promise<boolean> {
      this.prompts.push(text);
      return Promise.resolve(true);
    }

    promptCustomMessage(message: {
      customType: string;
      content: string;
      display: boolean;
      attribution: string;
    }): Promise<void> {
      this.turns.push(message);
      if (this.turnRejects) return Promise.reject(new Error("AgentBusyError"));
      // omp settles a prompt only once its agent_end has been delivered, so the
      // turn's promise stays pending until the test fires that event.
      return new Promise<void>((resolve) => {
        this.turnWaiters.push(resolve);
      });
    }

    subscribe(listener: (event: { type: string }) => void): () => void {
      this.listeners.push(listener);
      return () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      };
    }

    subscribeRunState(listener: (state?: string) => void): () => void {
      this.runStateListeners.push(listener);
      return () => {
        this.runStateListeners = this.runStateListeners.filter((l) => l !== listener);
      };
    }

    registerSessionChangeCallback(listener: () => void): () => void {
      this.sessionChangeListeners.push(listener);
      return () => {
        this.sessionChangeListeners = this.sessionChangeListeners.filter((l) => l !== listener);
      };
    }

    abort(): Promise<void> {
      this.abortCalls += 1;
      return Promise.resolve();
    }

    dispose(): void {
      this.disposeCalls += 1;
    }

    // --- test-side drivers -------------------------------------------------

    record(objective: string, tokenBudget?: number): GoalRecord {
      goalSequence += 1;
      const now = Date.now();
      return {
        id: "goal-" + goalSequence,
        objective,
        status: "active",
        ...(tokenBudget === undefined ? {} : { tokenBudget }),
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: now,
        updatedAt: now,
      };
    }

    persist(): void {
      const state = this.state;
      if (state === null) return;
      const mode = state.enabled ? "goal" : "goal_paused";
      this.modes.push({ mode, data: { goal: state.goal } });
      this.saved = { mode, goal: state.goal };
    }

    fire(event: { type: string; [key: string]: unknown }): void {
      this.events.push(event);
      for (const listener of [...this.listeners]) listener(event);
      // The turn's own promise settles only after every listener has seen the
      // end, exactly as omp's agent_end precedes the prompt's resolution.
      if (event.type === "agent_end") {
        for (const resolve of this.turnWaiters.splice(0)) resolve();
      }
    }

    emitRunState(state?: string): void {
      this.runStates.push(state);
      for (const listener of [...this.runStateListeners]) listener(state);
    }
  }

  const RUNTIME_NAMES = [
    "createGoal",
    "replaceGoal",
    "resumeGoal",
    "pauseGoal",
    "dropGoal",
    "onBudgetMutated",
    "onThreadResumed",
    "clearAccounting",
    "buildContinuationPrompt",
  ];

  factory({
    pi: { AgentSession: FakeAgentSession },
    registerCommand: (name: string, options: { handler: typeof handler }): void => {
      expect(name).toBe(GOAL_COMMAND);
      handler = options.handler;
    },
  });

  const invoke = async (args: string): Promise<void> => {
    if (!handler) throw new Error("generated extension registered no command");
    await handler(args, {
      ui: {
        setStatus: (key: string, text: string | undefined): void => {
          expect(key).toBe(GOAL_STATUS_KEY);
          const snapshot = parseGoalSnapshot(text);
          if (snapshot === null) throw new Error("published a snapshot the shared wire parser rejects");
          statuses.push(snapshot);
        },
        notify: (): void => undefined,
        select: (title: string): Promise<string | undefined> => {
          dialogs.push({ kind: "select", title });
          const value = nextAnswer();
          return Promise.resolve(typeof value === "string" ? value : undefined);
        },
        input: (title: string): Promise<string | undefined> => {
          dialogs.push({ kind: "input", title });
          const value = nextAnswer();
          return Promise.resolve(typeof value === "string" ? value : undefined);
        },
        editor: (title: string): Promise<string | undefined> => {
          dialogs.push({ kind: "editor", title });
          const value = nextAnswer();
          return Promise.resolve(typeof value === "string" ? value : undefined);
        },
        confirm: (title: string): Promise<boolean> => {
          dialogs.push({ kind: "confirm", title });
          return Promise.resolve(nextAnswer() === true);
        },
      },
    });
    // Let the command's published continuation work settle.
    await Promise.resolve();
  };

  return {
    AgentSession: FakeAgentSession as unknown as Harness["AgentSession"],
    invoke,
    arm: (): Promise<void> => invoke(""),
    command: ({ command, args, sessionId }): Promise<void> => {
      const session = sessionId ?? "";
      const snapshot = statuses.at(-1);
      return invoke(
        "command " +
          JSON.stringify({
            requestId: "req-" + (command === "goal" ? "g" : "x") + "-" + dialogs.length + statuses.length,
            sessionId: session !== "" ? session : (snapshot?.sessionId ?? "unknown"),
            processKey: snapshot?.processKey ?? processKeyOf(statuses),
            command,
            args,
          }),
      );
    },
    snapshot: (): GoalSnapshot => {
      const value = statuses.at(-1);
      if (!value) throw new Error("the bridge published no snapshot");
      return value;
    },
    answer: (value): void => {
      queued.push(value);
    },
    dialogs,
    statuses,
  };
}

function processKeyOf(statuses: GoalSnapshot[]): string {
  const value = statuses.at(-1);
  if (!value) throw new Error("no snapshot published yet");
  return value.processKey;
}

/** Binds a root by prompting, then arms the bridge the spawner's first command does. */
async function armed(h: Harness, id = "session-a", options: Options = {}): Promise<Session> {
  const root = new h.AgentSession(id, options);
  await root.prompt("hello");
  await h.arm();
  return root;
}

/** Lets every settled promise the bridge chains through reach its end. */
async function flush(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

/** Sends one goal command and returns the snapshot it settled with. */
async function send(
  h: Harness,
  root: Session,
  line: string,
): Promise<{ snapshot: GoalSnapshot; ok: boolean; text: string }> {
  const spaceAt = line.search(/\s/);
  const command = spaceAt === -1 ? line : line.slice(0, spaceAt);
  const args = spaceAt === -1 ? "" : line.slice(spaceAt + 1);
  await h.command({ command, args, sessionId: root.id });
  const snapshot = h.snapshot();
  return { snapshot, ok: snapshot.result?.ok === true, text: snapshot.result?.text ?? "" };
}

// ------------------------------------------------------------------- tests

describe("writeGoalExtension", () => {
  it("writes the bridge into the lineage dir and is rewritten on every spawn", () => {
    const lineage = path.join(tempLineage(), "nested");
    const file = writeGoalExtension(lineage);
    expect(file).toBe(goalExtensionPath(lineage));
    expect(fs.existsSync(file)).toBe(true);
    fs.writeFileSync(file, "// stale\n", "utf8");
    writeGoalExtension(lineage);
    expect(fs.readFileSync(file, "utf8")).toContain(JSON.stringify(GOAL_STATUS_KEY));
  });

  it("emits a generated source that compiles and carries the wire contract", () => {
    const source = fs.readFileSync(writeGoalExtension(tempLineage()), "utf8");
    const { diagnostics } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    });
    expect((diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)).toEqual([]);
    for (const constant of [GOAL_COMMAND, GOAL_STATUS_KEY]) {
      expect(source).toContain(JSON.stringify(constant));
    }
    // The chain key the plan bridge joins on, and omp's own custom-type spelling.
    expect(source).toContain(JSON.stringify("omp-ui:mode-transition"));
    expect(source).toContain(JSON.stringify("goal-continuation"));
    // omp's runtime methods are the only mutators: the bridge must never write a
    // transcript field of its own.
    expect(source).not.toContain("appendModeChange(\"goal\"");
    expect(source).not.toContain("appendCustomEntry");
  });
});

describe("goal bridge arm and availability", () => {
  it("publishes an available snapshot on a bare arm without touching the model", async () => {
    const h = harness();
    const root = await armed(h);
    const snapshot = h.snapshot();
    expect(snapshot.available).toBe(true);
    expect(snapshot.unavailable).toBeNull();
    expect(snapshot.goal).toBeNull();
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.continuation).toBe("idle");
    expect(root.turns).toEqual([]);
    expect(root.prompts).toEqual(["hello"]);
  });

  it("restores a saved active goal as paused, preserving usage, and starts nothing", async () => {
    vi.useFakeTimers();
    const h = harness();
    const saved: GoalRecord = {
      id: "saved-1",
      objective: "ship the migration",
      status: "active",
      tokenBudget: 50_000,
      tokensUsed: 12_345,
      timeUsedSeconds: 90,
      createdAt: 1,
      updatedAt: 2,
    };
    const root = await armed(h, "session-r", { saved: { mode: "goal", goal: saved } });
    const snapshot = h.snapshot();
    expect(snapshot.goal).toMatchObject({
      id: "saved-1",
      status: "paused",
      tokensUsed: 12_345,
      tokenBudget: 50_000,
    });
    expect(snapshot.enabled).toBe(false);
    expect(root.turns).toEqual([]);
    vi.advanceTimersByTime(5_000);
    expect(root.turns).toEqual([]);
  });

  it("reports a malformed saved goal as unavailable instead of inventing one", async () => {
    const h = harness();
    const root = await armed(h, "session-b", {
      saved: {
        mode: "goal",
        goal: { id: "", objective: "x", status: "active", tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 },
      },
    });
    const snapshot = h.snapshot();
    expect(snapshot.available).toBe(false);
    expect(snapshot.unavailable).toContain("malformed");
    expect(snapshot.goal).toBeNull();
    // No transcript rewrite: the only mode entries are the ones omp made.
    expect(root.modes).toEqual([]);
  });

  it("publishes unavailable with a reason when a runtime method is missing", async () => {
    const h = harness();
    await armed(h, "session-m", { without: ["resumeGoal"] });
    const snapshot = h.snapshot();
    expect(snapshot.available).toBe(false);
    expect(snapshot.unavailable).toContain("resumeGoal");
  });

  it("answers an unavailable bridge's command with a reason, not success", async () => {
    const h = harness();
    const root = await armed(h, "session-m2", { without: ["createGoal"] });
    const result = await send(h, root, "goal do the thing");
    expect(result.ok).toBe(false);
    expect(result.text).toContain("createGoal");
    expect(root.state).toBeNull();
    expect(root.turns).toEqual([]);
  });

  it("binds the root once and never retargets to a descendant session", async () => {
    const h = harness();
    const root = await armed(h, "root");
    const descendant = new h.AgentSession("descendant");
    await descendant.prompt("subagent work");
    const created = await send(h, root, "goal root objective");
    expect(created.ok).toBe(true);
    expect(root.state?.goal.objective).toBe("root objective");
    expect(descendant.state).toBeNull();
    expect(descendant.turns).toEqual([]);
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
          command: "goal",
          args: "do it",
        }),
    );
    expect(root.state).toBeNull();
  });

  it("refuses a command whose session id no longer matches", async () => {
    const h = harness();
    const root = await armed(h);
    await h.invoke(
      "command " +
        JSON.stringify({
          requestId: "req-x",
          sessionId: "a-different-session",
          processKey: processKeyOf(h.statuses),
          command: "goal",
          args: "do it",
        }),
    );
    const snapshot = h.snapshot();
    expect(snapshot.result?.ok).toBe(false);
    expect(snapshot.result?.text).toContain("session changed");
    expect(root.state).toBeNull();
  });
});

describe("goal verbs against omp's runtime", () => {
  it("creates a goal, starts work on it, and continues it once per clean yield", async () => {
    vi.useFakeTimers();
    const h = harness();
    const root = await armed(h);
    const created = await send(h, root, "goal make the tests pass");
    expect(created.ok).toBe(true);
    expect(root.state).toMatchObject({
      enabled: true,
      goal: { status: "active", objective: "make the tests pass" },
    });
    expect(root.modes.map((entry) => entry.mode)).toContain("goal");
    expect(root.turns.at(-1)).toMatchObject({ customType: "omp-ui:goal-start", display: true });
    expect(root.turns.at(-1)?.content).toBe("make the tests pass");
    // The goal tool is enabled without dropping anything the session had.
    expect(root.enabledTools).toContain("goal");
    expect(root.enabledTools).toContain("read");

    root.fire({ type: "tool_execution_end", toolName: "edit" });
    root.fire({ type: "agent_end", messages: [{ role: "assistant", stopReason: "toolUse" }] });
    expect(h.snapshot().continuation).toBe("scheduled");
    vi.advanceTimersByTime(800);
    await flush();
    expect(root.turns.filter((t) => t.customType === "goal-continuation")).toHaveLength(1);
    expect(root.turns.at(-1)).toMatchObject({ display: false, attribution: "agent" });

    // A second clean yield that used tools schedules exactly one more, no more.
    root.fire({ type: "tool_execution_end", toolName: "edit" });
    root.fire({ type: "agent_end", messages: [{ role: "assistant", stopReason: "toolUse" }] });
    vi.advanceTimersByTime(800);
    await flush();
    expect(root.turns.filter((t) => t.customType === "goal-continuation")).toHaveLength(2);
    vi.advanceTimersByTime(5_000);
    await flush();
    expect(root.turns.filter((t) => t.customType === "goal-continuation")).toHaveLength(2);
  });

  it("reports its own budget arithmetic through /goal show and never prompts", async () => {
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal set bounded work");
    await h.command({ command: "goal", args: "budget 1000", sessionId: root.id });
    root.state = { ...root.state!, goal: { ...root.state!.goal, tokensUsed: 400 } };
    const turns = root.turns.length;
    const shown = await send(h, root, "goal show");
    expect(root.turns).toHaveLength(turns);
    expect(shown.text).toContain("bounded work");
    expect(shown.text).toContain("400 of 1000 used");
    expect(shown.text).toContain("600 remaining");
  });

  it("replaces an active goal through replaceGoal with a fresh id and cleared budget", async () => {
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal first");
    await send(h, root, "goal budget 1000");
    const before = root.state!.goal.id;
    const replaced = await send(h, root, "goal set second");
    expect(replaced.ok).toBe(true);
    expect(root.state!.goal.id).not.toBe(before);
    expect(root.state!.goal.objective).toBe("second");
    expect(root.state!.goal.tokenBudget).toBeUndefined();
    expect(root.state!.goal.tokensUsed).toBe(0);
  });

  it("refuses to replace a paused goal until it is resumed or dropped", async () => {
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal keep me");
    await send(h, root, "goal pause");
    const objective = root.state!.goal.objective;
    const attempt = await send(h, root, "goal set overwritten?");
    expect(attempt.ok).toBe(false);
    expect(attempt.text).toContain("Resume the current goal first");
    expect(root.state!.goal.objective).toBe(objective);
  });

  it("cancels a pending continuation on pause and is a no-op when repeated", async () => {
    vi.useFakeTimers();
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal autonomous work");
    root.fire({ type: "agent_end", messages: [] });
    expect(h.snapshot().continuation).toBe("scheduled");
    const paused = await send(h, root, "goal pause");
    expect(paused.ok).toBe(true);
    vi.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(root.turns.filter((t) => t.customType === "goal-continuation")).toHaveLength(0);
    expect(root.state).toMatchObject({ enabled: false, goal: { status: "paused" } });
    const again = await send(h, root, "goal pause");
    expect(again.ok).toBe(true);
    expect(again.text).toContain("already paused");
  });

  it("refuses to resume at or over budget and points at the budget command", async () => {
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal spend wisely");
    await send(h, root, "goal budget 1000");
    root.state = { ...root.state!, goal: { ...root.state!.goal, tokensUsed: 1000, status: "budget-limited" } };
    await send(h, root, "goal pause");
    const attempt = await send(h, root, "goal resume");
    expect(attempt.ok).toBe(false);
    expect(attempt.text).toContain("/goal budget");
    expect(root.state).toMatchObject({ enabled: false, goal: { status: "paused" } });
  });

  it("resumes only when allowed and arms exactly one continuation", async () => {
    vi.useFakeTimers();
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal unfinished");
    await send(h, root, "goal pause");
    const resumed = await send(h, root, "goal resume");
    expect(resumed.ok).toBe(true);
    expect(root.state).toMatchObject({ enabled: true, goal: { status: "active" } });
    vi.advanceTimersByTime(800);
    await Promise.resolve();
    expect(root.turns.filter((t) => t.customType === "goal-continuation")).toHaveLength(1);
    const repeat = await send(h, root, "goal resume");
    expect(repeat.text).toContain("already active");
  });

  it("drops only after confirmation and keeps the session's usage history", async () => {
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal remove the migration blocker");
    h.answer(undefined);
    const cancelled = await send(h, root, "goal drop");
    expect(cancelled.ok).toBe(true);
    expect(cancelled.text).toContain("cancelled");
    expect(root.state).not.toBeNull();
    h.answer(true);
    const dropped = await send(h, root, "goal drop");
    expect(dropped.ok).toBe(true);
    expect(root.state).toBeNull();
    expect(h.snapshot().goal).toBeNull();
    expect(h.snapshot().enabled).toBe(false);
    expect(root.modes.at(-1)?.mode).toBe("none");
    const none = await send(h, root, "goal drop");
    expect(none.ok).toBe(true);
    expect(none.text).toContain("no goal to drop");
  });

  it("accepts only a plain positive safe integer or off as a budget", async () => {
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal guard the token spend");
    for (const bad of ["0", "-5", "12.5", "1e3", "0x10", "1_000", "1000abc", "+7", "1".repeat(30)]) {
      const attempt = await send(h, root, "goal budget " + bad);
      expect(attempt.ok, bad).toBe(false);
      expect(attempt.text, bad).toContain("positive integer");
      expect(root.state!.goal.tokenBudget).toBeUndefined();
    }
    // An omitted value is the dialog's question, not a refusal.
    h.answer(undefined);
    expect((await send(h, root, "goal budget")).text).toContain("cancelled");
    expect(h.dialogs.at(-1)?.kind).toBe("input");
    expect((await send(h, root, "goal budget 1234")).ok).toBe(true);
    expect(root.state!.goal.tokenBudget).toBe(1234);
    expect((await send(h, root, "goal budget OFF")).ok).toBe(true);
    expect(root.state!.goal.tokenBudget).toBeUndefined();
  });

  it("edits a paused goal's budget without resuming it", async () => {
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal paused budget");
    await send(h, root, "goal pause");
    const edited = await send(h, root, "goal budget 2000");
    expect(edited.ok).toBe(true);
    expect(root.state).toMatchObject({ enabled: false, goal: { status: "paused", tokenBudget: 2000 } });
  });

  it("treats the budget as a total and lifts a budget-limited goal back to active", async () => {
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal bounded");
    await send(h, root, "goal budget 1000");
    root.state = { ...root.state!, goal: { ...root.state!.goal, tokensUsed: 1200, status: "budget-limited" } };
    const raised = await send(h, root, "goal budget 5000");
    expect(raised.text).toContain("total, not additional");
    expect(root.state).toMatchObject({ enabled: true, goal: { status: "active" } });
  });

  it("keeps budget-limited goals from starting another autonomous turn", async () => {
    vi.useFakeTimers();
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal exhaust me");
    await send(h, root, "goal budget 10");
    root.fire({ type: "agent_end", messages: [] });
    root.state = { ...root.state!, goal: { ...root.state!.goal, tokensUsed: 40, status: "budget-limited" } };
    root.fire({ type: "goal_updated", goal: root.state.goal, state: root.state });
    root.fire({ type: "agent_end", messages: [] });
    vi.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(root.turns.filter((t) => t.customType === "goal-continuation")).toHaveLength(0);
  });
});

describe("goal command parsing", () => {
  it("reads a subcommand case-insensitively and keeps later text verbatim", async () => {
    const h = harness();
    const root = await armed(h);
    const created = await send(h, root, "goal SET   keep  my  ünïcode\nand a newline");
    expect(created.ok).toBe(true);
    expect(root.state!.goal.objective.startsWith("keep  my  ünïcode")).toBe(true);
    expect(root.state!.goal.objective).toContain("\nand a newline");
  });

  it("treats a first word that is no subcommand as the objective", async () => {
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal prepare the deploy pipeline");
    expect(root.state!.goal.objective).toBe("prepare the deploy pipeline");
    // A reserved verb is the escape hatch for an objective that starts with one.
    await send(h, root, "goal drop");
    await send(h, root, "goal set Set the record straight");
    expect(root.state!.goal.objective).toBe("Set the record straight");
  });

  it("rejects extra arguments to show, pause, resume and drop", async () => {
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal guard the verbs");
    for (const args of ["show extra", "pause now", "resume please", "drop fast"]) {
      const attempt = await send(h, root, "goal " + args);
      expect(attempt.ok, args).toBe(false);
      expect(attempt.text, args).toContain("takes no arguments");
    }
    expect(root.state!.goal.status).toBe("active");
  });

  it("refuses a second goal and directs the user at set, resume or drop", async () => {
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal first objective");
    const second = await send(h, root, "goal second objective");
    expect(second.ok).toBe(false);
    expect(second.text).toContain("/goal set");
    expect(second.text).toContain("/goal resume");
    expect(second.text).toContain("/goal drop");
    expect(root.state!.goal.objective).toBe("first objective");
  });
});

describe("native dialogs behind goal commands", () => {
  it("opens the objective editor for a bare /goal and changes nothing on cancel", async () => {
    const h = harness();
    const root = await armed(h);
    h.answer(undefined);
    const cancelled = await send(h, root, "goal");
    expect(cancelled.ok).toBe(true);
    expect(cancelled.text).toContain("cancelled");
    expect(h.dialogs.at(-1)?.kind).toBe("editor");
    expect(root.state).toBeNull();
  });

  it("offers the state-appropriate menu and honours the choice", async () => {
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal menu work");
    h.answer("Pause");
    const chosen = await send(h, root, "goal");
    expect(chosen.ok).toBe(true);
    expect(h.dialogs.at(-1)?.kind).toBe("select");
    expect(root.state).toMatchObject({ enabled: false, goal: { status: "paused" } });
    h.answer("Resume");
    await send(h, root, "goal");
    expect(root.state).toMatchObject({ enabled: true, goal: { status: "active" } });
    h.answer("Adjust budget");
    h.answer("777");
    await send(h, root, "goal");
    expect(root.state!.goal.tokenBudget).toBe(777);
  });

  it("shows the final details of a completed goal and offers a new one", async () => {
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal finish me");
    root.state = { enabled: false, mode: "exiting", goal: { ...root.state!.goal, status: "complete" } };
    const result = await send(h, root, "goal");
    expect(result.text).toContain("complete");
    expect(result.text).toContain("finish me");
    expect(root.state!.goal.status).toBe("complete");
  });

  it("rejects a dialog answered after the goal was replaced", async () => {
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal original");
    // Simulate a model-issued replacement while the confirm dialog is open.
    h.answer(true);
    const drop = h.command({ command: "goal", args: "drop", sessionId: root.id });
    root.state = { enabled: true, mode: "active", goal: { ...root.state!.goal, id: "replaced", objective: "new" } };
    await drop;
    const snapshot = h.snapshot();
    expect(snapshot.result?.ok).toBe(false);
    expect(snapshot.result?.text).toContain("goal changed");
    expect(root.state!.goal.id).toBe("replaced");
  });
});

describe("modes, settings and tools gate goal activation", () => {
  it("refuses to create or resume under Plan mode and says what to do", async () => {
    const h = harness();
    const root = await armed(h, "session-p", { planMode: true });
    const created = await send(h, root, "goal not here");
    expect(created.ok).toBe(false);
    expect(created.text).toContain("Drop the current goal before entering Plan mode.");
    expect(root.state).toBeNull();
    expect(root.turns).toEqual([]);
  });

  it("refuses while vibe mode owns the session", async () => {
    const h = harness();
    const root = await armed(h, "session-v", { vibeMode: true });
    const created = await send(h, root, "goal not now");
    expect(created.text).toContain("vibe");
    expect(root.state).toBeNull();
  });

  it("refuses when goal.enabled is off, yet keeps status and drop usable", async () => {
    const h = harness();
    const root = await armed(h, "session-o", { goalSetting: false });
    const created = await send(h, root, "goal blocked");
    expect(created.text).toContain("goal.enabled");
    expect(root.state).toBeNull();
    const shown = await send(h, root, "goal show");
    expect(shown.text).toContain("No goal is set.");
    const dropped = await send(h, root, "goal drop");
    expect(dropped.ok).toBe(true);
  });

  it("pauses when the goal tool is disabled mid-goal and restores only goal on resume", async () => {
    vi.useFakeTimers();
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal tool watch");
    expect(root.enabledTools).toContain("goal");
    // The user turns the goal tool off through the capabilities viewer.
    root.enabledTools = ["read", "grep"];
    root.fire({ type: "agent_end", messages: [] });
    vi.advanceTimersByTime(800);
    await Promise.resolve();
    expect(root.state).toMatchObject({ enabled: false, goal: { status: "paused" } });
    expect(h.snapshot().pauseReason).toContain("goal tool was disabled");
    expect(root.turns.filter((t) => t.customType === "goal-continuation")).toHaveLength(0);

    await send(h, root, "goal resume");
    // Resume re-enables only the goal membership; nothing else is replayed.
    expect(root.enabledTools).toEqual(["read", "grep", "goal"]);
    expect(root.presentations.at(-1)?.enabled).toEqual(["read", "grep", "goal"]);
    expect(root.state).toMatchObject({ enabled: true, goal: { status: "active" } });
  });

  it("admits a model-originated create through the same chain and owner", async () => {
    vi.useFakeTimers();
    const h = harness();
    // A model can only reach the goal tool when the tool is available to it.
    const root = await armed(h, "session-mc", { enabledTools: ["read", "grep", "goal"] });
    const runtime = root.goalRuntime as Record<string, unknown>;
    const created = await Promise.resolve(
      (runtime.createGoal as (input: { objective: string }) => unknown)({ objective: "model made me" }),
    );
    expect(created).toBeTruthy();
    root.fire({ type: "agent_end", messages: [] });
    vi.advanceTimersByTime(800);
    await Promise.resolve();
    expect(root.turns.filter((t) => t.customType === "goal-continuation")).toHaveLength(1);
  });

  it("blocks a model-originated create under Plan mode through that same seam", async () => {
    const h = harness();
    const root = await armed(h, "session-mp", { planMode: true });
    const runtime = root.goalRuntime as Record<string, unknown>;
    await expect(
      Promise.resolve((runtime.createGoal as (input: { objective: string }) => unknown)({ objective: "sneaky" })),
    ).rejects.toThrow("Drop the current goal before entering Plan mode.");
    expect(root.state).toBeNull();
  });
});

describe("continuation safety", () => {
  it("dispatches nothing while queued, compacting or post-prompt work remains", async () => {
    vi.useFakeTimers();
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal busy work");
    for (const flag of ["isStreaming", "isCompacting", "hasPostPromptWork"] as const) {
      (root as Record<string, unknown>)[flag] = true;
      root.fire({ type: "agent_end", messages: [] });
      vi.advanceTimersByTime(5_000);
      await Promise.resolve();
      expect(root.turns.filter((t) => t.customType === "goal-continuation")).toHaveLength(0);
      (root as Record<string, unknown>)[flag] = false;
    }
    root.queuedMessageCount = 2;
    root.fire({ type: "agent_end", messages: [] });
    vi.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(root.turns.filter((t) => t.customType === "goal-continuation")).toHaveLength(0);
    // A run-state idle update after the queue drains is what lets it through.
    root.queuedMessageCount = 0;
    root.fire({ type: "agent_end", messages: [] });
    root.emitRunState("idle");
    vi.advanceTimersByTime(800);
    await Promise.resolve();
    expect(root.turns.filter((t) => t.customType === "goal-continuation")).toHaveLength(1);
  });

  it("honours willContinue by waiting for the turn that keeps going", async () => {
    vi.useFakeTimers();
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal still running");
    root.fire({ type: "agent_end", messages: [], willContinue: true });
    vi.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(root.turns.filter((t) => t.customType === "goal-continuation")).toHaveLength(0);
  });

  it("pauses a continuation turn that made no tool progress, visibly", async () => {
    vi.useFakeTimers();
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal no progress");
    root.fire({ type: "agent_end", messages: [] });
    vi.advanceTimersByTime(800);
    await Promise.resolve();
    expect(root.turns.filter((t) => t.customType === "goal-continuation")).toHaveLength(1);
    root.fire({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    vi.advanceTimersByTime(800);
    await flush();
    expect(root.state).toMatchObject({ enabled: false, goal: { status: "paused" } });
    expect(h.snapshot().pauseReason).toContain("no tool progress");
  });

  it("does not pause a goal whose continuation did use tools", async () => {
    vi.useFakeTimers();
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal progress");
    root.fire({ type: "agent_end", messages: [] });
    vi.advanceTimersByTime(800);
    await Promise.resolve();
    root.fire({ type: "tool_execution_end", toolName: "edit" });
    root.fire({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
    vi.advanceTimersByTime(800);
    await Promise.resolve();
    expect(root.state).toMatchObject({ enabled: true, goal: { status: "active" } });
    expect(root.turns.filter((t) => t.customType === "goal-continuation")).toHaveLength(2);
  });

  it("surfaces an errored turn as a pause with omp's reason", async () => {
    vi.useFakeTimers();
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal will error");
    root.fire({ type: "agent_end", messages: [] });
    vi.advanceTimersByTime(800);
    await Promise.resolve();
    root.fire({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "error", errorMessage: "upstream 500" }],
    });
    vi.advanceTimersByTime(800);
    await Promise.resolve();
    expect(root.state).toMatchObject({ enabled: false, goal: { status: "paused" } });
    expect(h.snapshot().pauseReason).toContain("upstream 500");
  });

  it("invalidates a pending timer the moment abort starts, before omp pauses", async () => {
    vi.useFakeTimers();
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal stop me");
    root.fire({ type: "agent_end", messages: [] });
    expect(h.snapshot().continuation).toBe("scheduled");
    (root.abort as () => unknown)();
    vi.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(root.turns.filter((t) => t.customType === "goal-continuation")).toHaveLength(0);
    expect(root.abortCalls).toBe(1);
  });

  it("lets a user prompt win the settle window", async () => {
    vi.useFakeTimers();
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal interrupt me");
    root.fire({ type: "agent_end", messages: [] });
    await root.prompt("actually, look at this instead");
    vi.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(root.turns.filter((t) => t.customType === "goal-continuation")).toHaveLength(0);
    expect(h.snapshot().continuation).toBe("idle");
  });

  it("never starts a goal turn while a dialog is open", async () => {
    vi.useFakeTimers();
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal dialog guard");
    const inflight = h.command({ command: "goal", args: "drop", sessionId: root.id });
    root.fire({ type: "agent_end", messages: [] });
    vi.advanceTimersByTime(5_000);
    await Promise.resolve();
    expect(root.turns.filter((t) => t.customType === "goal-continuation")).toHaveLength(0);
    h.answer(true);
    await inflight;
  });

  it("refuses to start or replace a goal while a turn streams, keeping show and pause usable", async () => {
    const h = harness();
    const root = await armed(h);
    await send(h, root, "goal work in flight");
    root.isStreaming = true;
    const created = await send(h, root, "goal queued steering");
    expect(created.text).toContain("already has a goal");
    const replaced = await send(h, root, "goal set queued steering");
    expect(replaced.text).toContain("Stop the current turn");
    // The goal that is running is untouched, and the read-only verbs answer.
    expect(root.state!.goal.objective).toBe("work in flight");
    const shown = await send(h, root, "goal show");
    expect(shown.ok).toBe(true);
    expect(shown.text).toContain("work in flight");
    h.answer(true);
    const dropped = await send(h, root, "goal drop");
    expect(dropped.ok).toBe(true);
    expect(root.turns.filter((t) => t.customType === "omp-ui:goal-start")).toHaveLength(1);
  });

  it("keeps a rejected continuation turn from wedging the goal or the chain", async () => {
    vi.useFakeTimers();
    const h = harness();
    const root = await armed(h);
    root.turnRejects = true;
    await send(h, root, "goal unreachable turn");
    root.fire({ type: "agent_end", messages: [] });
    vi.advanceTimersByTime(800);
    await flush();
    expect(h.snapshot().continuation).toBe("idle");
    root.turnRejects = false;
    const resumed = await send(h, root, "goal resume");
    expect(resumed.ok).toBe(true);
  });
});

describe("goal wire contract", () => {
  it("round-trips an arm and a command message through the shared parser", () => {
    expect(goalArmMessage()).toBe("/" + GOAL_COMMAND);
    const request = {
      requestId: "r1",
      sessionId: "s1",
      processKey: "p1",
      command: "goal" as const,
      args: "set ship it",
    };
    expect(parseGoalCommandRequest(goalMessage(request).slice(GOAL_COMMAND.length + 2))).toEqual(request);
  });

  it("rejects malformed snapshots instead of reporting no goal", () => {
    expect(parseGoalSnapshot(undefined)).toBeNull();
    expect(parseGoalSnapshot("not json")).toBeNull();
    expect(parseGoalSnapshot({ version: 2, processKey: "p", sessionId: "s", revision: 1 })).toBeNull();
    const base = {
      version: 1,
      processKey: "p",
      sessionId: "s",
      revision: 1,
      available: true,
      unavailable: null,
      enabled: false,
      goal: null,
      continuation: "idle",
      pauseReason: null,
      result: null,
    };
    expect(parseGoalSnapshot(base)?.goal).toBeNull();
    // `enabled` must agree with the goal's status.
    expect(
      parseGoalSnapshot({
        ...base,
        enabled: true,
        goal: { id: "g", objective: "o", status: "paused", tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 },
      }),
    ).toBeNull();
    // A negative counter is malformed, not "no goal".
    expect(
      parseGoalSnapshot({
        ...base,
        goal: { id: "g", objective: "o", status: "active", tokenBudget: null, tokensUsed: -1, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 },
      }),
    ).toBeNull();
    expect(parseGoalSnapshot(JSON.stringify(base))).toEqual(base);
  });
});
