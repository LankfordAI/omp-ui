import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  RpcClient,
  compareVersions,
  readInstalledOmpVersion,
  resolveOmpBinary,
  writeWorktreeOverlay,
} from "@omp-ui/core";

/**
 * ADR-0089 (issue #1071): omp 18.17 turns ovnfs on by itself whenever its
 * binary is discoverable (`ovnfs.path`, else `ovnfs` on PATH), and omp-ui's
 * per-lineage worktree overlay now pins `ovnfs.path` at the lineage directory
 * itself — a directory no platform can execute — so an owned session never
 * discovers it. This file proves that suppression against the REAL
 * `omp --mode=rpc-ui` and a REAL ovnfs binary/daemon — assertions are runtime
 * outcomes, never prompt text or embedded source strings:
 *
 * - suppression arm: with the pin in place and `ovnfs` reachable on the
 *   child's PATH, an allowed isolated task runs OUTSIDE any ovnfs mount, its
 *   patch still lands in the parent checkout as an ordinary tracked-file
 *   modification, the parent's `git worktree list --porcelain` never changes,
 *   and the ovnfs state/mount roots scoped to this temp base are never even
 *   created — the daemon was never started;
 * - precedence arm: discovery succeeds through the USER's global agent config
 *   (`ovnfs.path` naming the real binary) while every ovnfs-bearing PATH
 *   directory is stripped, so the per-lineage overlay is the only thing that
 *   can suppress it — and it does;
 * - control arm: with every ovnfs-bearing PATH directory stripped (a genuine
 *   no-ovnfs machine), the identical task produces the byte-identical parent
 *   outcome through the same native fallback — the suppression pin changes
 *   nothing where discovery had nothing to find.
 *
 * Non-vacuity: with the `ovnfs.path` line removed from the production writer,
 * all three cases fail (verified during development, not shipped) — every arm
 * observes real discovery, not a machine where ovnfs could not have run.
 *
 * Everything ovnfs touches is scoped to the temp base: `OVNFS_STATE`/
 * `OVNFS_MOUNT` (the daemon's own env overrides) point under the scope, so no
 * user state root or checkout mount is ever used and no global config is
 * written. The ovnfs binary is never installed here: it must already exist at
 * `$OMP_UI_OVNFS_BIN` or on PATH, and an `ovnfs` that cannot actually serve a
 * checkout skips every case here — including the control, whose contract is
 * exactly "suppressed-with-ovnfs-reachable result == no-ovnfs result", so it
 * only means something on a machine where ovnfs would otherwise have run.
 * Without any ovnfs the whole file skips, so CI — where none exists — is
 * unaffected.
 *
 * Real timers throughout: the awaited actors are OS processes (omp, the
 * daemon), so fake clocks cannot drive them; every wait polls an observed
 * condition, never a guessed duration.
 */

const ompPath = resolveOmpBinary();
/** The release where ovnfs turned on by itself when its binary is found. */
const OVNFS_AUTO_FLOOR = "18.17.0";

const ROOT_PROMPT = "ROOT-OVNFS-PROBE";
const AGENT_MARK = "OVNFS-PROBE-AGENT";
/** A tracked file the child appends its cwd stamp to, so the patch modifies content. */
const PROBE_REL = "src/file.txt";

/** `$OMP_UI_OVNFS_BIN` wins; otherwise the first executable `ovnfs` on PATH. */
function findOvnfsBinary(): string | null {
  const configured = process.env.OMP_UI_OVNFS_BIN?.trim();
  if (configured !== undefined && configured !== "") {
    try {
      fs.accessSync(configured, fs.constants.X_OK);
      return configured;
    } catch {
      return null;
    }
  }
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    try {
      fs.accessSync(path.join(dir, "ovnfs"), fs.constants.X_OK);
      return path.join(dir, "ovnfs");
    } catch {
      // Not here; keep walking PATH.
    }
  }
  return null;
}

const ovnfsPath = findOvnfsBinary();

/** Dirs on the inherited PATH that hold an executable `ovnfs`. */
function pathDirsWithOvnfs(): Set<string> {
  const found = new Set<string>();
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    try {
      fs.accessSync(path.join(dir, "ovnfs"), fs.constants.X_OK);
      found.add(dir);
    } catch {
      // No ovnfs in this dir.
    }
  }
  return found;
}

