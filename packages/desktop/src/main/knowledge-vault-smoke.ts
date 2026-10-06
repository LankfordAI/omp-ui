import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import {
  parseVaultDetails,
  resolveSessionLocation,
  type ObsidianListEntry,
  type OwnedSessionRecord,
  type RootGuard,
  type RpcFrame,
  type SessionsResourceDeps,
  type VaultRegistry,
  type VaultToolDetails,
} from "@omp-ui/core";
import { HostBridge, HOST_ANSWER_WATCHDOG_MS, type HostBridgeDeps, type VaultBridgeDeps } from "./host-bridge";
import { openVaultTarget } from "./vault-open";

/**
 * Node-posture smoke of the Knowledge vault host tools (#769, spec §13/§14).
 * Third main entry; never packaged. Runs under ELECTRON_RUN_AS_NODE, so it
 * never imports electron: there is no `app`, and the run ends in process.exit.
 *
 *   npm run smoke:knowledge-vault -w @omp-ui/desktop -- [flags]
 *
 * Flags: --volume=<csv> search sizes (1000,5000; 20000 is recorded, not gating)
 *        --slow adds S9, the 60 s host-answer watchdog row
 *        --out=DIR (out/knowledge-vault-smoke)
 *
 * The shipped HostBridge answers frames against a vault built by
 * scripts/gen-fixture-vault.mjs; openVaultTarget hands its URIs to a recording
 * opener. Writes summary.json; exits 0 when `failures` is empty, else 1.
 * Note bodies are never logged.
 */

// ---------------------------------------------------------------- flags

function flagValue(name: string): string | null {
  const prefix = `--${name}=`;
  const hit = process.argv.find((a) => a.startsWith(prefix));
  return hit === undefined ? null : hit.slice(prefix.length);
}

const flags = {
  volume: (flagValue("volume") ?? "1000,5000").split(",").filter((s) => s.trim() !== "").map(Number),
  slow: process.argv.includes("--slow"),
  out: path.resolve(flagValue("out") ?? path.resolve(__dirname, "..", "knowledge-vault-smoke")),
};

/** Median search budget per size; 20000 and sizes outside the table are recorded, never gating. */
const THRESHOLDS_MS: Readonly<Record<number, number>> = { 1000: 500, 5000: 1500, 20000: 4000 };

/** out/main → repo root. */
const GEN = path.resolve(__dirname, "../../../../scripts/gen-fixture-vault.mjs");
const TAB = "smoke";
const VAULT_NAME = "Smoke";
const LINEAGE = "019a38bf-bbaa-7111-8123-123456789abc";
const OBSIDIAN_ID = "0123456789abcdef";

// ---------------------------------------------------------------- summary

interface ToolRow { ok: boolean; ms: number | null }
interface VolumeRow { notes: number; bytes: number | null; ms: number | null; thresholdMs: number | null; gating: boolean; ok: boolean }

const failures: string[] = [];
const summary = {
  platform: {
    os: process.platform,
    arch: process.arch,
    node: process.versions.node,
    electron: process.versions.electron ?? null,
  },
  flags,
  tools: {} as Record<string, ToolRow>,
  cardArgsOk: false,
  stamped: false,
  indexLinesAdded: null as number | null,
  collision: { created: false, resultNamesCollision: false, noSuffix: false },
  volume: [] as VolumeRow[],
  day: { rowCount: null as number | null, collapsed: false, gzTailFound: false, activeRootClean: false, userTextFound: null as boolean | null },
  dayRerun: { created: false, dupRefused: false, editRan: false, dupFiles: null as number | null },
  secrets: { refused: false, prosePassed: false },
  escape: { refused: [] as boolean[], unreachableIsError: false, answersAfter: false },
  handoff: { cardUri: null as string | null, rowUri: null as string | null, opens: 0, launched: false },
  watchdog: { skipped: true } as Record<string, unknown>,
  failures,
};

