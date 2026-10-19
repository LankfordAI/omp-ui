import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcClient } from "@omp-ui/core";
import { Registry } from "@omp-ui/core";
import { ownedSessionRecord } from "./test/fixtures";
import { NO_GATE, type SpawnGate } from "./spawn-gate";
import type { SubagentSpawnConfig } from "./spawn-config";
import {
  WarmRpcPool,
  hashLineageTree,
  killWarmClient,
  sanitizeWarmTemplate,
  warmPlanKey,
  type WarmSlot,
} from "./warm-pool";

const NO_CONFIG: SubagentSpawnConfig = { inheritByDefault: false, roster: [] };

// ---------------------------------------------------------------------------
// Fake slot clients: pool semantics only touch armed/dead/kill/onDeath.
// A well-behaved child answers the first kill with its exit edge, which
// disarms killWarmClient's SIGKILL escalation.
// ---------------------------------------------------------------------------

interface FakeClient {
  readonly client: RpcClient;
  kills(): number;
  signals(): (NodeJS.Signals | undefined)[];
  setArmed(): void;
  setDead(): void;
}

function fakeClient(opts: { exitsOnKill?: boolean } = {}): FakeClient {
  const signals: (NodeJS.Signals | undefined)[] = [];
  const state = { armed: false, dead: false };
  const watchers: ((code: number | null) => void)[] = [];
  const client = {
    get armed() {
      return state.armed;
    },
    get dead() {
      return state.dead;
    },
    kill: (signal?: NodeJS.Signals) => {
      signals.push(signal);
      state.dead = true;
      if (opts.exitsOnKill !== false) for (const cb of watchers.splice(0)) cb(0);
    },
    onDeath: (cb: (code: number | null) => void) => {
      watchers.push(cb);
    },
  } as unknown as RpcClient;
  return {
    client,
    kills: () => signals.length,
    signals: () => signals.slice(),
    setArmed: () => {
      state.armed = true;
    },
    setDead: () => {
      state.dead = true;
    },
  };
}

function slot(planKey: string, client = fakeClient()): WarmSlot {
  return { client: client.client, planKey, dirName: "omp-ui--proj--uuid", dirHash: "hash" };
}

// ---------------------------------------------------------------------------
// Pool lifecycle
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

function makePool(opts: { enabled?: boolean; gate?: SpawnGate } = {}): WarmRpcPool {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "warm-pool-"));
  tmpDirs.push(root);
  return new WarmRpcPool({
    registry: Registry.load(path.join(root, "registry.json")),
    getSessionsRoot: () => root,
    gate: () => opts.gate ?? NO_GATE,
    subagentSpawnConfig: () => NO_CONFIG,
    enabled: () => opts.enabled ?? true,
  });
}