/**
 * Whether a reachable ovnfs can actually serve here: an installed binary that
 * cannot mount would fall back to native on its own, so a suppressed result
 * from it would prove nothing. Starts one throwaway daemon under its own temp
 * state/mount and requires the mount root to exist; stopped and removed again
 * either way, so nothing outside the temp dir is touched.
 */
function probeOvnfsDaemon(): boolean {
  if (ovnfsPath === null) return false;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-ovnfs-cap-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OVNFS_STATE: path.join(base, "state"),
    OVNFS_MOUNT: path.join(base, "mount"),
  };
  try {
    const start = spawnSync(ovnfsPath, ["--json", "start"], { encoding: "utf8", env, timeout: 30_000 });
    if (start.status !== 0) return false;
    let status: Record<string, unknown> | null = null;
    try {
      status = JSON.parse(start.stdout) as Record<string, unknown>;
    } catch {
      return false;
    }
    // A live mount root is the serve evidence: whatever frontend the platform
    // picks (FUSE, NFS, WinFsp), a daemon that cannot present checkouts leaves
    // it absent.
    return (
      status.version === 5 && typeof status.mount === "string" && status.mount !== "" && fs.existsSync(status.mount)
    );
  } catch {
    return false;
  } finally {
    spawnSync(ovnfsPath, ["stop"], { encoding: "utf8", env, timeout: 15_000 });
    for (const target of liveMountsUnder(base)) {
      spawnSync("fusermount3", ["-u", "-z", target], { encoding: "utf8", timeout: 10_000 });
      spawnSync("fusermount", ["-u", "-z", target], { encoding: "utf8", timeout: 10_000 });
    }
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
const MODELS_YML = (baseUrl: string): string => `providers:
  probe:
    baseUrl: ${baseUrl}
    api: openai-completions
    apiKey: none
    models:
      - id: inert
        name: inert
        contextWindow: 131072
        maxTokens: 128
`;

const CONFIG_YML = `startup:
  checkUpdate: false
retry:
  enabled: false
tools:
  approvalMode: yolo
`;

/** Isolation is opt-in per install; this overlay is the harness's only elevation. */
const ISOLATION_OVERLAY = "task:\n  isolation:\n    enabled: true\n";

interface Frame {
  type: string;
}

interface Scope {
  base: string;
  project: string;
  ompWorktrees: string;
  ovnfsState: string;
  ovnfsMount: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(50);
  }
}

function chunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: "ovnfsprobe",
    object: "chat.completion.chunk",
    created: 0,
    model: "inert",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason === null ? {} : { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
  })}\n\n`;
}

/** The root's one `task` call: a single `isolated: true` subagent. */
const TASK_CALL = {
  index: 0,
  id: "call_isolated",
  type: "function",
  function: {
    name: "task",
    arguments: JSON.stringify({
      i: "isolation probe",
      context: "Live ovnfs suppression probe.",
      tasks: [
        {
          name: "Isoprobe",
          agent: "task",
          task: `${AGENT_MARK}: write the probe file.`,
          solutionSpace: "one fixed action",
          isolated: true,
        },
      ],
    }),
  },
};

/**
 * The subagent's one bash call. `$PWD` is stamped INTO the tracked file, so
 * the patch omp applies back to the parent carries — as data observed from
 * the real child shell — the exact directory the child ran in. That is the
 * backend oracle: under an ovnfs checkout the stamp sits below the daemon
 * mount, under the native fallback it sits in omp's own worktree slot.
 */
const BASH_CALL = {
  index: 0,
  id: "call_write",
  type: "function",
  function: {
    name: "bash",
    arguments: JSON.stringify({
      command: `printf 'cwd=%s\\n' "$PWD" >> ${PROBE_REL}`,
      i: "stamp the tracked probe file with the child cwd",
    }),
  },
};

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) =>
      part !== null && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("\n");
}

interface ScriptedProvider {
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * Routes on the opening (pre-assistant) messages of each completion:
 * - a subagent's first completion emits its probe-file write;
 * - a subagent's later completion answers `done` and stops;
 * - the root's first completion emits the isolated `task` call;
 * - anything else (the root's post-tool turn) answers `ok` and stops.
 */
async function scriptedProvider(): Promise<ScriptedProvider> {
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      let messages: unknown[] = [];
      try {
        const body: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
        if (body !== null && typeof body === "object" && "messages" in body && Array.isArray(body.messages)) {
          messages = body.messages;
        }
      } catch {
        // An unparseable body is answered like any non-probe completion.
      }
      const firstAssistant = messages.findIndex(
        (message) =>
          message !== null && typeof message === "object" && "role" in message && message.role === "assistant",
      );
      const opening = (firstAssistant < 0 ? messages : messages.slice(0, firstAssistant))
        .map((message) =>
          message !== null && typeof message === "object" && "content" in message ? messageText(message.content) : "",
        )
        .join("\n");
      const agent = opening.includes(AGENT_MARK);
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      if (agent && firstAssistant >= 0) {
        response.end(chunk({ role: "assistant", content: "done" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
        return;
      }
      if (agent) {
        response.end(
          chunk({ role: "assistant", tool_calls: [BASH_CALL] }, null) +
            chunk({}, "tool_calls") +
            "data: [DONE]\n\n",
        );
        return;
      }
      if (firstAssistant < 0 && opening.includes(ROOT_PROMPT)) {
        response.end(
          chunk({ role: "assistant", tool_calls: [TASK_CALL] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n",
        );
        return;
      }
      response.end(chunk({ role: "assistant", content: "ok" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no loopback provider port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      return closed.promise;
    },
  };
}
/** One git fact, read hermetically against the scope's temp HOME. */
function gitIn(repoDir: string, base: string, args: readonly string[]): string {
  const home = path.join(base, "home");
  const run = spawnSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    env: {
      HOME: home,
      USERPROFILE: home,
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig"),
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "probe",
      GIT_AUTHOR_EMAIL: "probe@example.com",
      GIT_COMMITTER_NAME: "probe",
      GIT_COMMITTER_EMAIL: "probe@example.com",
    },
  });
  if (run.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${run.stderr}`);
  return run.stdout;
}

interface ScopeOptions {
  /** Strip every ovnfs-bearing PATH dir: the genuine no-ovnfs machine. */
  hideOvnfs: boolean;
  /** Write `ovnfs.path` = the real binary into the scope's GLOBAL agent layer. */
  globalOvnfsPin: boolean;
}

interface Scope extends ScopeOptions {
  base: string;
  project: string;
  ompWorktrees: string;
  ovnfsState: string;
  ovnfsMount: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}

/**
 * One hermetic scope: a git project, a lineage dir carrying the REAL
 * `writeWorktreeOverlay` output (the suppression pin included) plus the
 * isolation opt-in, an ovnfs state/mount pair that lives only under this temp
 * base, and the arm's PATH. The armed arm prepends a bin dir holding a
 * symlinked `ovnfs`, so discovery has a real binary to find; the hidden arm
 * strips EVERY directory that holds one.
 */