function gate(id: string, ok: boolean): boolean {
  if (!ok) failures.push(id);
  return ok;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------- helpers

/** The bridge builds every tool answer with hostToolResult, so `result` carries content and details. */
type ToolAnswer = { content?: unknown; details?: unknown } | undefined;

// resultText/resultHash follow host-bridge.test.ts.
function resultText(frame: RpcFrame): string {
  const content = (frame.result as ToolAnswer)?.content;
  if (!Array.isArray(content)) throw new Error("missing result content");
  return content.flatMap((item: { type?: unknown; text?: unknown } | null) =>
    item?.type === "text" && typeof item.text === "string" ? [item.text] : []).join("\n");
}

function resultDetails(frame: RpcFrame): VaultToolDetails | null {
  return parseVaultDetails((frame.result as ToolAnswer)?.details);
}

function resultHash(frame: RpcFrame): string {
  const hash = resultDetails(frame)?.baseHash;
  if (hash === undefined) throw new Error("missing baseHash");
  return hash;
}

/** No isError and details that parse: what a write card needs to render. */
function answered(frame: RpcFrame): boolean {
  return frame.isError !== true && resultDetails(frame) !== null;
}

function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Runs the fixture generator in place; returns the total note bytes it reports. */
function generate(vault: string, notes: number): number {
  const run = spawnSync(process.execPath, [GEN, `--out=${vault}`, `--notes=${notes}`], {
    encoding: "utf8",
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  if (run.status !== 0) throw new Error(`gen-fixture-vault exited ${run.status}: ${run.stderr.trim()}`);
  const { bytes } = JSON.parse(run.stdout.trim()) as { bytes?: unknown };
  if (typeof bytes !== "number") throw new Error("gen-fixture-vault printed no summary line");
  return bytes;
}

/** Every file under `root` whose basename matches, without following symlinks. */
function findFiles(root: string, match: (name: string) => boolean): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.isFile() && match(entry.name)) found.push(path.relative(root, abs));
    }
  };
  walk(root);
  return found;
}

/** Recursive listing with mtimes: proves a read left the tree untouched. */
function listing(root: string): string[] {
  const rows: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      rows.push(`${path.relative(root, abs)} ${fs.lstatSync(abs).mtimeMs}`);
      if (entry.isDirectory()) walk(abs);
    }
  };
  walk(root);
  return rows.sort();
}

function lineCount(file: string): number {
  return fs.readFileSync(file, "utf8").split("\n").length - 1;
}

function hostDeps(log: string[]): Omit<HostBridgeDeps, "vault" | "sessions"> {
  return {
    readPlanFile: async () => ({ ok: false, reason: "unreadable" }),
    planSnapshot: () => null,
    planRoot: () => null,
    notify: () => "posted",
    capabilitySessionId: () => null,
    log: (message) => log.push(message),
  };
}

let nextId = 0;

/** One host frame through bridge.route; resolves on the bridge's first answer. */
function route(bridge: HostBridge, frame: RpcFrame): Promise<{ frame: RpcFrame; ms: number }> {
  const start = performance.now();
  const { promise, resolve } = Promise.withResolvers<{ frame: RpcFrame; ms: number }>();
  bridge.route(TAB, frame, (answer) => resolve({ frame: answer, ms: round2(performance.now() - start) }));
  return promise;
}

function toolFrame(action: string, args: unknown): RpcFrame {
  const id = `kv-${++nextId}`;
  return { type: "host_tool_call", id, toolCallId: `tc-${id}`, toolName: `omp-ui_vault_${action}`, arguments: args };
}

// ---------------------------------------------------------------- run

async function step(id: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    failures.push(`crash: ${id}: ${errorMessage(error)}`);
  }
  console.log(`STEP ${id} ${failures.some((f) => f.startsWith(`${id}.`) || f.startsWith(`crash: ${id}:`)) ? "fail" : "pass"}`);
}

