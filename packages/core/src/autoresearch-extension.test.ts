import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  AUTORESEARCH_COMMAND,
  AUTORESEARCH_GOAL_CHAR_LIMIT,
  AUTORESEARCH_STATUS_KEY,
  parseAutoresearchSnapshot,
  type AutoresearchSnapshot,
} from "./autoresearch";
import { autoresearchExtensionPath, writeAutoresearchExtension } from "./autoresearch-extension";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// ------------------------------------------------------------------ fixtures

interface ControlEntry {
  type: string;
  customType: string;
  data?: unknown;
}

interface Session {
  id: string;
  /** The branch `getBranch()` returns; tests mutate it like omp appends to it. */
  entries: ControlEntry[];
  prompts: string[];
  /** Runs inside `prompt`, the way omp's command handler appends a control entry. */
  onPrompt: ((text: string) => void) | null;
  disposeCalls: number;
  sessionManager: Record<string, unknown>;
  prompt(text: string): Promise<boolean>;
  fire(event: { type: string; [key: string]: unknown }): void;
  changeSession(): void;
}

interface Harness {
  AgentSession: new (id: string, options?: { without?: string[]; throwing?: string[] }) => Session;
  arm: (args?: string) => Promise<void>;
  snapshot: () => AutoresearchSnapshot;
  statuses: AutoresearchSnapshot[];
}

function control(mode: string, goal?: string): ControlEntry {
  return {
    type: "custom",
    customType: "autoresearch-control",
    data: { mode, ...(goal === undefined ? {} : { goal }) },
  };
}

/** Transpiles the generated file and instantiates one factory per fake class. */
function harness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-autoresearch-"));
  dirs.push(dir);
  const file = writeAutoresearchExtension(dir);
  expect(file).toBe(autoresearchExtensionPath(dir));
  const source = fs.readFileSync(file, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const loaded = { exports: {} as { default?: (api: unknown) => void } };
  Function("module", "exports", outputText)(loaded, loaded.exports);
  const factory = loaded.exports.default;
  if (!factory) throw new Error("generated autoresearch extension has no default factory");

  const statuses: AutoresearchSnapshot[] = [];
  let handler: ((args: string, ctx: Record<string, unknown>) => Promise<void>) | undefined;

  class FakeAgentSession {
    id: string;
    entries: ControlEntry[] = [];
    prompts: string[] = [];
    onPrompt: ((text: string) => void) | null = null;
    disposeCalls = 0;
    listeners: ((event: { type: string }) => void)[] = [];
    sessionChangeListeners: (() => void)[] = [];
    sessionManager: Record<string, unknown>;

    constructor(id: string, options: { without?: string[]; throwing?: string[] } = {}) {
      this.id = id;
      this.sessionManager = {
        getSessionId: (): string => this.id,
        getBranch: (): ControlEntry[] => this.entries,
      };
      for (const name of options.without ?? []) delete this.sessionManager[name];
      for (const name of options.throwing ?? []) {
        this.sessionManager[name] = () => {
          throw new Error(name + " exploded");
        };
      }
    }

    prompt(text: string): Promise<boolean> {
      this.prompts.push(text);
      this.onPrompt?.(text);
      return Promise.resolve(true);
    }

    subscribe(listener: (event: { type: string }) => void): () => void {
      this.listeners.push(listener);
      return () => {
        this.listeners = this.listeners.filter((l) => l !== listener);
      };
    }

    registerSessionChangeCallback(listener: () => void): () => void {
      this.sessionChangeListeners.push(listener);
      return () => {
        this.sessionChangeListeners = this.sessionChangeListeners.filter((l) => l !== listener);
      };
    }

    dispose(): void {
      this.disposeCalls += 1;
    }

    fire(event: { type: string; [key: string]: unknown }): void {
      for (const listener of [...this.listeners]) listener(event);
    }

    changeSession(): void {
      for (const listener of [...this.sessionChangeListeners]) listener();
    }
  }

  factory({
    pi: { AgentSession: FakeAgentSession },
    registerCommand: (name: string, options: { handler: typeof handler }): void => {
      expect(name).toBe(AUTORESEARCH_COMMAND);
      handler = options.handler;
    },
  });

  return {
    AgentSession: FakeAgentSession as unknown as Harness["AgentSession"],
    arm: async (args = ""): Promise<void> => {
      if (!handler) throw new Error("generated extension registered no command");
      await handler(args, {
        ui: {
          setStatus: (key: string, text: string | undefined): void => {
            expect(key).toBe(AUTORESEARCH_STATUS_KEY);
            const snapshot = parseAutoresearchSnapshot(text);
            if (snapshot === null) throw new Error("published a snapshot the shared wire parser rejects");
            statuses.push(snapshot);
          },
        },
      });
    },
    snapshot: (): AutoresearchSnapshot => {
      const value = statuses.at(-1);
      if (!value) throw new Error("the bridge published no snapshot");
      return value;
    },
    statuses,
  };
}

