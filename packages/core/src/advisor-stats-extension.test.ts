import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ADVISOR_STATS_COMMAND, ADVISOR_STATS_KEY } from "./advisor-stats";
import {
  advisorStatsExtensionPath,
  writeAdvisorStatsExtension,
} from "./advisor-stats-extension";

const dirs: string[] = [];

function tempLineage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-advstats-"));
  dirs.push(dir);
  return dir;
}
interface FakeStats {
  configured: boolean;
  active: boolean;
  model: { id: string };
  contextWindow: number;
  contextTokens: number;
  cost: number;
  tokens: { total: number };
}

interface PublishedStats {
  available: boolean;
  unavailable?: string;
  configured?: boolean;
  active?: boolean;
  model?: string | null;
  contextWindow?: number;
  contextTokens?: number;
  cost?: number;
  totalTokens?: number;
}

function executableExtension() {
  class FakeAgentSession {
    id: string;
    enabled: boolean;
    stats: FakeStats;
    messages: unknown[] = [];
    setAdvisorEnabledCalls: boolean[] = [];
    enabledAtPrompt: boolean[] = [];
    promptCalls = 0;
    sessionManager = { getSessionId: (): string => this.id };

    constructor(
      id: string,
      enabled: boolean,
      usage: Partial<Pick<FakeStats, "cost" | "contextTokens" | "contextWindow">> & {
        totalTokens?: number;
        model?: string;
      } = {},
    ) {
      this.id = id;
      this.enabled = enabled;
      this.stats = {
        configured: enabled,
        active: enabled,
        model: { id: usage.model ?? "root/advisor" },
        contextWindow: usage.contextWindow ?? 200_000,
        contextTokens: usage.contextTokens ?? 0,
        cost: usage.cost ?? 0,
        tokens: { total: usage.totalTokens ?? 0 },
      };
    }

    isAdvisorEnabled(): boolean {
      return this.enabled;
    }

    setAdvisorEnabled(enabled: boolean): void {
      this.setAdvisorEnabledCalls.push(enabled);
      this.enabled = enabled;
      this.stats.configured = enabled;
      this.stats.active = enabled;
    }

    getAdvisorStatusOverview(): { configured: boolean } {
      return { configured: this.stats.configured };
    }

    getAdvisorCost(): number {
      return this.stats.cost;
    }

    getAdvisorAgent(): { state: { messages: unknown[] } } {
      return { state: { messages: this.messages } };
    }

    getAdvisorStats(): FakeStats {
      return this.stats;
    }

    async prompt(): Promise<void> {
      this.promptCalls += 1;
      this.enabledAtPrompt.push(this.enabled);
    }
  }

  const source = fs.readFileSync(writeAdvisorStatsExtension(tempLineage()), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loaded = { exports: {} as { default?: (api: unknown) => void } };
  Function("module", "exports", output)(loaded, loaded.exports);
  const factory = loaded.exports.default;
  if (!factory) throw new Error("generated extension has no default factory");

  let handler: ((args: string, ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } }) => Promise<void>) | undefined;
  const published: PublishedStats[] = [];
  factory({
    pi: { AgentSession: FakeAgentSession },
    registerCommand: (
      name: string,
      options: { handler: typeof handler },
    ): void => {
      expect(name).toBe(ADVISOR_STATS_COMMAND);
      handler = options.handler;
    },
  });

  return {
    FakeAgentSession,
    published,
    arm: async (): Promise<void> => {
      if (!handler) throw new Error("generated extension did not register its command");
      await handler("", {
        ui: {
          setStatus: (key, text): void => {
            expect(key).toBe(ADVISOR_STATS_KEY);
            if (text) published.push(JSON.parse(text) as PublishedStats);
          },
        },
      });
      published.splice(0);
    },
    latest: (): PublishedStats => {
      const value = published.at(-1);
      if (!value) throw new Error("generated extension published no stats");
      return value;
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeAdvisorStatsExtension", () => {
  it("writes the extension into the lineage dir, creating it when absent", () => {
    const lineage = path.join(tempLineage(), "nested");
    const file = writeAdvisorStatsExtension(lineage);
    expect(file).toBe(advisorStatsExtensionPath(lineage));
    expect(fs.existsSync(file)).toBe(true);
  });

  it("emits the wire constants both sides agree on", () => {
    const source = fs.readFileSync(writeAdvisorStatsExtension(tempLineage()), "utf8");
    // A drifted constant would silently strand the renderer's routing.
    expect(source).toContain(JSON.stringify(ADVISOR_STATS_KEY));
    expect(source).toContain(JSON.stringify(ADVISOR_STATS_COMMAND));
  });

  it("is rewritten on every spawn, so a stale build cannot outvote the contract", () => {
    const lineage = tempLineage();
    const file = writeAdvisorStatsExtension(lineage);
    fs.writeFileSync(file, "// stale from an older omp-ui\n", "utf8");
    writeAdvisorStatsExtension(lineage);
    expect(fs.readFileSync(file, "utf8")).toContain(JSON.stringify(ADVISOR_STATS_KEY));
  });

  it("reads cost and context through omp's public getAdvisorStats surface", () => {
    const source = fs.readFileSync(writeAdvisorStatsExtension(tempLineage()), "utf8");
    // The whole point: cost + context live on AgentSession.getAdvisorStats.
    expect(source).toContain("getAdvisorStats");
    expect(source).toContain("contextWindow");
    expect(source).toContain("contextTokens");
    expect(source).toContain("cost");
  });

  it("degrades to a published unavailable reason when the surface is missing", () => {
    const source = fs.readFileSync(writeAdvisorStatsExtension(tempLineage()), "utf8");
    expect(source).toContain("available: false");
    expect(source).toContain("missing getAdvisorStats");
  });

  it("polls the cheap cost sum so async advisor reviews still reach the HUD", () => {
    const source = fs.readFileSync(writeAdvisorStatsExtension(tempLineage()), "utf8");
    // omp folds a review's cost in AFTER prompt() resolves, so without this
    // poll the readout permanently trails a review — stuck at $0 until the
    // next turn happens to publish.
    expect(source).toContain("getAdvisorCost");
    expect(source).toContain("setInterval");
    // The poll must never hold the omp process open on exit.
    expect(source).toContain("unref");
  });

  it("writes a syntactically valid TS extension omp can transpile", () => {
    const source = fs.readFileSync(writeAdvisorStatsExtension(tempLineage()), "utf8");
    // Substring checks can't catch a broken template; the file omp loads must
    // actually be valid TypeScript, or every session with an advisor would
    // reject the -e arg at startup.
    const { diagnostics } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    });
    const errors = (diagnostics ?? []).filter(
      (d) => d.category === ts.DiagnosticCategory.Error,
    );
    expect(errors.map((e) => String(e.messageText))).toEqual([]);
  });
});