async function run(base: string): Promise<void> {
  const vault = path.join(base, "vault");
  const guardDirs = ["home", "data", "agent", "sessions", "archive"].map((d) => path.join(base, d));
  for (const dir of guardDirs) fs.mkdirSync(dir, { recursive: true });
  const [home, userData, agentDir, sessionsRoot, archiveRoot] = guardDirs as [string, string, string, string, string];
  const guard: RootGuard = { home, userData, agentDir, sessionsRoot, archiveRoot };
  generate(vault, 0);
  const vaultReal = fs.realpathSync(vault);
  const fixtureList: ObsidianListEntry[] = [{ id: OBSIDIAN_ID, path: vaultReal, open: true }];
  const registry: VaultRegistry = {
    vaults: [{ name: VAULT_NAME, path: vault, homeFolder: "omp-ui/", allowWritesOutsideHome: false }],
    defaultWriteVault: VAULT_NAME,
  };
  const now = new Date();
  const today = localDay(now);
  const records = sessionRecords(now);
  const sessions: SessionsResourceDeps = {
    records: () => records,
    projects: () => [],
    locate: (dir, sid) => resolveSessionLocation(sessionsRoot, archiveRoot, dir, sid),
    now: () => new Date(),
  };
  const mainLog: string[] = [];
  const hostLog: string[] = [];
  const vaultDeps: VaultBridgeDeps = {
    context: () => ({ projectName: "Smoke", projectFolder: "Smoke", pinnedVault: null, lineage: LINEAGE }),
    registry: () => registry,
    guard: () => guard,
    obsidianList: async () => fixtureList,
    appVersion: "smoke-769",
    now: () => new Date(),
    mainLog: (line) => mainLog.push(line),
  };
  const bridge = new HostBridge({ ...hostDeps(hostLog), vault: vaultDeps, sessions });
  const writes: RpcFrame[] = [];
  const call = async (action: string, args: unknown): Promise<{ frame: RpcFrame; ms: number }> => {
    bridge.noteFrame(TAB, { type: "turn_start" });
    return route(bridge, toolFrame(action, args));
  };
  /** A write expected to land; cardArgsOk covers every one of them. */
  const write = async (action: string, args: unknown): Promise<RpcFrame> => {
    const { frame } = await call(action, args);
    writes.push(frame);
    return frame;
  };
  const read = async (url: string): Promise<RpcFrame> =>
    (await route(bridge, { type: "host_uri_request", id: `kv-${++nextId}`, operation: "read", url })).frame;

  await step("S1", async () => {
    const indexFile = path.join(vault, "omp-ui/Smoke/Smoke Index.md");
    const indexBefore = lineCount(indexFile);
    const tool = (action: string, frame: RpcFrame, ms: number | null, extra = true): void => {
      const ok = answered(frame) && extra;
      summary.tools[action] = { ok, ms };
      gate(`S1.${action}`, ok);
    };
    const search = await call("search", { query: "zephyrine" });
    tool("search", search.frame, search.ms,
      resultDetails(search.frame)?.matchedFiles === 1 && resultText(search.frame).includes("User Note 07.md"));
    const readNote = await call("read", { path: "User Note 07.md" });
    tool("read", readNote.frame, readNote.ms);
    const list = await call("list", {});
    tool("list", list.frame, list.ms);
    const rel = "omp-ui/Smoke/Smoke Round Trip.md";
    const created = await write("create", { title: "Smoke Round Trip", body: "First body.", tags: ["smoke"] });
    tool("create", created, null);
    summary.stamped = fs.readFileSync(path.join(vault, rel), "utf8").startsWith("---\nomp-ui: true");
    gate("S1.stamped", summary.stamped);
    const append = await write("append", { path: rel, text: "Appended." });
    tool("append", append, null);
    const beforeEdit = await call("read", { path: rel });
    const edit = await write("edit", { path: rel, baseHash: resultHash(beforeEdit.frame), content: "Edited body." });
    tool("edit", edit, null);
    const beforeLink = await call("read", { path: rel });
    const link = await write("link", { path: rel, to: "User Note 01", baseHash: resultHash(beforeLink.frame) });
    tool("link", link, null);
    summary.indexLinesAdded = lineCount(indexFile) - indexBefore;
    gate("S1.indexLinesAdded", summary.indexLinesAdded === 1);
  });

  await step("S2", async () => {
    const created = await write("create", { title: "Foo", body: "Collision probe." });
    summary.collision.created = answered(created);
    const text = summary.collision.created ? resultText(created) : "";
    const collisions = resultDetails(created)?.collisions ?? [];
    summary.collision.resultNamesCollision = text.includes("also exists at") && text.includes("[[omp-ui/Smoke/Foo|Foo]]") &&
      collisions.includes("Foo.md") && collisions.includes("omp-ui/Foo.md");
    summary.collision.noSuffix = findFiles(vault, (name) => name === "Foo 1.md").length === 0;
    gate("S2.created", summary.collision.created);
    gate("S2.resultNamesCollision", summary.collision.resultNamesCollision);
    gate("S2.noSuffix", summary.collision.noSuffix);
  });

  await step("S4", async () => {
    fs.writeFileSync(path.join(base, "registry.json"), `${JSON.stringify({ schemaVersion: 1, projects: [], sessions: records }, null, 2)}\n`);
    writeArchivedTranscript(archiveRoot);
    const before = listing(sessionsRoot);
    const index = await read(`omp-ui://sessions?day=${today}`);
    const gz = await read("omp-ui://sessions/sess-gz/summary");
    const newest = await read("omp-ui://sessions/sess-a2/summary");
    const texts = [index, gz, newest].map((frame) => (typeof frame.content === "string" ? frame.content : ""));
    const [indexText, gzText] = texts as [string, string, string];
    summary.day.rowCount = (indexText.match(/^- \*\*/gm) ?? []).length;
    summary.day.collapsed = indexText.includes("Newest A") && !indexText.includes("Older A");
    summary.day.gzTailFound = gzText.includes("GZ-TAIL-769");
    summary.day.activeRootClean = JSON.stringify(listing(sessionsRoot)) === JSON.stringify(before);
    summary.day.userTextFound = texts.some((text) => text.includes("USER-MARKER-769"));
    gate("S4.rowCount", summary.day.rowCount === 2);
    gate("S4.collapsed", summary.day.collapsed);
    gate("S4.gzTailFound", summary.day.gzTailFound);
    gate("S4.activeRootClean", summary.day.activeRootClean);
    gate("S4.userTextFound", summary.day.userTextFound === false);
  });

  await step("S5", async () => {
    const title = `${today} Day Write-up`;
    const rel = `omp-ui/${title}.md`;
    const first = await write("create", { title, body: "one", project: false });
    summary.dayRerun.created = answered(first) && resultDetails(first)?.path === rel;
    const again = await call("create", { title, body: "one", project: false });
    summary.dayRerun.dupRefused = again.frame.isError === true && resultText(again.frame).includes("note exists");
    const current = await call("read", { path: rel });
    const edit = await write("edit", { path: rel, baseHash: resultHash(current.frame), content: "one, revised" });
    summary.dayRerun.editRan = answered(edit);
    summary.dayRerun.dupFiles = findFiles(vault, (name) => /Day Write-up \d+\.md$/.test(name)).length;
    gate("S5.created", summary.dayRerun.created);
    gate("S5.dupRefused", summary.dayRerun.dupRefused);
    gate("S5.editRan", summary.dayRerun.editRan);
    gate("S5.dupFiles", summary.dayRerun.dupFiles === 0);
  });

  await step("S6", async () => {
    const key = `sk-${"A".repeat(32)}`;
    const leak = await call("create", { title: "Key Leak", body: `token ${key}` });
    const leakText = resultText(leak.frame);
    summary.secrets.refused = leak.frame.isError === true && leakText.includes("secret shape") && !leakText.includes(key);
    const prose = await write("create", { title: "Key Prose", body: "OpenAI keys start with sk- and must never be pasted." });
    summary.secrets.prosePassed = answered(prose);
    gate("S6.refused", summary.secrets.refused);
    gate("S6.prosePassed", summary.secrets.prosePassed);
  });

  await step("S7a", async () => {
    for (const target of ["../../etc/passwd", "linked-out/secret.md", path.resolve(vault, "User Note 01.md"), ".obsidian/x.md"]) {
      summary.escape.refused.push((await call("read", { path: target })).frame.isError === true);
    }
    gate("S7a.refused", summary.escape.refused.length === 4 && summary.escape.refused.every(Boolean));
  });

  await step("S8", async () => {
    const opens: string[] = [];
    const open = async (uri: string): Promise<void> => {
      opens.push(uri);
    };
    await openVaultTarget(registry, VAULT_NAME, "omp-ui/Smoke/Foo.md", { guard, obsidianList: async () => fixtureList, open });
    summary.handoff.cardUri = opens[0] ?? null;
    await openVaultTarget(registry, VAULT_NAME, null, { guard, obsidianList: async () => [], open });
    summary.handoff.rowUri = opens[1] ?? null;
    summary.handoff.opens = opens.length;
    gate("S8.cardUri", summary.handoff.cardUri === `obsidian://open?vault=0123456789abcdef&file=${encodeURIComponent("omp-ui/Smoke/Foo")}`);
    gate("S8.rowUri", summary.handoff.rowUri === `obsidian://open?path=${encodeURIComponent(vaultReal)}`);
    // The recording opener is the only one wired: nothing reached the OS.
    gate("S8.launched", opens.length === 2 && !summary.handoff.launched);
  });

  // cardArgsOk covers every write the rows above expected to land.
  summary.cardArgsOk = writes.length > 0 && writes.every(answered);
  gate("cardArgsOk", summary.cardArgsOk);

  for (const notes of flags.volume) {
    await step(`S3.${notes}`, async () => {
      const thresholdMs = THRESHOLDS_MS[notes] ?? null;
      const gating = thresholdMs !== null && notes !== 20000;
      const row: VolumeRow = { notes, bytes: null, ms: null, thresholdMs, gating, ok: false };
      summary.volume.push(row);
      try {
        row.bytes = generate(vault, notes);
        await call("search", { query: "zephyrine" });
        const timed: number[] = [];
        let matched = true;
        for (let i = 0; i < 3; i++) {
          const search = await call("search", { query: "zephyrine" });
          timed.push(search.ms);
          matched &&= resultDetails(search.frame)?.matchedFiles === 1;
        }
        row.ms = median(timed);
        row.ok = matched && (thresholdMs === null || row.ms <= thresholdMs);
      } finally {
        if (gating) gate(`S3.${notes}`, row.ok);
      }
    });
  }

  await step("S7b", async () => {
    const gone = path.join(base, "vault-gone");
    fs.renameSync(vault, gone);
    try {
      const missing = await call("search", { query: "zephyrine" });
      summary.escape.unreachableIsError = missing.frame.isError === true && resultText(missing.frame).includes("is unreachable");
    } finally {
      fs.renameSync(gone, vault);
    }
    summary.escape.answersAfter = answered((await call("search", { query: "zephyrine" })).frame);
    gate("S7b.unreachableIsError", summary.escape.unreachableIsError);
    gate("S7b.answersAfter", summary.escape.answersAfter);
  });

  bridge.forget(TAB);

  if (flags.slow) await step("S9", () => watchdogRow(vaultDeps));
}