/** Park a fake slot by smuggling it through release() (the only public door). */
function park(pool: WarmRpcPool, s: WarmSlot): void {
  pool.release(s);
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("WarmRpcPool lifecycle", () => {
  it("reserve matches on planKey and transfers ownership", () => {
    const pool = makePool();
    const s = slot("plan-A");
    park(pool, s);
    expect(pool.reserve("plan-B")).toBeNull(); // mismatch leaves the slot parked
    expect(pool.reserve("plan-A")).toBe(s);
    expect(pool.reserve("plan-A")).toBeNull(); // popped once
  });

  it("release re-parks a never-armed live client", () => {
    const pool = makePool();
    const c = fakeClient();
    const s = slot("plan-A", c);
    park(pool, s);
    expect(pool.reserve("plan-A")).toBe(s);
    pool.release(s); // unused reservation comes back
    expect(pool.reserve("plan-A")).toBe(s);
    expect(c.kills()).toBe(0);
  });

  it("release kills an armed client instead of re-parking it", () => {
    const pool = makePool();
    const c = fakeClient();
    const s = slot("plan-A", c);
    park(pool, s);
    pool.reserve("plan-A");
    c.setArmed(); // adoption armed it — never parkable again
    pool.release(s);
    expect(c.kills()).toBe(1);
    expect(pool.reserve("plan-A")).toBeNull();
  });

  it("release kills a dead client instead of re-parking it", () => {
    const pool = makePool();
    const c = fakeClient();
    const s = slot("plan-A", c);
    park(pool, s);
    pool.reserve("plan-A");
    c.setDead(); // died during the adopting spawn
    pool.release(s);
    expect(c.kills()).toBe(1);
    expect(pool.reserve("plan-A")).toBeNull();
  });

  it("release kills when a slot already stands parked (no queue)", () => {
    const pool = makePool();
    const a = fakeClient();
    const b = fakeClient();
    park(pool, slot("plan-A", a));
    pool.release(slot("plan-A", b)); // second slot never queues
    expect(a.kills()).toBe(0);
    expect(b.kills()).toBe(1);
  });

  it("a model-pin gate makes the pool unavailable", () => {
    const gated: SpawnGate = { model: { model: "gpt" }, advisorModel: null };
    // The gate is parsed once per process, so a gated pool never builds or
    // reserves; release() deliberately does not re-check it.
    expect(makePool({ gate: gated }).available()).toBe(false);
  });

  it("an advisor-model gate also disables the pool", () => {
    const gated: SpawnGate = { model: null, advisorModel: { model: "gpt" } };
    expect(makePool({ gate: gated }).available()).toBe(false);
  });

  it("enabled=false parks the pool forever", () => {
    const pool = makePool({ enabled: false });
    expect(pool.available()).toBe(false);
    const c = fakeClient();
    pool.release(slot("plan-A", c));
    expect(c.kills()).toBe(1);
  });

  it("dispose kills the parked slot and disables further use", () => {
    const pool = makePool();
    const c = fakeClient();
    park(pool, slot("plan-A", c));
    pool.dispose();
    expect(c.kills()).toBe(1);
    expect(pool.available()).toBe(false);
    const late = fakeClient();
    pool.release(slot("plan-A", late)); // post-dispose release kills, never parks
    expect(late.kills()).toBe(1);
    expect(pool.reserve("plan-A")).toBeNull();
  });

  it("scheduleRefill short-circuits before booting when guards fail", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "warm-pool-"));
    tmpDirs.push(root);
    const plan = {
      planKey: "plan-A",
      ompPath: "/nonexistent/omp",
      template: sanitizeWarmTemplate(ownedSessionRecord({ projectCwd: path.join(root, "nope") })),
    };
    // Disabled pool: guard fires before #build; nothing may touch disk.
    const disabled = makePool({ enabled: false });
    disabled.scheduleRefill(plan);
    // Missing projectCwd: even an enabled pool drops the refill (and a real
    // build against /nonexistent/omp would fail loudly if it ever ran).
    const pool = makePool();
    pool.scheduleRefill(plan);
    park(pool, slot("other"));
    pool.scheduleRefill({ ...plan, template: { ...plan.template, projectCwd: root } });
    expect(pool.reserve("plan-A")).toBeNull(); // single-flight: dropped, not queued
    expect(fs.readdirSync(root)).toEqual([]); // no warm dirs minted anywhere
  });
});

// ---------------------------------------------------------------------------
// killWarmClient
// ---------------------------------------------------------------------------

