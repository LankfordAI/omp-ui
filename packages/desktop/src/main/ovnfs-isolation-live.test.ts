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
 * The ovnfs arm of omp 18.17's task isolation against the REAL
 * `omp --mode=rpc-ui`, with a REAL ovnfs daemon and mount (issue #1071).
 * 18.17 auto-enables ovnfs whenever its binary is found (`ovnfs.path`, else
 * `ovnfs` on PATH): an allowed isolated task with `isolation.backend: auto`
 * then runs in a daemon-managed checkout instead of a native clone, and
 * omp-ui's worktree pins (`worktree.onStart: off`, `worktree.onExit: keep`)
 * do not gate that choice. This file is the live certificate for what #1071
 * asked to verify:
 *
 * - ovnfs arm: the isolated subagent really runs below the daemon mount (its
 *   own bash `$PWD`, captured as data into the applied patch, sits under
 *   `OVNFS_MOUNT`), omp's isolation runner still captures the child edit and
 *   applies it to the parent checkout, and the provider sees omp inject the
 *   separate-checkout system-prompt directive from discovery alone — a
 *   dedicated case runs the plain session overlays with
 *   `task.isolation.enabled` at OMP's default false, so no task can even be
 *   isolated there — telling every agent to use daemon checkouts instead of
 *   `git worktree add`/`git clone`/`cp -r`. The retained checkout and its
 *   `.omp-ovnfs-checkout.json` sidecar outlive a settled parent on both
 *   ends: no omp-ui surface adopts or reclaims them;
 * - native arm: with no ovnfs reachable on the child's PATH, the identical
 *   overlays and task produce the identical parent-visible result through the
 *   native backend, the directive is absent from the prompt, and the ovnfs
 *   state root is never even created — the fallback stays the pre-18.17 path;
 * - both arms: the real `writeWorktreeOverlay` bytes are in force and the
 *   parent's `git worktree list --porcelain` never changes, so an agent-side
 *   ovnfs checkout never registers as a git worktree omp-ui would adopt.
 *
 * Everything ovnfs touches is scoped to the temp base: `OVNFS_STATE`/
 * `OVNFS_MOUNT` (the daemon's own env overrides) keep its state and mount
 * under this scope, so no user `~/.local/state/ovnfs` or `~/checkouts` is
 * used and no global config is written. The ovnfs binary is never installed
 * by this test: it must already exist at `$OMP_UI_OVNFS_BIN` or on PATH. The
 * whole file skips cleanly when it (or the omp binary) is missing, so CI —
 * where no ovnfs exists — is unaffected.
 *
 * Real timers throughout: the awaited actors are OS processes (omp, the
 * ovnfs daemon), so fake clocks cannot drive them; every wait polls an
 * observed condition, never a guessed duration.
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

/** Isolation is opt-in per install; this overlay is the arm's only elevation. */
const ISOLATION_OVERLAY = "task:\n  isolation:\n    enabled: true\n";

/** A prompt that earns a plain `ok` from the script: one turn, no tool call. */
const PLAIN_PROMPT = "PLAIN-TURN-NO-TOOLS";

interface Frame {
  type: string;
  id?: string;
  success?: boolean;
}

interface Scope {
  base: string;
  project: string;
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
      context: "Live ovnfs isolation probe.",
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
 * The subagent's one bash call. `$PWD` is stamped INTO the written file, so
 * the patch omp applies back to the parent carries — as data observed from
 * the real shell — the exact directory the child ran in.
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
  /** Every request body received, verbatim: the system-prompt oracle. */
  bodies: string[];
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
  const bodies: string[] = [];
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
        bodies.push(Buffer.concat(parts).toString("utf8"));
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
          chunk({ role: "assistant", tool_calls: [BASH_CALL] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n",
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
    bodies,
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
 * Whether a daemon can actually mount here: an installed binary still needs
 * working FUSE, and a container without it must skip the ovnfs arm instead of
 * failing it. Starts one throwaway daemon under its own temp state/mount and
 * stops it again; nothing outside the temp dir is touched.
 */
function probeOvnfsDaemon(): boolean {
  if (ovnfsPath === null) return false;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-ovnfs-cap-"));
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      OVNFS_STATE: path.join(base, "state"),
      OVNFS_MOUNT: path.join(base, "mount"),
    };
    const start = spawnSync(ovnfsPath, ["--json", "start"], { encoding: "utf8", env, timeout: 30_000 });
    if (start.status !== 0) return false;
    let status: Record<string, unknown> | null = null;
    try {
      status = JSON.parse(start.stdout) as Record<string, unknown>;
    } catch {
      return false;
    }
    spawnSync(ovnfsPath, ["stop"], { encoding: "utf8", env, timeout: 15_000 });
    return status.version === 5;
  } catch {
    return false;
  } finally {
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

/** `"ovnfs"`: the binary is reachable on the child's PATH; `"native"`: not. */
type Backend = "ovnfs" | "native";

/**
 * One hermetic scope: a git project, a lineage dir carrying the REAL omp-ui
 * worktree overlay (plus, for the isolation cases, the isolation opt-in), an
 * ovnfs state/mount pair that lives only under this temp base, and a PATH
 * whose first entry (the arm's bin dir with the symlinked `ovnfs`) decides
 * which backend omp's `auto` picks. The native arm strips every directory
 * holding the located binary from PATH, so it stays the no-ovnfs arm even on
 * a machine that has one.
 */
function buildScope(provider: ScriptedProvider, backend: Backend, isolation = true): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-ovnfs-live-"));
  const home = path.join(base, "home");
  const agentDir = path.join(home, ".omp", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.yml"), MODELS_YML(provider.baseUrl));
  fs.writeFileSync(path.join(agentDir, "config.yml"), CONFIG_YML);

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

  if (backend === "ovnfs") {
    fs.symlinkSync(ovnfsPath!, path.join(childBin, "ovnfs"));
  }
  // The arm's PATH decides which factory omp's `auto` resolves. The native
  // arm strips EVERY directory that holds an executable ovnfs — not just the
  // located one — so it stays a genuine no-ovnfs machine even here.
  const ovnfsDirs = pathDirsWithOvnfs();
  const inheritedPath = (process.env.PATH ?? "").split(path.delimiter);
  const armPath =
    backend === "ovnfs" ? [childBin, ...inheritedPath] : inheritedPath.filter((dir) => !ovnfsDirs.has(dir));

  // Exactly what a real spawn carries: the omp-ui worktree pins, plus (for
  // the isolation cases) the isolation opt-in as a second --config overlay.
  const worktreeOverlay = writeWorktreeOverlay(lineage);
  const overlays = [worktreeOverlay];
  if (isolation) {
    const isolationOverlay = path.join(lineage, "omp-ui-isolation-probe.yml");
    fs.writeFileSync(isolationOverlay, ISOLATION_OVERLAY);
    overlays.push(isolationOverlay);
  }

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
      for (const key of ["HOMEDRIVE", "HOMEPATH", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR", "PI_CODING_AGENT_DIR"]) {
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
  return { base, project, ovnfsState, ovnfsMount, frames, client, exited };
}

/** Sidecar dirs (`omp worktree clear`'s retry markers) under this scope. */
function sidecarDirs(scope: Scope): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name === ".omp-ovnfs-checkout.json") found.push(dir);
    }
  };
  try {
    walk(path.join(scope.base, "omp-worktrees"));
  } catch {
    // No omp worktree dir at all: no sidecars.
  }
  return found;
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
  if (ovnfsPath !== null) {
    // Tear down only this scope's daemon; the env selects its state root.
    spawnSync(ovnfsPath, ["stop"], {
      encoding: "utf8",
      env: { ...process.env, OVNFS_STATE: scope.ovnfsState, OVNFS_MOUNT: scope.ovnfsMount },
      timeout: 15_000,
    });
  }
  // A killed parent can leave its native overlay mounted (issue #17644's
  // shape): release every mountpoint under the base before removing it, or
  // rmdir returns EBUSY and the scope leaks.
  for (const target of liveMountsUnder(scope.base)) {
    spawnSync("fusermount3", ["-u", "-z", target], { encoding: "utf8", timeout: 10_000 });
    spawnSync("fusermount", ["-u", "-z", target], { encoding: "utf8", timeout: 10_000 });
  }
  await sleep(150);
  fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

let requestSequence = 0;
async function ready(scope: Scope): Promise<void> {
  await waitFor(
    () => (scope.frames.some((frame) => frame.type === "ready") ? true : undefined),
    60_000,
    "omp ready",
  );
}

/** `ovnfs --json status` for this scope's state root; null when none answers. */
function ovnfsStatus(scope: Scope): Record<string, unknown> | null {
  if (ovnfsPath === null) return null;
  const run = spawnSync(ovnfsPath, ["--json", "status"], {
    encoding: "utf8",
    env: { ...process.env, OVNFS_STATE: scope.ovnfsState, OVNFS_MOUNT: scope.ovnfsMount },
    timeout: 15_000,
  });
  if (run.status !== 0) return null;
  try {
    return JSON.parse(run.stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Drive the one isolated task to its applied stamp and return the child cwd. */
async function runIsolatedTask(scope: Scope): Promise<string> {
  requestSequence += 1;
  scope.client.send({ type: "prompt", message: ROOT_PROMPT, id: `ovnfs-live-p${requestSequence}` } as never);
  const probePath = path.join(scope.project, "src", "file.txt");
  await waitFor(
    () => (/^cwd=(.+)$/m.test(fs.readFileSync(probePath, "utf8")) ? true : undefined),
    180_000,
    "the isolated task's cwd stamp to be applied into the parent checkout",
  );
  const stamped = /^cwd=(.+)$/m.exec(fs.readFileSync(probePath, "utf8"));
  return path.resolve(stamped![1]!);
}

/**
 * Whether any request body carries omp's separate-checkout directive. Its
 * opening line, verbatim from the system prompt omp/18.17.0 sends when its
 * ovnfs discovery succeeds: discovery ALONE (no isolation overlay needed)
 * instructs every agent to open daemon checkouts instead of git worktrees.
 */
function bodyDirectsOvnfs(provider: ScriptedProvider): boolean {
  return provider.bodies.some((body) =>
    body.includes("MUST use an ovnfs checkout, not `git worktree add`, `git clone` or `cp -r`"),
  );
}

let scope: Scope | null = null;
/** Memoized FUSE capability probe for the ovnfs arm; measured once per run. */
let daemonMounts: boolean | null = null;
afterEach(async () => {
  if (scope !== null) {
    await stopScope(scope);
    scope = null;
  }
});

describe.skipIf(ompPath === null || ovnfsPath === null)(
  "ovnfs task isolation against the real runtime (issue #1071)",
  () => {
    let version: string | null = null;
    beforeAll(async () => {
      version = await readInstalledOmpVersion(ompPath!);
    });
    const needsOvnfsAuto = (ctx: { skip: (note?: string) => void }): void => {
      if (version === null || compareVersions(version, OVNFS_AUTO_FLOOR) < 0) {
        ctx.skip(`omp ${version ?? "unknown"} predates ovnfs auto-enable (${OVNFS_AUTO_FLOOR})`);
      }
    };

    it(
      "runs the isolated task below a live ovnfs mount and applies its patch to the parent",
      { timeout: 240_000 },
      async (ctx) => {
        needsOvnfsAuto(ctx);
        // A reachable binary still cannot serve without working FUSE; a
        // confined machine skips this arm rather than failing it.
        if (daemonMounts === null) daemonMounts = probeOvnfsDaemon();
        if (!daemonMounts) ctx.skip("the ovnfs daemon cannot mount on this machine");
        const provider = await scriptedProvider();
        try {
          scope = buildScope(provider, "ovnfs");
          await ready(scope);
          const worktreesBefore = gitIn(scope.project, scope.base, ["worktree", "list", "--porcelain"]);

          const childCwd = await runIsolatedTask(scope);

          // The child really ran below the daemon mount: its shell's own $PWD
          // sits under this scope's OVNFS_MOUNT.
          const mountRoot = path.resolve(scope.ovnfsMount);
          expect(childCwd.startsWith(mountRoot + path.sep)).toBe(true);

          // The daemon that served it speaks omp's required admin protocol,
          // and while the parent session lives the checkout is RETAINED (the
          // keepAlive path): the sidecar `omp worktree clear` retries from is
          // present and the daemon still lists the checkout. Values observed
          // on omp/18.17.0 + ovnfs v0.1.1; a change here moves the boundary
          // this file certifies, so it must fail loudly.
          const whileLive = ovnfsStatus(scope);
          expect(whileLive?.version).toBe(5);
          expect(Number(whileLive?.checkouts)).toBeGreaterThanOrEqual(1);
          expect(sidecarDirs(scope)).toHaveLength(1);

          // Settle the parent the way omp-ui's Settle does (SIGTERM, then
          // SIGKILL past the grace). A clean omp exit releases nothing on
          // this path either: the daemon keeps the checkout registered and
          // the sidecar survives — no omp-ui surface adopts or reclaims it.
          // The 2 s grace waits for an ABSENCE of change, so no poll applies.
          scope.client.kill();
          const exitedNow = await Promise.race([scope.exited.then(() => true), sleep(8_000).then(() => false)]);
          if (!exitedNow) scope.client.kill("SIGKILL");
          await sleep(2_000);
          expect(sidecarDirs(scope)).toHaveLength(1);
          expect(Number(ovnfsStatus(scope)?.checkouts)).toBeGreaterThanOrEqual(1);

          // omp-ui's git-visible authority surfaces are unchanged: the daemon
          // checkout never registered as a git worktree of the parent (no new
          // `worktree list` entry ever appeared), the applied stamp shows up
          // as an ordinary dirty tracked file, and the project checkout is
          // still on its own branch.
          expect(gitIn(scope.project, scope.base, ["worktree", "list", "--porcelain"])).toBe(worktreesBefore);
          expect(gitIn(scope.project, scope.base, ["status", "--porcelain"]).trim()).toBe("M src/file.txt");
          expect(gitIn(scope.project, scope.base, ["branch", "--show-current"]).trim()).toBe("main");

          // The general separate-checkout guidance is live: the provider saw
          // omp's system prompt ORDER the agent to open ovnfs checkouts
          // instead of `git worktree add`/`git clone`/`cp -r`. This fires
          // from discovery alone — it is the authority gap's widest surface,
          // wider than the isolated-task selection this arm also proves.
          expect(bodyDirectsOvnfs(provider)).toBe(true);
        } finally {
          await provider.close();
        }
      },
    );

    it(
      "injects the separate-checkout directive from discovery alone, with no isolation overlay",
      { timeout: 120_000 },
      async (ctx) => {
        needsOvnfsAuto(ctx);
        if (daemonMounts === null) daemonMounts = probeOvnfsDaemon();
        if (!daemonMounts) ctx.skip("the ovnfs daemon cannot mount on this machine");
        const provider = await scriptedProvider();
        try {
          // The overlay set an ordinary omp-ui session gets: the worktree
          // pins and nothing else. task.isolation.enabled stays at omp's
          // default (false), so no isolated task can run here at all.
          scope = buildScope(provider, "ovnfs", false);
          await ready(scope);
          requestSequence += 1;
          scope.client.send({ type: "prompt", message: PLAIN_PROMPT, id: `ovnfs-live-p${requestSequence}` } as never);
          await waitFor(() => (provider.bodies.length > 0 ? true : undefined), 60_000, "the scripted turn's request");

          expect(bodyDirectsOvnfs(provider)).toBe(true);
          // Discovery changed the prompt without touching git or starting a
          // checkout: no daemon state exists yet.
          expect(fs.existsSync(scope.ovnfsState)).toBe(false);
        } finally {
          await provider.close();
        }
      },
    );

    it(
      "keeps the native fallback identical when no ovnfs is reachable and starts no daemon",
      { timeout: 240_000 },
      async (ctx) => {
        needsOvnfsAuto(ctx);
        const provider = await scriptedProvider();
        try {
          scope = buildScope(provider, "native");
          await ready(scope);
          const worktreesBefore = gitIn(scope.project, scope.base, ["worktree", "list", "--porcelain"]);

          const childCwd = await runIsolatedTask(scope);

          // Same parent-visible result, but through the native backend: the
          // child cwd is neither the parent checkout nor anything under an
          // ovnfs mount (the isolation clone lives under OMP_WORKTREE_DIR).
          expect(childCwd.startsWith(path.resolve(scope.ovnfsMount) + path.sep)).toBe(false);
          expect(childCwd).not.toBe(path.resolve(scope.project));
          expect(gitIn(scope.project, scope.base, ["status", "--porcelain"]).trim()).toBe("M src/file.txt");

          // The daemon was never consulted: its scoped state root does not
          // even exist, so discovery found nothing and fell back.
          expect(fs.existsSync(scope.ovnfsState)).toBe(false);
          expect(fs.existsSync(scope.ovnfsMount)).toBe(false);

          expect(gitIn(scope.project, scope.base, ["worktree", "list", "--porcelain"])).toBe(worktreesBefore);
          // The fallback's system prompt is the pre-18.17 one: with no ovnfs
          // reachable, the separate-checkout directive is absent, so agents
          // keep omp-ui's worktree conventions untouched.
          expect(bodyDirectsOvnfs(provider)).toBe(false);
        } finally {
          await provider.close();
        }
      },
    );
  },
);