function buildScope(provider: ScriptedProvider, options: ScopeOptions): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-ovnfs-live-"));
  const home = path.join(base, "home");
  const agentDir = path.join(base, "home", ".omp", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.yml"), MODELS_YML(provider.baseUrl));
  fs.writeFileSync(
    path.join(agentDir, "config.yml"),
    options.globalOvnfsPin ? `${CONFIG_YML}ovnfs:\n  path: ${JSON.stringify(ovnfsPath!)}\n` : CONFIG_YML,
  );

  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  const ovnfsState = path.join(base, "ovnfs-state");
  const ovnfsMount = path.join(base, "mount", "checkouts");
  const childBin = path.join(base, "child-bin");
  fs.mkdirSync(path.join(project, "src"), { recursive: true });
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(childBin, { recursive: true });
  fs.writeFileSync(path.join(project, "src", "file.txt"), "base\n");

  gitIn(project, base, ["init", "-q", "-b", "main"]);
  gitIn(project, base, ["add", "-A"]);
  gitIn(project, base, ["commit", "-q", "-m", "init"]);
  gitIn(project, base, ["branch", "probe-session"]);

  if (!options.hideOvnfs) {
    fs.symlinkSync(ovnfsPath!, path.join(childBin, "ovnfs"));
  }
  const ovnfsDirs = pathDirsWithOvnfs();
  const inheritedPath = (process.env.PATH ?? "").split(path.delimiter);
  const armPath = options.hideOvnfs
    ? inheritedPath.filter((dir) => !ovnfsDirs.has(dir))
    : [childBin, ...inheritedPath];

  // Exactly what a real spawn carries: the omp-ui worktree + ovnfs pins from
  // the production writer, plus the isolation opt-in as a second overlay.
  const worktreeOverlay = writeWorktreeOverlay(lineage);
  const isolationOverlay = path.join(lineage, "omp-ui-isolation-probe.yml");
  fs.writeFileSync(isolationOverlay, ISOLATION_OVERLAY);
  const overlays = [worktreeOverlay, isolationOverlay];

  const frames: Frame[] = [];
  const { promise: exited, resolve: markExited } = Promise.withResolvers<void>();
  const client = new RpcClient({
    cwd: project,
    lineageDir: lineage,
    ompPath: ompPath!,
    model: "probe/inert",
    configOverlays: overlays,
    spawnProcess: (bin, args, extra) => {
      // ompChildEnv's merge (which prepends the omp bin dir) stays intact;
      // only HOME scoping and the arm PATH are applied after it.
      const env: NodeJS.ProcessEnv = {
        ...extra,
        HOME: home,
        USERPROFILE: home,
        XDG_CONFIG_HOME: path.join(home, ".config"),
        XDG_DATA_HOME: path.join(home, ".local", "share"),
        OMP_WORKTREE_DIR: path.join(base, "omp-worktrees"),
        OVNFS_STATE: ovnfsState,
        OVNFS_MOUNT: ovnfsMount,
        PATH: armPath.join(path.delimiter),
      };
      for (const key of [
        "HOMEDRIVE",
        "HOMEPATH",
        "OMP_PROFILE",
        "PI_PROFILE",
        "PI_CONFIG_DIR",
        "PI_CODING_AGENT_DIR",
      ]) {
        delete env[key];
      }
      const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env });
      return {
        stdin: proc.stdin,
        stdout: proc.stdout,
        stderr: proc.stderr,
        kill: (signal) => void proc.kill(signal),
        onExit: (cb) => proc.on("exit", (code) => cb(code)),
        onSpawnError: (cb) => proc.on("error", cb),
      };
    },
    onFrame: (frame) => frames.push(frame as Frame),
    onExit: () => markExited(),
    onError: (m) => process.stderr.write(`rpc error: ${m}\n`),
  });
  return {
    ...options,
    base,
    project,
    ompWorktrees: path.join(base, "omp-worktrees"),
    ovnfsState,
    ovnfsMount,
    frames,
    client,
    exited,
  };
}

/** FUSE mountpoints (native overlays) still live anywhere under the base. */
function liveMountsUnder(base: string): string[] {
  let table: string;
  try {
    table = fs.readFileSync("/proc/mounts", "utf8");
  } catch {
    // No /proc (non-Linux host): nothing this scope mounted needs releasing.
    return [];
  }
  const mounts: string[] = [];
  for (const line of table.split("\n")) {
    const target = line.split(" ")[1];
    if (target !== undefined && target.startsWith(base + path.sep)) mounts.push(target);
  }
  return mounts;
}