/** S9: a never-settling obsidianList; the watchdog answers once at 60 s and the late answer is dropped. */
async function watchdogRow(vaultDeps: VaultBridgeDeps): Promise<void> {
  const stuck = Promise.withResolvers<ObsidianListEntry[]>();
  const bridge = new HostBridge({ ...hostDeps([]), vault: { ...vaultDeps, obsidianList: () => stuck.promise } });
  // The watchdog timer is unref()'d: keep the loop alive while it runs.
  const keepAlive = setInterval(() => {}, 1000);
  try {
    const sent: RpcFrame[] = [];
    const t0 = performance.now();
    const first = Promise.withResolvers<{ frame: RpcFrame; atMs: number }>();
    bridge.route(TAB, toolFrame("read", { path: "User Note 01.md" }), (frame) => {
      sent.push(frame);
      if (sent.length === 1) first.resolve({ frame, atMs: round2(performance.now() - t0) });
    });
    const { frame, atMs } = await first.promise;
    stuck.resolve([]);
    const settle = Promise.withResolvers<void>();
    setTimeout(settle.resolve, 2000);
    await settle.promise;
    const text = resultText(frame);
    const row = {
      skipped: false,
      watchdogMs: HOST_ANSWER_WATCHDOG_MS,
      timedOutAtMs: atMs,
      isError: frame.isError === true,
      textOk: text.includes("could not answer this request in time"),
      lateDropped: sent.length === 1,
    };
    summary.watchdog = row;
    gate("S9.timedOutAtMs", row.timedOutAtMs >= HOST_ANSWER_WATCHDOG_MS && row.timedOutAtMs <= HOST_ANSWER_WATCHDOG_MS + 1000);
    gate("S9.text", row.isError && row.textOk);
    gate("S9.lateDropped", row.lateDropped);
  } finally {
    clearInterval(keepAlive);
    bridge.forget(TAB);
  }
}