/** A root session that has prompted once (the arm) and armed the bridge. */
async function armed(): Promise<Harness & { session: Session }> {
  const h = harness();
  const session = new h.AgentSession("s1");
  await session.prompt("/" + AUTORESEARCH_COMMAND);
  await h.arm();
  return { ...h, session };
}

// --------------------------------------------------------------------- tests

describe("autoresearch extension", () => {
  it("arms to an available off snapshot with no goal when the branch has no control entries", async () => {
    const h = await armed();
    expect(h.statuses).toHaveLength(1);
    expect(h.snapshot()).toMatchObject({
      version: 1,
      sessionId: "s1",
      revision: 1,
      available: true,
      unavailable: null,
      mode: "off",
      goal: null,
      goalTruncated: false,
      lastTool: null,
    });
    expect(h.snapshot().processKey).not.toBe("");
  });

  it("rejects arm arguments", async () => {
    const h = harness();
    await expect(h.arm("anything")).rejects.toThrow("omp-ui-autoresearch: unsupported command args");
  });

  it("reduces the branch to the latest mode and goal", async () => {
    const h = await armed();
    h.session.entries.push(control("on"));
    h.session.fire({ type: "agent_end" });
    expect(h.snapshot()).toMatchObject({ mode: "on", goal: null });

    h.session.entries.push(control("on", "x"));
    h.session.fire({ type: "agent_end" });
    expect(h.snapshot()).toMatchObject({ mode: "on", goal: "x" });
  });

  it("keeps the goal across an off toggle and drops it on clear", async () => {
    const h = await armed();
    h.session.entries.push(control("on", "x"), control("off"));
    h.session.fire({ type: "agent_end" });
    expect(h.snapshot()).toMatchObject({ mode: "off", goal: "x" });

    h.session.entries.push(control("clear"));
    h.session.fire({ type: "agent_end" });
    expect(h.snapshot()).toMatchObject({ mode: "off", goal: null });
  });

  it("does not republish when nothing changed", async () => {
    const h = await armed();
    h.session.fire({ type: "agent_end" });
    h.session.fire({ type: "agent_end" });
    expect(h.statuses).toHaveLength(1);
  });

  it("records finished autoresearch tools and ignores every other tool", async () => {
    const h = await armed();
    h.session.fire({ type: "tool_execution_end", toolName: "read", isError: false });
    expect(h.statuses).toHaveLength(1);

    h.session.fire({ type: "tool_execution_end", toolName: "log_experiment", isError: true });
    expect(h.statuses).toHaveLength(2);
    expect(h.snapshot().revision).toBe(2);
    expect(h.snapshot().lastTool).toMatchObject({ name: "log_experiment", isError: true });
    expect(h.snapshot().lastTool?.at).toBeGreaterThan(0);
  });

  it("republishes after a root /autoresearch prompt settles, without a turn", async () => {
    const h = await armed();
    h.session.entries.push(control("on", "x"));
    h.session.fire({ type: "agent_end" });
    expect(h.snapshot().mode).toBe("on");

    h.session.onPrompt = (text) => {
      if (text === "/autoresearch off") h.session.entries.push(control("off"));
    };
    const pending = h.session.prompt("/autoresearch off");
    // omp handles the command inside prompt; the bridge reads back only after it resolves.
    expect(h.snapshot().mode).toBe("on");
    await expect(pending).resolves.toBe(true);
    expect(h.snapshot()).toMatchObject({ mode: "off", goal: "x" });
    expect(h.session.prompts).toEqual(["/" + AUTORESEARCH_COMMAND, "/autoresearch off"]);
  });

  it("leaves ordinary prompts alone", async () => {
    const h = await armed();
    h.session.entries.push(control("on"));
    await h.session.prompt("hello");
    expect(h.statuses).toHaveLength(1);
  });

  it("publishes unavailable when getBranch is missing or throws", async () => {
    const missing = harness();
    const s1 = new missing.AgentSession("s1", { without: ["getBranch"] });
    await s1.prompt("/" + AUTORESEARCH_COMMAND);
    await missing.arm();
    expect(missing.snapshot()).toMatchObject({
      available: false,
      unavailable: "sessionManager.getBranch is missing",
      mode: "off",
      goal: null,
    });

    const throwing = harness();
    const s2 = new throwing.AgentSession("s2", { throwing: ["getBranch"] });
    await s2.prompt("/" + AUTORESEARCH_COMMAND);
    await throwing.arm();
    expect(throwing.snapshot().available).toBe(false);
    expect(throwing.snapshot().unavailable).toContain("getBranch exploded");
  });

  it("reports honestly when armed before any session prompted", async () => {
    const h = harness();
    await h.arm();
    expect(h.snapshot()).toMatchObject({
      sessionId: "",
      available: false,
      unavailable: "no omp session has prompted yet",
    });
  });

  it("binds the first prompting session as root and never rebinds to a subagent", async () => {
    const h = await armed();
    const child = new h.AgentSession("s2");
    child.entries.push(control("on", "child goal"));
    await child.prompt("/autoresearch on");
    expect(h.statuses).toHaveLength(1);

    h.session.fire({ type: "agent_end" });
    child.fire({ type: "tool_execution_end", toolName: "log_experiment" });
    expect(h.statuses).toHaveLength(1);
    expect(h.snapshot()).toMatchObject({ sessionId: "s1", mode: "off", goal: null });
  });

  it("truncates an oversized goal and says so", async () => {
    const h = await armed();
    const goal = "g".repeat(AUTORESEARCH_GOAL_CHAR_LIMIT + 10);
    h.session.entries.push(control("on", goal));
    h.session.fire({ type: "agent_end" });
    expect(h.snapshot()).toMatchObject({
      mode: "on",
      goal: goal.slice(0, AUTORESEARCH_GOAL_CHAR_LIMIT),
      goalTruncated: true,
    });
  });

  it("forgets tool activity and rereads the branch when the session changes", async () => {
    const h = await armed();
    h.session.entries.push(control("on", "x"));
    h.session.fire({ type: "tool_execution_end", toolName: "run_experiment" });
    expect(h.snapshot().lastTool?.name).toBe("run_experiment");

    h.session.entries.splice(0);
    h.session.changeSession();
    expect(h.snapshot()).toMatchObject({ mode: "off", goal: null, lastTool: null });
  });

  it("stops listening once the root session is disposed", async () => {
    const h = await armed();
    (h.session as unknown as { dispose: () => void }).dispose();
    expect(h.session.disposeCalls).toBe(1);
    h.session.entries.push(control("on"));
    h.session.fire({ type: "agent_end" });
    expect(h.statuses).toHaveLength(1);
  });
});