describe("killWarmClient", () => {
  it("escalates to SIGKILL when the child never exits", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const c = fakeClient({ exitsOnKill: false });
      killWarmClient(c.client);
      expect(c.signals()).toEqual([undefined]); // SIGTERM first
      vi.advanceTimersByTime(5_000);
      expect(c.signals()).toEqual([undefined, "SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never escalates when the exit edge lands first", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const c = fakeClient(); // well-behaved: kill delivers the exit edge
      killWarmClient(c.client);
      vi.advanceTimersByTime(60_000);
      expect(c.signals()).toEqual([undefined]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// warmPlanKey
// ---------------------------------------------------------------------------

describe("warmPlanKey", () => {
  const base = {
    ompPath: "/bin/omp",
    projectCwd: "/repo",
    advisor: false,
    thinking: null as string | null,
    advisorModel: null as string | null,
    experimentsEnabled: false,
  };

  it("is stable for identical input", () => {
    expect(warmPlanKey(base)).toBe(warmPlanKey({ ...base }));
  });

  it("separates every boot-relevant field", () => {
    const keys = new Set([
      warmPlanKey(base),
      warmPlanKey({ ...base, ompPath: "/other/omp" }),
      warmPlanKey({ ...base, projectCwd: "/other" }),
      warmPlanKey({ ...base, advisor: true }),
      warmPlanKey({ ...base, thinking: "auto" }),
      warmPlanKey({ ...base, advisorModel: "gpt" }),
      warmPlanKey({ ...base, experimentsEnabled: true }),
    ]);
    expect(keys.size).toBe(7);
  });

  it("separates a pinned plan from an unpinned one (#892)", () => {
    expect(warmPlanKey({ ...base, advisorModel: "gpt" })).not.toBe(warmPlanKey(base));
    expect(warmPlanKey({ ...base, advisorModel: "gpt" })).toBe(
      warmPlanKey({ ...base, advisorModel: "gpt" }),
    );
  });
});

// ---------------------------------------------------------------------------
// hashLineageTree
// ---------------------------------------------------------------------------

describe("hashLineageTree", () => {
  function tree(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "warm-hash-"));
    tmpDirs.push(root);
    for (const [rel, content] of Object.entries(files)) {
      const file = path.join(root, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    return root;
  }

  it("is deterministic across fresh equal trees", () => {
    const hashA = hashLineageTree(tree({ "a.json": "{}", "sub/b.md": "hi" }));
    expect(hashLineageTree(tree({ "a.json": "{}", "sub/b.md": "hi" }))).toBe(hashA);
  });

  it("creation order does not matter (sorted walk)", () => {
    const first = fs.mkdtempSync(path.join(os.tmpdir(), "warm-hash-"));
    tmpDirs.push(first);
    fs.writeFileSync(path.join(first, "z.txt"), "1");
    fs.writeFileSync(path.join(first, "a.txt"), "2");
    const forward = hashLineageTree(first);
    expect(hashLineageTree(tree({ "a.txt": "2", "z.txt": "1" }))).toBe(forward);
  });

  it("reacts to content, name, location, and tree-shape changes", () => {
    const base = hashLineageTree(tree({ "a.json": "one" }));
    expect(hashLineageTree(tree({ "a.json": "two" }))).not.toBe(base); // content
    expect(hashLineageTree(tree({ "b.json": "one" }))).not.toBe(base); // name
    expect(hashLineageTree(tree({ "sub/a.json": "one" }))).not.toBe(base); // location
    expect(hashLineageTree(tree({ "a.json": "one", extra: "" }))).not.toBe(base); // added file
  });

  it("digests generated .ts bridge files by name only (random processKey in body)", () => {
    const base = hashLineageTree(tree({ "ext-e.ts": "processKey: 'k1'" }));
    expect(hashLineageTree(tree({ "ext-e.ts": "processKey: 'k2'" }))).toBe(base);
    expect(hashLineageTree(tree({ "other-e.ts": "processKey: 'k1'" }))).not.toBe(base);
  });

  it("an empty dir has a stable hash, distinct from any tree", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "warm-hash-"));
    tmpDirs.push(empty);
    expect(hashLineageTree(empty)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashLineageTree(tree({ x: "" }))).not.toBe(hashLineageTree(empty));
  });
});

// ---------------------------------------------------------------------------
// sanitizeWarmTemplate
// ---------------------------------------------------------------------------

describe("sanitizeWarmTemplate", () => {
  it("resets volatile identity and keeps every plan-defining field", () => {
    const source = ownedSessionRecord({
      tabId: "tab-9",
      sessionId: "sess-1",
      worktree: { path: "/wt", branch: "b", base: null },
      planImplementationSource: { sourceTabId: "tab-9", planTitle: "t", planFilePath: "local://p-plan.html" },
      model: "opus",
      thinkingLevel: "auto",
      advisor: true,
      advisorModel: "gpt",
      compactionMethod: "hybrid",
      subagentModels: { Explore: "haiku" },
      proposedPlans: [{ key: "local://p-plan.html", title: "t", status: "pending" }],
      autoTitled: true,
      private: true,
      cachedTitle: "t",
      cachedModified: "2026-01-01T00:00:00.000Z",
      agentMode: "plan",
      approvalMode: "yolo",
      serviceTier: "priority",
    });
    const out = sanitizeWarmTemplate(source);
    // Plan-defining: exactly what the overlay writers read.
    expect(out.projectCwd).toBe(source.projectCwd);
    expect(out.mode).toBe(source.mode);
    expect(out.model).toBe("opus");
    expect(out.thinkingLevel).toBe("auto");
    expect(out.advisor).toBe(true);
    expect(out.advisorModel).toBe("gpt");
    expect(out.compactionMethod).toBe("hybrid");
    // Volatile identity: reset.
    expect(out.tabId).toBe("warm-tab-9");
    expect(out.sessionId).toBeNull();
    expect(out.worktree).toBeNull();
    expect(out.planImplementationSource).toBeNull();
    expect(out.agentMode).toBe("build");
    expect(out.approvalMode).toBeNull();
    expect(out.serviceTier).toBeNull();
    expect(out.subagentModels).toBeNull();
    expect(out.proposedPlans).toEqual([]);
    expect(out.autoTitled).toBe(false);
    expect(out.private).toBe(false);
    expect(out.cachedTitle).toBeNull();
    expect(out.cachedModified).toBeNull();
  });

  it("mints a fresh lineage dir of the legal shape, different every call", () => {
    const source = ownedSessionRecord({ projectCwd: "/proj" });
    const a = sanitizeWarmTemplate(source);
    const b = sanitizeWarmTemplate(source);
    expect(a.lineageDir).toMatch(/^omp-ui--proj--[0-9a-f-]{36}$/);
    expect(a.lineageDir).not.toBe(source.lineageDir);
    expect(a.lineageDir).not.toBe(b.lineageDir);
  });
});
