import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseSubagentControlSnapshot,
  SUBAGENT_CONTROL_ARG_PREFIX,
  SUBAGENT_CONTROL_COMMAND,
  SUBAGENT_CONTROL_STATUS_KEY,
  subagentControlMessage,
  SUBAGENT_STEER_CHAR_LIMIT,
  type SubagentControlSnapshot,
} from "./subagent-control";
import { writeSubagentControlExtension } from "./subagent-control-extension";
import { typecheckGeneratedExtension } from "./generated-extension-test-utils";

const dirs: string[] = [];

function tempLineage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-subagent-control-"));
  dirs.push(dir);
  return dir;
}

interface FakeSessionRef {
  promptCalls: { text: string; options: unknown }[];
  abortCalls: unknown[];
  promptError: Error | null;
  prompt: (text: string, options?: { streamingBehavior?: string }) => Promise<void>;
  abort: (options?: { reason?: string }) => Promise<void>;
}

function sessionRef(): FakeSessionRef {
  const ref: FakeSessionRef = {
    promptCalls: [],
    abortCalls: [],
    promptError: null,
    prompt: (text: string, options?: { streamingBehavior?: string }): Promise<void> => {
      ref.promptCalls.push({ text, options });
      return ref.promptError !== null
        ? Promise.reject(ref.promptError)
        : Promise.resolve();
    },
    abort: (options?: { reason?: string }): Promise<void> => {
      ref.abortCalls.push(options);
      return Promise.resolve();
    },
  };
  return ref;
}

interface FakeAgent {
  id: string;
  kind: string;
  status: string;
  /** The live session, or null while parked/aborted. */
  session: FakeSessionRef | null;
}

interface FakeRegistry {
  agents: Map<string, FakeAgent>;
  mainAgentId: string;
  ensureLiveCalls: string[];
  releaseCalls: { id: string; tombstone: unknown }[];
  /** When set, ensureLive rejects with it — omp's revive-failure posture. */
  ensureLiveError: string | null;
  releaseError: string | null;
}

interface Harness {
  registry: FakeRegistry;
  published: SubagentControlSnapshot[];
  invoke: (args: string) => Promise<void>;
  arm: () => Promise<void>;
  latest: () => SubagentControlSnapshot;
}

function agent(id: string, kind: string, status: string, session: FakeSessionRef | null): FakeAgent {
  return { id, kind, status, session };
}

/** Builds the bridge under a fake pi seam; `resolveModules:false` simulates a missing shim. */
function executableExtension(resolveModules = true): Harness {
  const registry: FakeRegistry = {
    agents: new Map(),
    mainAgentId: "main-agent",
    ensureLiveCalls: [],
    releaseCalls: [],
    ensureLiveError: null,
    releaseError: null,
  };
  const registryGlobal = {
    get: (id: string): unknown => {
      const found = registry.agents.get(id);
      if (found === undefined) return null;
      return { id: found.id, kind: found.kind, status: found.status, session: found.session };
    },
  };
  class AgentRegistry {
    static global(): unknown {
      return registryGlobal;
    }
  }
  const lifecycleGlobal = {
    ensureLive: async (id: string): Promise<unknown> => {
      registry.ensureLiveCalls.push(id);
      if (registry.ensureLiveError !== null) throw new Error(registry.ensureLiveError);
      const found = registry.agents.get(id);
      return found?.session ?? null;
    },
    release: async (id: string, _ref: unknown, options: { tombstone: boolean }): Promise<void> => {
      registry.releaseCalls.push({ id, tombstone: options?.tombstone });
      if (registry.releaseError !== null) throw new Error(registry.releaseError);
      const found = registry.agents.get(id);
      if (found !== undefined) found.status = "aborted";
    },
  };
  class AgentLifecycleManager {
    static global(): unknown {
      return lifecycleGlobal;
    }
  }

  const shimRequire = (specifier: string): unknown => {
    if (!resolveModules) {
      throw new Error("Cannot find package '@oh-my-pi/pi-coding-agent'");
    }
    if (specifier === "@oh-my-pi/pi-coding-agent/registry/agent-registry") {
      return { AgentRegistry, MAIN_AGENT_ID: registry.mainAgentId };
    }
    if (specifier === "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle") {
      return { AgentLifecycleManager };
    }
    throw new Error("generated bridge required an unowned module: " + specifier);
  };

  class FakeAgentSession {
    sessionManager = { getSessionId: (): string => "root-1" };
    prompt(): void {}
  }

  const source = fs.readFileSync(writeSubagentControlExtension(tempLineage()), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loaded = { exports: {} as { default?: (api: unknown) => void } };
  Function("module", "exports", "require", output)(loaded, loaded.exports, shimRequire);
  const factory = loaded.exports.default;
  if (factory === undefined) throw new Error("generated extension has no default factory");

  let handler:
    | ((args: string, ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } }) => Promise<void>)
    | undefined;
  const published: SubagentControlSnapshot[] = [];
  factory({
    pi: { AgentSession: FakeAgentSession },
    registerCommand: (name: string, options: { handler: typeof handler }): void => {
      expect(name).toBe(SUBAGENT_CONTROL_COMMAND);
      handler = options.handler;
    },
  });
  const invoke = async (args: string): Promise<void> => {
    if (handler === undefined) throw new Error("generated extension did not register its command");
    await handler(args, {
      ui: {
        setStatus: (key, text): void => {
          expect(key).toBe(SUBAGENT_CONTROL_STATUS_KEY);
          const snapshot = parseSubagentControlSnapshot(text);
          if (snapshot === null)
            throw new Error("published a snapshot the shared wire parser rejects");
          published.push(snapshot);
        },
      },
    });
  };
  return {
    registry,
    published,
    invoke,
    arm: async (): Promise<void> => {
      // The literal imports settle a few microtasks after the factory runs.
      for (let i = 0; i < 6; i++) await Promise.resolve();
      await invoke("");
    },
    latest: (): SubagentControlSnapshot => {
      const value = published.at(-1);
      if (value === undefined) throw new Error("generated extension published no snapshot");
      return value;
    },
  };
}

