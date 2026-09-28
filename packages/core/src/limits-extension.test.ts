import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS_COMMAND, LIMITS_STATUS_KEY } from "./limits";
import { limitsExtensionPath, writeLimitsExtension } from "./limits-extension";
import { typecheckGeneratedExtension } from "./generated-extension-test-utils";

const dirs: string[] = [];

function tempLineage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-limits-"));
  dirs.push(dir);
  return dir;
}

interface PublishedLimits {
  available: boolean;
  unavailable?: string;
  provider?: string | null;
  windows?: unknown[];
  bankedResets?: number;
  fetchedAtMs?: number;
}

function executableExtension(session: Record<string, unknown>) {
  class FakeAgentSession {
    promptCalls = 0;
    async prompt(): Promise<void> {
      this.promptCalls += 1;
    }
  }
  Object.assign(FakeAgentSession.prototype, session);

  const file = writeLimitsExtension(tempLineage());
  const source = fs.readFileSync(file, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loaded = { exports: {} as { default?: (api: unknown) => void } };
  Function("module", "exports", output)(loaded, loaded.exports);
  const factory = loaded.exports.default;
  if (!factory) throw new Error("generated extension has no default factory");

  let handler:
    | ((args: string, ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } }) => Promise<void>)
    | undefined;
  const published: PublishedLimits[] = [];
  factory({
    pi: { AgentSession: FakeAgentSession },
    registerCommand: (name: string, options: { handler: typeof handler }): void => {
      expect(name).toBe(LIMITS_COMMAND);
      handler = options.handler;
    },
  });

  const callHandler = async (): Promise<void> => {
    if (!handler) throw new Error("generated extension did not register its command");
    await handler("", {
      ui: {
        setStatus: (key, text): void => {
          expect(key).toBe(LIMITS_STATUS_KEY);
          if (text) published.push(JSON.parse(text) as PublishedLimits);
        },
      },
    });
  };
  return {
    FakeAgentSession,
    published,
    arm: (): Promise<void> => callHandler(),
    latest: (): PublishedLimits => {
      const value = published.at(-1);
      if (!value) throw new Error("generated extension published no snapshot");
      return value;
    },
    // The prompt wrapper fetches fire-and-forget; drain the microtask chain
    // until its publish lands (fake timers never schedule a macrotask here).
    flush: async (): Promise<void> => {
      for (let i = 0; i < 12; i += 1) await Promise.resolve();
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const REPORTS = [
  {
    provider: "anthropic",
    limits: [
      {
        label: "5 hour",
        amount: { usedFraction: 0.325 },
        window: { resetsAt: 1_761_700_000_000 },
        scope: { windowId: "anthropic:5h" },
      },
      // Neither a percent nor a reset time: omp's own rule drops it.
      { label: "empty", scope: { windowId: "anthropic:none" } },
    ],
    resetCredits: { bankedCount: 2 },
  },
  { provider: "openai", limits: [{ label: "week", bucket: { utilization: 41 } }] },
];

describe("writeLimitsExtension", () => {
  it("writes the extension into the lineage dir, creating it when absent", () => {
    const dir = path.join(tempLineage(), "fresh");
    const file = writeLimitsExtension(dir);
    expect(file).toBe(limitsExtensionPath(dir));
    expect(fs.existsSync(file)).toBe(true);
  });

  it("emits the wire constants both sides agree on", () => {
    const source = fs.readFileSync(writeLimitsExtension(tempLineage()), "utf8");
    expect(source).toContain(JSON.stringify(LIMITS_STATUS_KEY));
    expect(source).toContain(JSON.stringify(LIMITS_COMMAND));
  });

  it("is rewritten on every spawn, so a stale build cannot outvote the contract", () => {
    const dir = tempLineage();
    fs.writeFileSync(limitsExtensionPath(dir), "// stale build\n");
    expect(fs.readFileSync(writeLimitsExtension(dir), "utf8")).not.toContain("stale");
  });

  it("writes a strict TypeScript extension omp can load", () => {
    typecheckGeneratedExtension(writeLimitsExtension(tempLineage()));
  });
});

describe("generated limits extension", () => {
  it("publishes the current provider's windows through fetchUsageReports", async () => {
    let fetches = 0;
    const harness = executableExtension({
      model: { provider: "anthropic" },
      fetchUsageReports: async () => {
        fetches += 1;
        return REPORTS;
      },
    });
    const session = new harness.FakeAgentSession();
    await harness.arm();
    await session.prompt();
    await harness.flush();
    expect(fetches).toBe(1);
    expect(harness.latest()).toEqual({
      available: true,
      provider: "anthropic",
      windows: [
        { id: "anthropic:5h", label: "5 hour", percent: 32.5, resetsAtMs: 1_761_700_000_000 },
      ],
      bankedResets: 2,
      fetchedAtMs: expect.any(Number),
    });
  });

  it("publishes an empty snapshot when the provider has no report", async () => {
    const harness = executableExtension({
      model: { provider: "mistral" },
      fetchUsageReports: async () => REPORTS,
    });
    const session = new harness.FakeAgentSession();
    await session.prompt();
    await harness.flush();
    await harness.arm();
    expect(harness.latest()).toMatchObject({
      available: true,
      provider: "mistral",
      windows: [],
      bankedResets: 0,
    });
  });

  it("names the wait for a live session when the command lands before any prompt", async () => {
    const harness = executableExtension({ model: { provider: "anthropic" } });
    // The arm's pull runs before any prompt captured a root session; its
    // publish must be the honest "not yet", never a fabricated snapshot.
    await harness.arm();
    expect(harness.published.at(-1)).toEqual({
      available: false,
      unavailable: "no active omp session",
    });
  });

  it("publishes an empty snapshot when the model is unreadable", async () => {
    const harness = executableExtension({
      fetchUsageReports: async () => REPORTS,
    });
    const session = new harness.FakeAgentSession();
    await harness.arm();
    await session.prompt();
    await harness.flush();
    expect(harness.latest()).toMatchObject({ available: true, provider: null, windows: [] });
  });

  it("degrades to a published unavailable reason when fetchUsageReports is absent", async () => {
    const harness = executableExtension({ model: { provider: "anthropic" } });
    const session = new harness.FakeAgentSession();
    await harness.arm();
    await session.prompt();
    await harness.flush();
    expect(harness.latest()).toEqual({
      available: false,
      unavailable: "this omp build does not report provider usage",
    });
  });

  it("publishes the failure reason instead of throwing into the agent", async () => {
    const harness = executableExtension({
      model: { provider: "anthropic" },
      fetchUsageReports: () => {
        throw new Error("auth expired");
      },
    });
    const session = new harness.FakeAgentSession();
    await harness.arm();
    await expect(session.prompt()).resolves.toBeUndefined();
    expect(harness.latest()).toMatchObject({ available: false });
    expect(String(harness.latest().unavailable)).toContain("auth expired");
  });

  it("re-probes at a turn end only past the five-minute cooldown", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    let fetches = 0;
    const harness = executableExtension({
      model: { provider: "anthropic" },
      fetchUsageReports: async () => {
        fetches += 1;
        return REPORTS;
      },
    });
    const session = new harness.FakeAgentSession();
    // The first prompt binds the root before the arm fetches; the wrapper
    // cannot publish while its ui channel is unbound.
    await session.prompt();
    await harness.flush();
    await harness.arm();
    expect(fetches).toBe(1);
    await session.prompt();
    await harness.flush();
    expect(fetches).toBe(1);
    vi.setSystemTime(new Date("2026-10-01T12:04:59Z"));
    await session.prompt();
    await harness.flush();
    expect(fetches).toBe(1);
    vi.setSystemTime(new Date("2026-10-01T12:05:01Z"));
    await session.prompt();
    await harness.flush();
    expect(fetches).toBe(2);
  });

  it("selects the freshest report when one provider stores several accounts", async () => {
    const harness = executableExtension({
      model: { provider: "anthropic" },
      fetchUsageReports: async () => [
        {
          provider: "anthropic",
          fetchedAtMs: 1_000,
          limits: [{ label: "5 hour", amount: { usedFraction: 0.9 } }],
        },
        {
          provider: "anthropic",
          fetchedAtMs: 2_000,
          limits: [{ label: "5 hour", amount: { usedFraction: 0.1 } }],
        },
      ],
    });
    const session = new harness.FakeAgentSession();
    await harness.arm();
    await session.prompt();
    await harness.flush();
    expect(harness.latest().windows).toEqual([
      { id: "5 hour", label: "5 hour", percent: 10, resetsAtMs: null },
    ]);
  });
});