describe("generated advisor stats extension", () => {
  it("disables an opted-in child before its prompt when the parent is off", async () => {
    const harness = executableExtension();
    await harness.arm();
    const root = new harness.FakeAgentSession("root", false);
    const child = new harness.FakeAgentSession("child", true);

    await root.prompt();
    await child.prompt();

    expect(child.setAdvisorEnabledCalls).toEqual([false]);
    expect(child.enabledAtPrompt).toEqual([false]);
    expect(harness.latest()).toMatchObject({
      available: true,
      configured: false,
      cost: 0,
      totalTokens: 0,
    });
  });

  it("leaves an opted-out child off when the parent is on", async () => {
    const harness = executableExtension();
    await harness.arm();
    const root = new harness.FakeAgentSession("root", true, { cost: 1.25, totalTokens: 100 });
    const child = new harness.FakeAgentSession("child", false, { cost: 0, totalTokens: 0 });

    await root.prompt();
    await child.prompt();

    expect(child.setAdvisorEnabledCalls).toEqual([]);
    expect(child.enabledAtPrompt).toEqual([false]);
    expect(harness.latest()).toMatchObject({ cost: 1.25, totalTokens: 100 });
  });

  it("adds opted-in child usage while retaining the root model and context", async () => {
    const harness = executableExtension();
    await harness.arm();
    const root = new harness.FakeAgentSession("root", true, {
      model: "root/model",
      contextWindow: 200_000,
      contextTokens: 12_000,
      cost: 1.5,
      totalTokens: 100,
    });
    const child = new harness.FakeAgentSession("child", true, {
      model: "child/model",
      contextWindow: 50_000,
      contextTokens: 40_000,
      cost: 0.75,
      totalTokens: 250,
    });

    await root.prompt();
    await child.prompt();

    expect(child.setAdvisorEnabledCalls).toEqual([]);
    expect(harness.latest()).toMatchObject({
      model: "root/model",
      contextWindow: 200_000,
      contextTokens: 12_000,
      cost: 2.25,
      totalTokens: 350,
    });
  });

  it("counts multiple and nested descendants once across repeated prompts", async () => {
    const harness = executableExtension();
    await harness.arm();
    const root = new harness.FakeAgentSession("root", true, { cost: 1, totalTokens: 10 });
    const child = new harness.FakeAgentSession("child", true, { cost: 2, totalTokens: 20 });
    const nested = new harness.FakeAgentSession("nested", true, { cost: 3, totalTokens: 30 });

    await root.prompt();
    await child.prompt();
    await nested.prompt();
    await child.prompt();

    expect(harness.latest()).toMatchObject({ cost: 6, totalTokens: 60 });
  });

  it("replaces a revived descendant object with the same session id", async () => {
    const harness = executableExtension();
    await harness.arm();
    const root = new harness.FakeAgentSession("root", true, { cost: 1, totalTokens: 10 });
    const original = new harness.FakeAgentSession("child", true, { cost: 2, totalTokens: 20 });
    const revived = new harness.FakeAgentSession("child", true, { cost: 4, totalTokens: 40 });

    await root.prompt();
    await original.prompt();
    await revived.prompt();

    expect(harness.latest()).toMatchObject({ cost: 5, totalTokens: 50 });
  });

  it("drops descendants when the root switches session id", async () => {
    const harness = executableExtension();
    await harness.arm();
    const root = new harness.FakeAgentSession("root-a", true, { cost: 1, totalTokens: 10 });
    const child = new harness.FakeAgentSession("child", true, { cost: 2, totalTokens: 20 });

    await root.prompt();
    await child.prompt();
    root.id = "root-b";
    root.stats.cost = 0.5;
    root.stats.tokens.total = 5;
    await root.prompt();

    expect(harness.latest()).toMatchObject({ cost: 0.5, totalTokens: 5 });
  });

  it("publishes child usage that lands after the prompt resolves", async () => {
    vi.useFakeTimers();
    const harness = executableExtension();
    await harness.arm();
    const root = new harness.FakeAgentSession("root", true, { cost: 1, totalTokens: 10 });
    const child = new harness.FakeAgentSession("child", true);

    await root.prompt();
    await child.prompt();
    const framesBeforeReview = harness.published.length;

    child.stats.cost = 0.8;
    child.stats.tokens.total = 80;
    child.messages.push({ role: "assistant" });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(harness.published).toHaveLength(framesBeforeReview + 1);
    expect(harness.latest()).toMatchObject({ cost: 1.8, totalTokens: 90 });
  });

  it("retains a completed descendant's last successful usage", async () => {
    const harness = executableExtension();
    await harness.arm();
    const root = new harness.FakeAgentSession("root", true, { cost: 1, totalTokens: 10 });
    const completed = new harness.FakeAgentSession("completed", true, { cost: 2, totalTokens: 20 });
    const live = new harness.FakeAgentSession("live", true, { cost: 3, totalTokens: 30 });

    await root.prompt();
    await completed.prompt();
    completed.getAdvisorStats = (): never => {
      throw new Error("disposed");
    };
    completed.getAdvisorCost = (): never => {
      throw new Error("disposed");
    };
    await live.prompt();

    expect(harness.latest()).toMatchObject({ cost: 6, totalTokens: 60 });
  });

  it.each(["missing", "throwing"] as const)(
    "publishes unavailable but still prompts when child control is %s",
    async (failure) => {
      const harness = executableExtension();
      await harness.arm();
      const root = new harness.FakeAgentSession("root", false);
      const child = new harness.FakeAgentSession("child", true);
      if (failure === "missing") {
        Object.assign(child, { setAdvisorEnabled: undefined });
      } else {
        child.setAdvisorEnabled = (): never => {
          throw new Error("unsupported");
        };
      }

      await root.prompt();
      await child.prompt();

      expect(child.promptCalls).toBe(1);
      expect(child.enabledAtPrompt).toEqual([true]);
      expect(harness.latest()).toMatchObject({
        available: false,
        unavailable: expect.stringContaining("setAdvisorEnabled"),
      });
    },
  );
});