// ---------------------------------------------------------------- S4 fixtures

const LINEAGE_A = "omp-ui--smoke--aaaaaaaa-0000-4000-8000-000000000001";
const LINEAGE_B = "omp-ui--smoke--bbbbbbbb-0000-4000-8000-000000000002";

function sessionRecords(now: Date): OwnedSessionRecord[] {
  const hour = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours());
  const at = (minutes: number): string => new Date(hour.getTime() + minutes * 60_000).toISOString();
  const record = (patch: Partial<OwnedSessionRecord>): OwnedSessionRecord => ({
    tabId: "tab-1",
    sessionId: "sess-1",
    lineageDir: LINEAGE_A,
    projectCwd: "/abs/smoke",
    worktree: null,
    planImplementationSource: null, experiment: null,
    launchedAt: at(0),
    mode: "rpc-ui",
    compactionMethod: null,
    approvalMode: null,
    serviceTier: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null,
    subagentModels: null,
    proposedPlans: [],
    cachedTitle: "Untitled",
    cachedModified: at(0),
    agentMode: "build",
    ...patch,
  });
  return [
    record({ tabId: "tab-a1", sessionId: "sess-a1", cachedTitle: "Older A" }),
    record({ tabId: "tab-a2", sessionId: "sess-a2", cachedTitle: "Newest A", cachedModified: at(1) }),
    record({ tabId: "tab-b", sessionId: "sess-gz", lineageDir: LINEAGE_B, cachedTitle: "Archived B" }),
  ];
}

/** Transcript line shape from sessions-resource.test.ts. */
function message(message: object): string {
  return JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "t", message });
}

function writeArchivedTranscript(archiveRoot: string): void {
  const dir = path.join(archiveRoot, LINEAGE_B);
  fs.mkdirSync(dir, { recursive: true });
  const jsonl = [
    message({ role: "user", content: [{ type: "text", text: "USER-MARKER-769" }] }),
    message({ role: "assistant", content: [{ type: "text", text: "GZ-TAIL-769" }], stopReason: "stop" }),
  ].join("\n");
  fs.writeFileSync(path.join(dir, "2026-10-06T00-00-00-000Z_sess-gz.jsonl.gz"), zlib.gzipSync(jsonl));
}

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-kv-smoke-"));
  console.log(`START volume=${flags.volume.join(",")} slow=${flags.slow} out=${flags.out}`);
  try {
    await run(base);
  } catch (error) {
    failures.push(`crash: ${errorMessage(error)}`);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  fs.mkdirSync(flags.out, { recursive: true });
  const file = path.join(flags.out, "summary.json");
  fs.writeFileSync(file, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`FINISH failures=${failures.length} summary=${file}`);
  return failures.length === 0 ? 0 : 1;
}

void main().then((code) => process.exit(code));