async function stopScope(scope: Scope): Promise<void> {
  scope.client.kill();
  const exitedNow = await Promise.race([scope.exited.then(() => true), sleep(8_000).then(() => false)]);
  if (!exitedNow) scope.client.kill("SIGKILL");
  // Defensive: suppression means no daemon should own this state root, so a
  // stop is a no-op there; a killed native arm can still leave its overlay
  // mounted, and rmdir returns EBUSY until every mountpoint is released.
  if (ovnfsPath !== null) {
    spawnSync(ovnfsPath, ["stop"], {
      encoding: "utf8",
      env: { ...process.env, OVNFS_STATE: scope.ovnfsState, OVNFS_MOUNT: scope.ovnfsMount },
      timeout: 15_000,
    });
  }
  for (const target of liveMountsUnder(scope.base)) {
    spawnSync("fusermount3", ["-u", "-z", target], { encoding: "utf8", timeout: 10_000 });
    spawnSync("fusermount", ["-u", "-z", target], { encoding: "utf8", timeout: 10_000 });
  }
  await sleep(150);
  fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

async function ready(scope: Scope): Promise<void> {
  await waitFor(
    () => (scope.frames.some((frame) => frame.type === "ready") ? true : undefined),
    60_000,
    "omp ready",
  );
}

let requestSequence = 0;

/** The applied parent file's facts: raw bytes plus the child cwd it stamps. */
interface Applied {
  text: string;
  childCwd: string;
  /** The applied bytes with this scope's identity removed, for cross-arm compare. */
  normalized: string;
}

/** Drive the one isolated task to its applied stamp in the parent checkout. */
async function runIsolatedTask(scope: Scope): Promise<Applied> {
  requestSequence += 1;
  scope.client.send({ type: "prompt", message: ROOT_PROMPT, id: `ovnfs-live-p${requestSequence}` } as never);
  const probePath = path.join(scope.project, "src", "file.txt");
  await waitFor(
    () => (/^cwd=(.+)$/m.test(fs.readFileSync(probePath, "utf8")) ? true : undefined),
    180_000,
    "the isolated task's cwd stamp to be applied into the parent checkout",
  );
  const text = fs.readFileSync(probePath, "utf8");
  const stamped = /^cwd=(.+)$/m.exec(text);
  if (stamped === null) throw new Error(`unreachable: probe lost its stamp: ${text}`);
  return {
    text,
    childCwd: path.resolve(stamped[1]!),
    // Both arms live in their own temp base and omp mints a random slot name
    // per isolation; only that identity differs when the outcome matches.
    normalized: text.replace(scope.base, "<base>").replace(/omp-worktrees[/\\][^/\\"'\s]+/g, "omp-worktrees/<slot>"),
  };
}

/** The parent's git-visible state, with this scope's identity removed. */
function gitStateNormalized(scope: Scope): string {
  return (
    gitIn(scope.project, scope.base, ["status", "--porcelain"])
      .concat("----\n")
      .concat(gitIn(scope.project, scope.base, ["worktree", "list", "--porcelain"]))
      // Two runs live in two fresh repos: paths and commit SHAs are per-scope
      // identity (independent init commits), never part of the outcome.
      .replace(scope.base, "<base>")
      .replace(/[0-9a-f]{40}/g, "<sha>")
  );
}

/** What one full probe run leaves behind, for the cross-arm comparison. */
interface ProbeOutcome {
  applied: Applied;
  gitState: string;
  ovnfsMount: string;
  daemonStateExists: boolean;
}

/**
 * A self-contained run: build, boot, drive the isolated task, collect the
 * parent's outcome, and tear the scope down even on failure. Used by the
 * comparison case, which must hold two runs' results side by side rather than
 * leave one in the shared afterEach slot.
 */
async function runProbe(provider: ScriptedProvider, options: ScopeOptions): Promise<ProbeOutcome> {
  const probeScope = buildScope(provider, options);
  try {
    await ready(probeScope);
    const applied = await runIsolatedTask(probeScope);
    return {
      applied,
      gitState: gitStateNormalized(probeScope),
      ovnfsMount: probeScope.ovnfsMount,
      daemonStateExists: fs.existsSync(probeScope.ovnfsState),
    };
  } finally {
    await stopScope(probeScope);
  }
}

let scope: Scope | null = null;
/** Memoized daemon capability probe for the reachable arms; measured once. */
let daemonMounts: boolean | null = null;
afterEach(async () => {
  if (scope !== null) {
    await stopScope(scope);
    scope = null;
  }
});

describe.skipIf(ompPath === null || ovnfsPath === null)(
  "ADR-0089 ovnfs suppression against the real runtime (issue #1071)",
  () => {
    let version: string | null = null;
    beforeAll(async () => {
      version = await readInstalledOmpVersion(ompPath!);
    });
    const needsSuppressionTarget = (ctx: { skip: (note?: string) => void }): void => {
      if (version === null || compareVersions(version, OVNFS_AUTO_FLOOR) < 0) {
        ctx.skip(`omp ${version ?? "unknown"} predates ovnfs auto-enable (${OVNFS_AUTO_FLOOR})`);
      }
      // A reachable binary that cannot mount would fall back on its own, so a
      // suppressed result would prove nothing without a working daemon.
      if (daemonMounts === null) daemonMounts = probeOvnfsDaemon();
      if (!daemonMounts) ctx.skip("the reachable ovnfs cannot serve FUSE here");
    };

    it(
      "suppresses a reachable ovnfs: native isolation, patch applied, no daemon state",
      { timeout: 240_000 },
      async (ctx) => {
        needsSuppressionTarget(ctx);
        const provider = await scriptedProvider();
        try {
          scope = buildScope(provider, { hideOvnfs: false, globalOvnfsPin: false });
          await ready(scope);
          const worktreesBefore = gitIn(scope.project, scope.base, ["worktree", "list", "--porcelain"]);

          const applied = await runIsolatedTask(scope);

          // The child ran in omp's native slot, not below any ovnfs mount.
          expect(applied.childCwd.startsWith(path.resolve(scope.ovnfsMount) + path.sep)).toBe(false);
          expect(applied.childCwd.startsWith(path.resolve(scope.ompWorktrees) + path.sep)).toBe(true);

          // The patch still reached the parent as an ordinary tracked-file
          // change, and no daemon was ever started: its scoped roots do not
          // exist, so nothing was mounted, captured, or left to reclaim.
          expect(gitIn(scope.project, scope.base, ["status", "--porcelain"]).trim()).toBe("M src/file.txt");
          expect(fs.existsSync(scope.ovnfsState)).toBe(false);
          expect(fs.existsSync(scope.ovnfsMount)).toBe(false);

          // omp-ui's git-visible authority is untouched: the isolation slot is
          // not a registered git worktree, so the parent's worktree list never
          // changed and the checkout stayed on its own branch.
          expect(gitIn(scope.project, scope.base, ["worktree", "list", "--porcelain"])).toBe(worktreesBefore);
          expect(gitIn(scope.project, scope.base, ["branch", "--show-current"]).trim()).toBe("main");
        } finally {
          await provider.close();
        }
      },
    );

    it(
      "outranks a user's global ovnfs.path naming the real binary: PATH alone finds nothing",
      { timeout: 240_000 },
      async (ctx) => {
        needsSuppressionTarget(ctx);
        const provider = await scriptedProvider();
        try {
          // The hardest case ADR-0089 must survive: discovery succeeds through
          // the user's own global agent config, not PATH. hideOvnfs strips
          // every ovnfs-bearing PATH dir, so a PATH walk finds nothing and the
          // ONLY thing that could enable ovnfs here is that global layer —
          // which the per-lineage `--config` overlay must outrank.
          scope = buildScope(provider, { hideOvnfs: true, globalOvnfsPin: true });
          await ready(scope);

          const applied = await runIsolatedTask(scope);
          expect(applied.childCwd.startsWith(path.resolve(scope.ovnfsMount) + path.sep)).toBe(false);
          expect(applied.childCwd.startsWith(path.resolve(scope.ompWorktrees) + path.sep)).toBe(true);
          expect(fs.existsSync(scope.ovnfsState)).toBe(false);
          expect(fs.existsSync(scope.ovnfsMount)).toBe(false);
        } finally {
          await provider.close();
        }
      },
    );

    it(
      "leaves the no-ovnfs fallback byte-identical: same patch, same git state",
      { timeout: 480_000 },
      async (ctx) => {
        needsSuppressionTarget(ctx);
        // One run with ovnfs reachable but pinned off, one with it unfindable:
        // the suppression must be behavior-neutral where discovery would have
        // found nothing anyway. Both scopes live inside this case only.
        const armedProvider = await scriptedProvider();
        let suppressed: ProbeOutcome;
        try {
          suppressed = await runProbe(armedProvider, { hideOvnfs: false, globalOvnfsPin: false });
        } finally {
          await armedProvider.close();
        }
        expect(suppressed.daemonStateExists).toBe(false);

        const plainProvider = await scriptedProvider();
        try {
          const plain = await runProbe(plainProvider, { hideOvnfs: true, globalOvnfsPin: false });
          expect(plain.applied.childCwd.startsWith(path.resolve(plain.ovnfsMount) + path.sep)).toBe(false);
          expect(plain.daemonStateExists).toBe(false);
          // Same applied bytes and same git-visible state as the suppressed
          // run: the pin changes nothing where discovery had nothing to find.
          expect(plain.applied.normalized).toBe(suppressed.applied.normalized);
          expect(plain.gitState).toBe(suppressed.gitState);
        } finally {
          await plainProvider.close();
        }
      },
    );
  },
);
