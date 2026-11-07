import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
  Registry,
  StatsCollector,
  readStatsOverview,
  resolveOmpBinary,
  resolveStatsSource,
  type StatsQuery,
  type StatsReadContext,
  type StatsSyncState,
} from "@omp-ui/core";
import { ownedSessionRecord } from "./test/fixtures";

// Actual managed executable, hermetic storage, no model calls or inherited
// credentials. Nonempty fresh files exercise the compiled sync-worker path.
const ompPath = resolveOmpBinary();
const all: StatsQuery = { rangeDays: null, projectKey: null, provider: null, model: null, agentType: null };
const timestamp = Date.parse("2026-11-07T12:00:00.000Z");
const roots: string[] = [];
const collectors: StatsCollector[] = [];

function scope() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-stats-live-"));
  roots.push(root);
  const home = path.join(root, "home");
  fs.mkdirSync(home, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    HOME: home, USERPROFILE: home,
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TMPDIR: root, TEMP: root, TMP: root,
    PI_CONFIG_DIR: ".omp", OMP_PROFILE: "", PI_PROFILE: "",
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_STATE_HOME: path.join(root, "state"),
    NO_COLOR: "1", FORCE_COLOR: "0",
  };
  return { root, home, env };
}

afterEach(async () => {
  await Promise.all(collectors.splice(0).map((collector) => collector.dispose()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function usage() {
  return {
    input: 100, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 120,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
  };
}

function request(id: string, content: unknown[] = [], time = timestamp) {
  return {
    type: "message", id, parentId: null, timestamp: new Date(time).toISOString(),
    message: {
      role: "assistant", api: "openai-completions", provider: "openai", model: "gpt-4o-mini",
      content, timestamp: time, stopReason: "stop", usage: usage(),
    },
  };
}

function writeTranscript(file: string, cwd: string, entries: unknown[]) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { type: "session", version: 3, id: path.basename(file), timestamp: new Date(timestamp).toISOString(), cwd },
    ...entries,
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function append(file: string, entries: unknown[]) {
  fs.appendFileSync(file, entries.map((row) => JSON.stringify(row)).join("\n") + "\n");
}

function result(id: string, error: boolean, text: string) {
  return {
    type: "message", id: `result-${id}`, timestamp: new Date(timestamp + 1000).toISOString(),
    message: {
      role: "toolResult", toolCallId: id, toolName: "read", isError: error,
      content: [{ type: "text", text }], timestamp: timestamp + 1000,
      // A usage receipt is not another assistant/model_usage request.
      usage: usage(),
    },
  };
}

// The actor is an actual OS child; fake timers cannot advance its close or
// cross-process SQLite commits. Poll the terminal state, not a guessed sleep.
async function settled(collector: StatsCollector): Promise<StatsSyncState> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const state = collector.status();
    if (state.run && !["running", "stopping"].includes(state.run.phase)) return state;
    if (Date.now() > deadline) throw new Error(`collector did not settle: ${JSON.stringify(state)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function collect(collector: StatsCollector) {
  collector.start("force");
  const state = await settled(collector);
  expect(state.run?.phase, state.run?.error ?? undefined).toBe("succeeded");
  expect(state.run?.exitCode).toBe(0);
  expect(state.lastSuccessfulSyncAt).not.toBeNull();
  return state;
}

function digest(file: string) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

describe.skipIf(!ompPath)("Stats collector live (actual selected OMP)", () => {
  it.each([
    { name: "default", profile: "", xdg: "absent", custom: false, dotenv: false },
    { name: "named", profile: "work", xdg: "absent", custom: false, dotenv: false },
    { name: "default XDG", profile: "", xdg: "base", custom: false, dotenv: false },
    { name: "named XDG absent", profile: "work", xdg: "base", custom: false, dotenv: false },
    { name: "named XDG present", profile: "work", xdg: "profile", custom: false, dotenv: false },
    { name: "custom agent disables XDG", profile: "", xdg: "base", custom: true, dotenv: false },
    { name: "profile dotenv XDG", profile: "work", xdg: "profile", custom: false, dotenv: true },
  ])("reads the exact writer target for $name", async ({ profile, xdg, custom, dotenv }) => {
    const s = scope();
    s.env.OMP_PROFILE = profile;
    const data = path.join(s.root, dotenv ? "dotenv-data" : "data");
    const configRoot = path.join(s.home, ".omp", ...(profile ? ["profiles", profile] : []));
    const agent = custom ? path.join(s.root, "custom-agent") : path.join(configRoot, "agent");
    if (custom) s.env.PI_CODING_AGENT_DIR = agent;
    if (xdg !== "absent") fs.mkdirSync(path.join(data, "omp", ...(xdg === "profile" ? ["profiles", profile] : [])), { recursive: true });
    if (dotenv) {
      delete s.env.XDG_DATA_HOME;
      fs.mkdirSync(configRoot, { recursive: true });
      fs.writeFileSync(path.join(configRoot, ".env"), `XDG_DATA_HOME=${data}\n`);
    }
    const usesXdg = (process.platform === "linux" || process.platform === "darwin") && !custom &&
      (profile ? xdg === "profile" : xdg !== "absent");
    const base = path.join(data, "omp", ...(profile ? ["profiles", profile] : []));
    const expected = {
      profile: profile || null,
      databasePath: path.join(usesXdg ? base : configRoot, "stats.db"),
      sessionsRoot: path.join(usesXdg ? base : agent, "sessions"),
      archiveRoot: path.join(usesXdg ? base : agent, "archive", "sessions"),
    };
    const source = resolveStatsSource({ env: s.env, cwd: s.home, home: s.home });
    expect(source).toEqual(expected);
    writeTranscript(path.join(expected.sessionsRoot, "--fixture--", "seed.jsonl"), s.root, [request("source-matrix")]);
    const collector = new StatsCollector({
      getOmpPath: () => ompPath, getEnv: () => s.env, cwd: s.home,
      resolveSource: (env, cwd) => resolveStatsSource({ env, cwd, home: s.home }),
    });
    collectors.push(collector);
    await collect(collector);
    const overview = await readStatsOverview(all, {
      source, projects: [], sessions: [], ownedSessionsRoot: source.sessionsRoot, ownedArchiveRoot: source.archiveRoot,
    });
    expect(overview.error).toBeNull();
    expect(overview.totals.requests).toBe(1);
    expect(overview.totals.totalTokens).toBe(120);
    expect(overview.totals.cost).toBeCloseTo(0.003, 10);
  });

  it("conserves fork/model/agent usage, updates late outcomes, and never restores gzip history", async () => {
    const s = scope();
    const source = resolveStatsSource({ env: s.env, cwd: s.home, home: s.home });
    const project = path.join(s.root, "project");
    const registry = Registry.load(path.join(s.root, "registry.json"));
    const projectRecord = registry.addProject(project);
    const lineage = "omp-ui--project--11111111-2222-4333-8444-555555555555";
    const files: string[] = [];
    const parent = path.join(source.sessionsRoot, lineage, "parent.jsonl");
    const first = request("parent-usage", [
      { type: "toolCall", id: "empty-later", name: "read", arguments: { path: "fixture" } },
      { type: "toolCall", id: "error-later", name: "read", arguments: { path: "missing" } },
    ]);
    writeTranscript(parent, project, [first, {
      type: "model_usage", id: "model-usage", parentId: null,
      timestamp: new Date(timestamp).toISOString(), api: "openai-completions", provider: "openai",
      model: "gpt-4o-mini", usage: usage(), stopReason: "stop",
    }, result("receipt-only", false, "not a second request")]);
    files.push(parent);
    for (let n = 1; n < 20; n++) {
      const file = path.join(source.sessionsRoot, lineage, `seed-${n}.jsonl`);
      writeTranscript(file, project, [request(`seed-usage-${n}`, [], timestamp + n)]);
      files.push(file);
    }
    const fork = path.join(source.sessionsRoot, lineage, "fork.jsonl");
    writeTranscript(fork, project, [first, request("fork-new", [], timestamp + 100)]);
    const subagent = path.join(source.sessionsRoot, lineage, "parent", "agent.jsonl");
    const advisor = path.join(source.sessionsRoot, lineage, "parent", "__advisor.jsonl");
    writeTranscript(subagent, project, [request("subagent", [], timestamp + 200)]);
    writeTranscript(advisor, project, [request("advisor", [], timestamp + 300)]);
    files.push(fork, subagent, advisor);
    const archive = path.join(source.archiveRoot, lineage, "archive-only.jsonl.gz");
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.writeFileSync(archive, gzipSync(JSON.stringify(request("never-active")) + "\n"));
    files.push(archive);
    const before = new Map(files.map((file) => [file, digest(file)]));
    const context: StatsReadContext = {
      source, projects: [projectRecord],
      sessions: [ownedSessionRecord({ lineageDir: lineage, projectCwd: project, cachedTitle: "Fixture parent" })],
      ownedSessionsRoot: source.sessionsRoot, ownedArchiveRoot: source.archiveRoot,
    };
    let closes = 0;
    const collector = new StatsCollector({
      getOmpPath: () => ompPath, getEnv: () => s.env, cwd: s.home,
      resolveSource: (env, cwd) => resolveStatsSource({ env, cwd, home: s.home }),
      spawn: ((...args: Parameters<typeof spawn>) => {
        const child = spawn(...args);
        child.once("close", () => { closes++; });
        return child;
      }) as typeof spawn,
    });
    collectors.push(collector);
    const run = await collect(collector);
    expect(run.source).toEqual(source);
    expect(closes).toBe(1);
    let overview = await readStatsOverview(all, context);
    expect(overview.error).toBeNull();
    expect(overview.totals.requests).toBe(24);
    expect(overview.totals.totalTokens).toBe(2880);
    expect(overview.totals.cost).toBeCloseTo(0.072, 10);
    expect(overview.totals.toolCalls).toBe(2);
    expect(overview.agents.map((row) => [row.agentType, row.requests]).sort()).toEqual([
      ["advisor", 1], ["main", 22], ["subagent", 1],
    ]);
    expect(overview.tools).toEqual([{ name: "read", calls: 2, completed: 0, errors: 0, noRecordedOutcome: 2, errorRate: null }]);
    expect(overview.projects).toHaveLength(1);
    expect(overview.projects[0].identity).toMatchObject({ kind: "project", path: project });
    expect(overview.projects[0].requests).toBe(24);
    expect(overview.coverage.archiveOnlyFiles).toBe(1);
    let toolOwner = parent;
    const db = new DatabaseSync(source.databasePath, { readOnly: true });
    try {
      const rollupVersion = db.prepare("SELECT value FROM meta WHERE key='rollup_version'").get()?.value;
      const cursorColumns = db.prepare("PRAGMA table_info(file_offsets)").all().map((row) => row.name);
      // OMP's first-writer guard can retain a copied invocation in the fork.
      // Late results must complete the stored invocation in that source file.
      const owners = db.prepare("SELECT DISTINCT session_file FROM tool_calls").all();
      expect(owners).toHaveLength(1);
      expect([parent, fork]).toContain(owners[0].session_file);
      toolOwner = String(owners[0].session_file);
      expect(cursorColumns).toContain("parser_state");
      expect(overview.rollups).toBe(rollupVersion === "3");
      console.info("Stats managed schema proof", { binary: ompPath, rollupVersion, cursorColumns, requests: overview.totals.requests });
    } finally { db.close(); }
    await collect(collector);
    overview = await readStatsOverview(all, context);
    expect(overview.totals.requests).toBe(24);
    expect(overview.totals.toolCalls).toBe(2);
    for (const file of files) expect(digest(file)).toBe(before.get(file));
    append(parent, [request("appended", [], timestamp + 2000)]);
    append(toolOwner, [result("empty-later", false, "")]);
    const afterAppend = new Map([parent, toolOwner].map((file) => [file, digest(file)]));
    await collect(collector);
    overview = await readStatsOverview(all, context);
    expect(overview.totals.requests).toBe(25);
    expect(overview.totals.totalTokens).toBe(3000);
    expect(overview.totals.cost).toBeCloseTo(0.075, 10);
    expect(overview.tools[0]).toMatchObject({ calls: 2, completed: 1, errors: 0, noRecordedOutcome: 1, errorRate: 0 });
    for (const [file, hash] of afterAppend) expect(digest(file)).toBe(hash);
    append(toolOwner, [result("error-later", true, "fixture failure")]);
    const afterError = digest(toolOwner);
    await collect(collector);
    overview = await readStatsOverview(all, context);
    expect(overview.totals.requests).toBe(25);
    expect(overview.tools[0]).toMatchObject({ calls: 2, completed: 2, errors: 1, noRecordedOutcome: 0, errorRate: 0.5 });
    expect(digest(toolOwner)).toBe(afterError);
    for (const file of files.filter((file) => file !== parent && file !== toolOwner)) expect(digest(file)).toBe(before.get(file));
    expect(fs.existsSync(archive.slice(0, -3))).toBe(false);
    expect(closes).toBe(4);
  });

  it("lets OMP migrate legacy file cursors before the read-only reader opens them", async () => {
    const s = scope();
    const source = resolveStatsSource({ env: s.env, cwd: s.home, home: s.home });
    writeTranscript(path.join(source.sessionsRoot, "--fixture--", "legacy.jsonl"), s.root, [request("legacy-cursor")]);
    fs.mkdirSync(path.dirname(source.databasePath), { recursive: true });
    const legacy = new DatabaseSync(source.databasePath);
    legacy.exec("CREATE TABLE file_offsets (session_file TEXT PRIMARY KEY, offset INTEGER NOT NULL, last_modified INTEGER NOT NULL)");
    legacy.close();
    const collector = new StatsCollector({
      getOmpPath: () => ompPath, getEnv: () => s.env, cwd: s.home,
      resolveSource: (env, cwd) => resolveStatsSource({ env, cwd, home: s.home }),
    });
    collectors.push(collector);
    await collect(collector);
    const db = new DatabaseSync(source.databasePath, { readOnly: true });
    try {
      expect(db.prepare("PRAGMA table_info(file_offsets)").all().map((row) => row.name)).toContain("parser_state");
      expect(db.prepare("SELECT COUNT(*) count FROM messages").get()?.count).toBe(1);
      expect(db.prepare("SELECT COUNT(*) count FROM file_offsets").get()?.count).toBe(1);
    } finally { db.close(); }
  });

  it("retains one host run until an actual TERM-resistant subprocess is reaped", async () => {
    const s = scope();
    let childPid: number | undefined;
    let spawned = 0;
    let closed = false;
    let announceReady!: () => void;
    const ready = new Promise<void>((resolve) => { announceReady = resolve; });
    const collector = new StatsCollector({
      getOmpPath: () => ompPath, getEnv: () => s.env, cwd: s.home,
      resolveSource: (env, cwd) => resolveStatsSource({ env, cwd, home: s.home }),
      spawn: ((_file: string, _args: readonly string[], options: Parameters<typeof spawn>[2]) => {
        spawned++;
        const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);process.stdout.write('ready')"], options);
        childPid = child.pid;
        child.stdout?.once("data", announceReady);
        child.once("close", () => { closed = true; });
        return child;
      }) as typeof spawn,
    });
    collectors.push(collector);
    const first = collector.start("force");
    expect(collector.start("force").run?.id).toBe(first.run?.id);
    await ready;
    const disposed = collector.dispose();
    expect(collector.status().run?.phase).toBe("stopping");
    expect(collector.start("force").run?.id).toBe(first.run?.id);
    expect(spawned).toBe(1);
    expect(closed).toBe(false);
    await disposed;
    expect(closed).toBe(true);
    expect(collector.status().run?.phase).toBe("cancelled");
    expect(collector.status().lastSuccessfulSyncAt).toBeNull();
    expect(() => process.kill(childPid!, 0)).toThrow();
  });
});