function verbArgs(request: {
  requestId: string;
  agentId: string;
  action: "steer" | "kill" | "revive";
  text?: string;
}): string {
  // omp hands the handler everything after the command name: "tool {json}".
  return subagentControlMessage(request).slice(1 + SUBAGENT_CONTROL_COMMAND.length + 1);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("generated subagent-control extension", () => {
  it("typechecks as written and interpolates the wire constants", () => {
    const file = writeSubagentControlExtension(tempLineage());
    typecheckGeneratedExtension(file);
    const source = fs.readFileSync(file, "utf8");
    expect(source).toContain(JSON.stringify(SUBAGENT_CONTROL_STATUS_KEY));
    expect(source).toContain(JSON.stringify(SUBAGENT_CONTROL_COMMAND));
    expect(source).toContain(String(SUBAGENT_STEER_CHAR_LIMIT));
    expect(file.endsWith("omp-ui-subagent-control.ts")).toBe(true);
  });

  it("arms: publishes an available snapshot with its process identity", async () => {
    const h = executableExtension();
    await h.arm();
    const snapshot = h.latest();
    expect(snapshot.available).toBe(true);
    expect(snapshot.reason).toBeUndefined();
    expect(snapshot.processKey.startsWith("omp-ui-")).toBe(true);
    expect(snapshot.results).toEqual([]);
  });

  it("steers: ensureLive then prompt(steer), publishing the correlated result", async () => {
    const h = executableExtension();
    const session = sessionRef();
    h.registry.agents.set("a-1", agent("a-1", "sub", "running", session));
    await h.arm();
    const before = h.latest().revision;
    await h.invoke(verbArgs({ requestId: "r-1", agentId: "a-1", action: "steer", text: "try again" }));
    expect(h.registry.ensureLiveCalls).toEqual(["a-1"]);
    expect(session.promptCalls).toEqual([{ text: "try again", options: { streamingBehavior: "steer" } }]);
    const snapshot = h.latest();
    expect(snapshot.revision).toBeGreaterThan(before);
    expect(snapshot.results.at(-1)).toMatchObject({
      requestId: "r-1",
      agentId: "a-1",
      action: "steer",
      ok: true,
    });
  });

  it("kills: abort first, then the tombstoned release (hub's order)", async () => {
    const h = executableExtension();
    const session = sessionRef();
    h.registry.agents.set("a-1", agent("a-1", "sub", "running", session));
    await h.arm();
    await h.invoke(verbArgs({ requestId: "r-2", agentId: "a-1", action: "kill" }));
    expect(session.abortCalls).toEqual([{ reason: "Interrupted by user" }]);
    expect(h.registry.releaseCalls).toEqual([{ id: "a-1", tombstone: true }]);
    expect(h.latest().results.at(-1)).toMatchObject({ requestId: "r-2", ok: true });
  });

  it("kills a parked agent without aborting, tombstoned release only", async () => {
    const h = executableExtension();
    h.registry.agents.set("a-2", agent("a-2", "sub", "parked", null));
    await h.arm();
    await h.invoke(verbArgs({ requestId: "r-3", agentId: "a-2", action: "kill" }));
    expect(h.registry.ensureLiveCalls).toEqual([]);
    expect(h.registry.releaseCalls).toEqual([{ id: "a-2", tombstone: true }]);
    expect(h.latest().results.at(-1)?.ok).toBe(true);
  });

  it("revives a parked agent through ensureLive", async () => {
    const h = executableExtension();
    h.registry.agents.set("a-3", agent("a-3", "sub", "parked", null));
    await h.arm();
    await h.invoke(verbArgs({ requestId: "r-4", agentId: "a-3", action: "revive" }));
    expect(h.registry.ensureLiveCalls).toEqual(["a-3"]);
    expect(h.latest().results.at(-1)).toMatchObject({ requestId: "r-4", ok: true });
  });

  it("refuses a revive of a non-parked agent with omp's own sentence", async () => {
    const h = executableExtension();
    h.registry.agents.set("a-4", agent("a-4", "sub", "idle", sessionRef()));
    await h.arm();
    await h.invoke(verbArgs({ requestId: "r-5", agentId: "a-4", action: "revive" }));
    const result = h.latest().results.at(-1);
    expect(result).toMatchObject({ requestId: "r-5", ok: false });
    expect(result?.error).toContain('Agent "a-4" is idle');
    expect(result?.error).toContain("only parked agents can be revived");
    expect(h.registry.ensureLiveCalls).toEqual([]);
  });

  it("refuses steer and revive on an aborted agent, letting kill through", async () => {
    const h = executableExtension();
    h.registry.agents.set("a-5", agent("a-5", "sub", "aborted", null));
    await h.arm();
    await h.invoke(verbArgs({ requestId: "r-6", agentId: "a-5", action: "steer", text: "hello" }));
    const steer = h.latest().results.at(-1);
    expect(steer?.error).toContain("was hard-aborted and cannot be messaged or revived");
    expect(steer?.error).toContain("history://a-5");
    await h.invoke(verbArgs({ requestId: "r-7", agentId: "a-5", action: "revive" }));
    expect(h.latest().results.at(-1)?.error).toContain("hard-aborted");
    await h.invoke(verbArgs({ requestId: "r-8", agentId: "a-5", action: "kill" }));
    expect(h.latest().results.at(-1)).toMatchObject({ requestId: "r-8", ok: true });
  });

  it("refuses advisor transcripts with hub's own strings", async () => {
    const h = executableExtension();
    h.registry.agents.set("adv", agent("adv", "advisor", "idle", sessionRef()));
    await h.arm();
    await h.invoke(verbArgs({ requestId: "r-9", agentId: "adv", action: "kill" }));
    expect(h.latest().results.at(-1)?.error).toContain('"adv" is a read-only advisor transcript');
    expect(h.latest().results.at(-1)?.error).toContain("cannot be killed");
    await h.invoke(verbArgs({ requestId: "r-10", agentId: "adv", action: "revive" }));
    expect(h.latest().results.at(-1)?.error).toContain("nothing to revive");
    await h.invoke(verbArgs({ requestId: "r-11", agentId: "adv", action: "steer", text: "x" }));
    expect(h.latest().results.at(-1)?.error).toContain(
      "is a read-only advisor transcript and cannot be messaged",
    );
    expect(h.registry.releaseCalls).toEqual([]);
  });

  it("refuses the main agent by id", async () => {
    const h = executableExtension();
    h.registry.agents.set("main-agent", agent("main-agent", "main", "idle", sessionRef()));
    await h.arm();
    await h.invoke(verbArgs({ requestId: "r-12", agentId: "main-agent", action: "kill" }));
    expect(h.latest().results.at(-1)?.error).toContain("is not a subagent");
  });

  it("reports an unknown id with omp's Unknown agent sentence", async () => {
    const h = executableExtension();
    await h.arm();
    await h.invoke(verbArgs({ requestId: "r-13", agentId: "ghost", action: "kill" }));
    const result = h.latest().results.at(-1);
    expect(result?.error).toContain('Unknown agent "ghost"');
    expect(result?.error).toContain("history://ghost");
  });

  it("refuses blank and over-limit steer text with correlated results", async () => {
    const h = executableExtension();
    h.registry.agents.set("a-6", agent("a-6", "sub", "running", sessionRef()));
    await h.arm();
    await h.invoke(verbArgs({ requestId: "r-14", agentId: "a-6", action: "steer", text: "   " }));
    expect(h.latest().results.at(-1)).toMatchObject({ requestId: "r-14", ok: false });
    await h.invoke(
      verbArgs({
        requestId: "r-15",
        agentId: "a-6",
        action: "steer",
        text: "x".repeat(SUBAGENT_STEER_CHAR_LIMIT + 1),
      }),
    );
    const tooLong = h.latest().results.at(-1);
    expect(tooLong).toMatchObject({ requestId: "r-15", ok: false });
    expect(tooLong?.error).toContain(String(SUBAGENT_STEER_CHAR_LIMIT));
    expect(h.registry.ensureLiveCalls).toEqual([]);
  });

  it("throws on unknown args and malformed envelopes — never a fall-through", async () => {
    const h = executableExtension();
    await h.arm();
    await expect(h.invoke("nonsense")).rejects.toThrow(/unsupported command args/);
    await expect(h.invoke("tool not-json")).rejects.toThrow(/malformed control request/);
    await expect(
      h.invoke('tool {"v":1,"request":{"requestId":"r","agentId":"a","action":"nap"}}'),
    ).rejects.toThrow(/malformed control request/);
    await expect(
      h.invoke('tool {"v":1,"request":{"requestId":"r","agentId":"","action":"kill"}}'),
    ).rejects.toThrow(/malformed control request/);
    await expect(
      h.invoke('tool {"v":2,"request":{"requestId":"r","agentId":"a","action":"kill"}}'),
    ).rejects.toThrow(/malformed control request/);
    await expect(
      h.invoke('tool {"v":1,"extra":true,"request":{"requestId":"r","agentId":"a","action":"kill"}}'),
    ).rejects.toThrow(/malformed control request/);
  });

  it("refuses a second in-flight verb on the same agent", async () => {
    const h = executableExtension();
    let gateOpen = (): void => {};
    const gate = new Promise<void>((resolve) => {
      gateOpen = resolve;
    });
    const gated = sessionRef();
    gated.prompt = (): Promise<void> => gate;
    h.registry.agents.set("a-7", agent("a-7", "sub", "running", gated));
    await h.arm();
    const first = h.invoke(verbArgs({ requestId: "r-16", agentId: "a-7", action: "steer", text: "go" }));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    await h.invoke(verbArgs({ requestId: "r-17", agentId: "a-7", action: "kill" }));
    const busy = h.latest().results.at(-1);
    expect(busy).toMatchObject({ requestId: "r-17", ok: false });
    expect(busy?.error).toContain("already running");
    gateOpen();
    await first;
    // The held steer settles ok afterwards; the refused kill stays in the ring.
    expect(h.latest().results.at(-1)).toMatchObject({ requestId: "r-16", ok: true });
  });

  it("degrades to missing-api when the shim cannot resolve the managers", async () => {
    const h = executableExtension(false);
    await h.arm();
    expect(h.latest().available).toBe(false);
    expect(h.latest().reason).toBe("missing-api");
    await h.invoke(verbArgs({ requestId: "r-18", agentId: "a", action: "kill" }));
    expect(h.latest().results.at(-1)).toMatchObject({ requestId: "r-18", ok: false });
  });

  it("surfaces an omp error verbatim and keeps publishing", async () => {
    const h = executableExtension();
    h.registry.agents.set("a-8", agent("a-8", "sub", "parked", null));
    h.registry.ensureLiveError =
      'Cannot revive subagent "a-8": session file "/x.jsonl" has no persisted session contract.';
    await h.arm();
    await h.invoke(verbArgs({ requestId: "r-19", agentId: "a-8", action: "revive" }));
    const result = h.latest().results.at(-1);
    expect(result?.ok).toBe(false);
    expect(result?.error).toContain("no persisted session contract");
    await h.invoke(verbArgs({ requestId: "r-20", agentId: "a-8", action: "kill" }));
    expect(h.latest().results.at(-1)?.ok).toBe(true);
  });

  it("ring-caps results at 16 newest-last with monotonic revisions", async () => {
    const h = executableExtension();
    h.registry.agents.set("a-9", agent("a-9", "sub", "parked", null));
    await h.arm();
    const revisions: number[] = [];
    for (let i = 0; i < 20; i++) {
      await h.invoke(verbArgs({ requestId: "r-" + i, agentId: "a-9", action: "kill" }));
      revisions.push(h.latest().revision);
    }
    const snapshot = h.latest();
    expect(snapshot.results.length).toBe(16);
    expect(snapshot.results.map((r) => r.requestId)).toEqual(
      Array.from({ length: 16 }, (_, i) => "r-" + (i + 4)),
    );
    for (let i = 1; i < revisions.length; i++) expect(revisions[i]).toBeGreaterThan(revisions[i - 1]);
  });

  it("binds the root session on first prompt without breaking it", async () => {
    const h = executableExtension();
    await h.arm();
    await h.invoke(verbArgs({ requestId: "r-21", agentId: "ghost", action: "revive" }));
    expect(h.latest().results.at(-1)?.ok).toBe(false);
    expect(SUBAGENT_CONTROL_ARG_PREFIX.startsWith(SUBAGENT_CONTROL_COMMAND)).toBe(true);
  });
});
