/**
 * Production adapters for the lite member's fleet legs (issue #1010).
 *
 * Desktop modules reach this file ONLY through the built session bundle
 * (`bundle-artifact.ts` → `dist/session-bundle.mjs`, whose entry re-exports
 * fleet-shell / fleet-detached-exec / fleet-terminals / main-log). Source-path
 * runtime imports would resolve under tsx but not inside the SEA artifact, so
 * they are forbidden here; static `import type` of desktop shapes stays fine
 * (erased at build — no package dependency on @omp-ui/desktop). The bundle's
 * electron-drift-gate keeps the artifact itself honest.
 *
 * Reimplemented glue (kept byte-faithful to the desktop member's behavior):
 * - the bounded exec runner (`runFleetCommand`): fleet-server.ts cannot be
 *   imported here because its version-update path pulls `app-update.ts`,
 *   which imports electron. The detached owner, terminal host, and shell
 *   launcher ARE electron-free and are used as-is through the bundle.
 * - clone/register/projectFiles bodies (FleetServer's private methods): same
 *   reasons, same refusal strings — an owner's UI quotes them verbatim.
 */
import { execFile as execFileCb } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadSessionBundle } from "../bundle-artifact";
import {
  FLEET_CLONE_TIMEOUT_MS,
  FLEET_EXEC_OUTPUT_MAX,
  FLEET_EXEC_TIMEOUT_MIN_MS,
  FLEET_EXEC_TIMEOUT_MS,
  detectHostOs,
  detectPackageManagers,
  ompPinActive,
  readInstalledOmpVersion,
  resolveOmpBinary,
  resolveRepositoryKey,
  sampleHostResources,
} from "@omp-ui/core";
import type {
  FleetAuditEntry,
  FleetExecOutcome,
  FleetHostProject,
  FleetProjectFilesOutcome,
  FleetProjectManageOutcome,
  ProjectRecord,
} from "@omp-ui/core";
import type {
  DetachedExecRecord,
  FleetDetachedExecs,
} from "../../../desktop/src/main/fleet-detached-exec";
import type {
  FleetCommandDeps,
  launchFleetShell,
  messageOf,
  resolveFleetCwd,
} from "../../../desktop/src/main/fleet-shell";
import type { FleetTerminals } from "../../../desktop/src/main/fleet-terminals";
import type { appendMainLog } from "../../../desktop/src/main/main-log";
import type {
  FleetExecCommandSpec,
  FleetExecLegs,
  FleetHostReportLegs,
  FleetProjectLegs,
  FleetTerminalLegs,
} from "./types.js";

/** The audit-ring writer `registerFleetLegs` also feeds (see createAuditRing). */
export type LiteAuditFn = (entry: FleetAuditEntry) => void;

/**
 * The subset of the session bundle this file loads, typed against the desktop
 * sources it mirrors. Every member is a top-level `import type` binding
 * referenced through `typeof` (all erased), so the view is exact without any
 * runtime dependency on @omp-ui/desktop; drift between the bundle entry's
 * re-exports and this view fails at use with a TypeError naming the missing
 * symbol, and S4's register-fleet-legs tests catch any behavior gap.
 */
interface LegsBundle {
  launchFleetShell: typeof launchFleetShell;
  messageOf: typeof messageOf;
  resolveFleetCwd: typeof resolveFleetCwd;
  FleetDetachedExecs: typeof FleetDetachedExecs;
  FleetTerminals: typeof FleetTerminals;
  appendMainLog: typeof appendMainLog;
}

// ── exec ────────────────────────────────────────────────────────────────────

export interface ExecAdapterDeps {
  commandDeps?: FleetCommandDeps;
  /** Finish-audit writer (the ring); mirrors FleetServer's onFinish mapping. */
  onExecFinish?: LiteAuditFn;
  /** Session-bundle artifact override (tests build one on demand; production uses the installed default). */
  bundlePath?: string;
}

export async function createExecLegs(deps: ExecAdapterDeps = {}): Promise<FleetExecLegs> {
  // Single sanctioned boundary: the built session bundle re-exports these
  // electron-free desktop modules (see bundle-artifact.ts). A static import of
  // desktop source would hard-wire the package graph the integration forbids
  // and cannot resolve inside the SEA artifact.
  const bundle = await loadSessionBundle<LegsBundle>(deps.bundlePath);
  const { launchFleetShell, messageOf, resolveFleetCwd, FleetDetachedExecs } = bundle;

  // Byte-faithful port of fleet-server.ts's runFleetCommand (electron-poisoned
  // module; see header). Fresh child, no PTY, byte caps before decode, hard
  // timeout with a tree kill; refusals ride the outcome.
  const run = (spec: FleetExecCommandSpec): Promise<FleetExecOutcome> => {
    const timeoutMs =
      spec.timeoutMs === null
        ? FLEET_EXEC_TIMEOUT_MS
        : Math.min(FLEET_EXEC_TIMEOUT_MS, Math.max(FLEET_EXEC_TIMEOUT_MIN_MS, Math.floor(spec.timeoutMs)));
    const resolved = resolveFleetCwd(spec.cwd, deps.commandDeps?.homeDir ?? os.homedir);
    if (!resolved.ok) return Promise.resolve({ status: "refused", reason: resolved.reason });
    const sinks = { stdout: { chunks: [] as Buffer[], length: 0 }, stderr: { chunks: [] as Buffer[], length: 0 } };
    let truncated = false;
    let timedOut = false;
    const handle = launchFleetShell(spec.command, resolved.cwd, deps.commandDeps ?? {}, (stream, data) => {
      const sink = sinks[stream];
      const room = FLEET_EXEC_OUTPUT_MAX - sink.length;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const keep = data.subarray(0, room);
      sink.chunks.push(keep);
      sink.length += keep.length;
      if (keep.length < data.length) truncated = true;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      handle.kill();
    }, timeoutMs);
    return handle.done.then(
      ({ exitCode, spawnError }): FleetExecOutcome => {
        clearTimeout(timer);
        return {
          status: "accepted",
          exitCode,
          stdout: Buffer.concat(sinks.stdout.chunks).toString("utf8"),
          stderr: spawnError === null ? Buffer.concat(sinks.stderr.chunks).toString("utf8") : spawnError,
          truncated,
          timedOut,
        };
      },
      (err: unknown): FleetExecOutcome => {
        clearTimeout(timer);
        return { status: "refused", reason: `could not start the shell: ${messageOf(err)}` };
      },
    );
  };

  const detached = new FleetDetachedExecs({
    commandDeps: deps.commandDeps,
    onFinish: (rec: DetachedExecRecord) =>
      deps.onExecFinish?.({
        at: new Date().toISOString(),
        dispatcherId: rec.requester.instanceId,
        dispatcherLabel: rec.requester.label,
        sourceTabId: rec.requester.sourceTabId,
        action: "exec-detached",
        rung: rec.rung,
        accepted: true,
        detail: `${rec.execId.slice(0, 8)} ${rec.state}`,
        exitCode: rec.exitCode,
      }),
  });

  return {
    run,
    start: (requester, rung, spec) => detached.start(requester, rung, spec),
    poll: (requester, execId, waitMs, cancel) => detached.poll(requester, execId, waitMs, cancel),
    revokeWhere: (stillAllowed) => detached.revokeWhere(stillAllowed),
    dispose: () => detached.dispose(),
  };
}

// ── terminals ───────────────────────────────────────────────────────────────

export interface TerminalAdapterDeps {
  /** Fans member terminal events to this host's socket clients, never a window. */
  sendToClients: (channel: string, args: unknown[]) => void;
  /** End-audit writer (the ring); mirrors FleetServer's onEnd mapping exactly. */
  onTerminalEnd?: LiteAuditFn;
  /** Session-bundle artifact override; production uses the installed default. */
  bundlePath?: string;
}

export async function createTerminalLegs(deps: TerminalAdapterDeps): Promise<FleetTerminalLegs> {
  // Same single bundle boundary as the exec legs (bundle-artifact.ts).
  const { FleetTerminals } = await loadSessionBundle<LegsBundle>(deps.bundlePath);
  const terminals = new FleetTerminals({
    sendToClients: deps.sendToClients,
    onEnd: (rec, reason, exitCode) =>
      deps.onTerminalEnd?.({
        at: new Date().toISOString(),
        dispatcherId: rec.requester.instanceId,
        dispatcherLabel: rec.requester.label,
        sourceTabId: rec.requester.sourceTabId,
        action: "terminal",
        rung: rec.rung,
        accepted: true,
        detail: `${rec.terminalId.slice(0, 8)} ended (${reason})`,
        exitCode,
      }),
  });
  // FleetTerminals' member-side surface already matches FleetTerminalLegs.
  return {
    open: (requester, rung, terminalId, cols, rows) => terminals.open(requester, rung, terminalId, cols, rows),
    renew: (requester, terminalIds) => terminals.renew(requester, terminalIds),
    end: (requester, terminalId) => terminals.end(requester, terminalId),
    write: (dispatcherId, terminalId, data) => terminals.write(dispatcherId, terminalId, data),
    resize: (dispatcherId, terminalId, cols, rows) => terminals.resize(dispatcherId, terminalId, cols, rows),
    revokeWhere: (stillAllowed) => terminals.revokeWhere(stillAllowed),
    dispose: () => terminals.dispose(),
  };
}

// ── project verbs ───────────────────────────────────────────────────────────

export interface ProjectAdapterDeps {
  /** The host's shared project-registration path (issue #904 rule): rejects with a user-facing reason. */
  addProject: (dir: string) => Promise<void>;
  /** Test seam for the git runs, same shape as FleetServer's execGit. */
  execGit?: (file: string, args: string[], opts: { cwd: string; timeout: number }) => Promise<{ stdout: Buffer }>;
}

export function createProjectLegs(deps: ProjectAdapterDeps): FleetProjectLegs {
  const git = (args: string[], opts: { cwd: string; timeout: number }): Promise<{ stdout: Buffer }> => {
    if (deps.execGit !== undefined) return deps.execGit("git", args, opts);
    const { promise, resolve, reject } = Promise.withResolvers<{ stdout: Buffer }>();
    execFileCb("git", args, { ...opts, maxBuffer: 1_048_576 }, (err, stdout) => {
      if (err !== null) reject(err);
      else resolve({ stdout: Buffer.from(stdout) });
    });
    return promise;
  };
  const headCommit = async (dir: string): Promise<string | null> => {
    try {
      const { stdout } = await git(["rev-parse", "HEAD"], { cwd: dir, timeout: 5_000 });
      const head = stdout.toString("utf8").trim();
      return head === "" ? null : head;
    } catch {
      return null;
    }
  };

  return {
    async clone(repositoryUrl, roots): Promise<FleetProjectManageOutcome> {
      let url: URL;
      try {
        url = new URL(repositoryUrl);
      } catch {
        return { status: "refused", reason: "repositoryUrl must be a valid URL" };
      }
      if (url.protocol !== "https:") return { status: "refused", reason: "clone accepts https URLs only" };
      if (url.username !== "" || url.password !== "") return { status: "refused", reason: "repositoryUrl must not carry credentials" };
      const segments = url.pathname.split("/").filter((s) => s !== "");
      const name = (segments[segments.length - 1] ?? "").replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]/g, "");
      if (name === "" || name === "." || name === "..") return { status: "refused", reason: "repositoryUrl has no usable repository name" };
      let dest: string | null = null;
      for (const root of roots) {
        const candidate = path.join(root, name);
        if (!fs.existsSync(candidate)) {
          dest = candidate;
          break;
        }
      }
      if (dest === null) return { status: "refused", reason: `every project root already holds a directory named ${name}` };
      try {
        await git(["clone", "--", url.toString(), dest], { cwd: path.dirname(dest), timeout: FLEET_CLONE_TIMEOUT_MS });
      } catch (err) {
        const message = errMessage(err);
        if (/timed out|ETIMEDOUT/i.test(message)) {
          return { status: "refused", reason: "clone timed out — use fleet.exec for long-running setup" };
        }
        return { status: "refused", reason: `git clone failed: ${message.split("\n")[0]}` };
      }
      try {
        await deps.addProject(dest);
      } catch (err) {
        return { status: "refused", reason: `cloned to ${dest} but registration failed: ${errMessage(err)}` };
      }
      return { status: "accepted", path: dest, headCommit: await headCommit(dest) };
    },

    async register(rawPath, roots): Promise<FleetProjectManageOutcome> {
      let real: string;
      try {
        real = fs.realpathSync(rawPath);
      } catch {
        return { status: "refused", reason: `${rawPath} does not exist on this machine` };
      }
      const underRoot = roots.some((root) => {
        let realRoot: string;
        try {
          realRoot = fs.realpathSync(root);
        } catch {
          return false;
        }
        return real === realRoot || real.startsWith(realRoot + path.sep);
      });
      if (!underRoot) return { status: "refused", reason: `${real} is not under a declared project root` };
      if (!fs.existsSync(path.join(real, ".git"))) return { status: "refused", reason: `${real} is not a git checkout (no .git)` };
      try {
        await deps.addProject(real);
      } catch (err) {
        return { status: "refused", reason: `registration failed: ${errMessage(err)}` };
      }
      return { status: "accepted", path: real, headCommit: await headCommit(real) };
    },

    async writeFiles(req, roots, isRegisteredPath): Promise<FleetProjectFilesOutcome> {
      let real: string;
      try {
        real = fs.realpathSync(req.path);
      } catch {
        return { status: "refused", reason: `${req.path} does not exist on this machine` };
      }
      const underRoot = roots.some((root) => {
        try {
          return real.startsWith(fs.realpathSync(root) + path.sep);
        } catch {
          return false;
        }
      });
      if (!underRoot) return { status: "refused", reason: `${real} is not under a declared project root` };
      if (!isRegisteredPath(real)) return { status: "refused", reason: `${real} is not a registered project` };
      const written: string[] = [];
      const failed: Array<{ path: string; reason: string }> = [];
      for (const file of req.files) {
        const target = path.join(real, ...file.path.split("/"));
        try {
          // The deepest folder that already exists must resolve inside the
          // checkout before mkdir can follow a tracked symlink out of it.
          let existing = path.dirname(target);
          while (!fs.existsSync(existing)) existing = path.dirname(existing);
          const resolved = await fs.promises.realpath(existing);
          if (resolved !== real && !resolved.startsWith(real + path.sep)) throw new Error("its folder resolves outside the checkout");
          await fs.promises.mkdir(path.dirname(target), { recursive: true });
          // "wx": refuse an existing path, including one a symlink names.
          await fs.promises.writeFile(target, Buffer.from(file.data, "base64"), { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
          written.push(file.path);
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code;
          failed.push({ path: file.path, reason: code === "EEXIST" ? "already exists in the new checkout" : errMessage(err) });
        }
      }
      return { status: "accepted", written, failed };
    },
  };
}

// ── host report probes ──────────────────────────────────────────────────────

/** The registry slice the project probe reads (a real `Registry` fits). */
export interface LiteHostRegistry {
  readonly projects: readonly ProjectRecord[];
  getSetting(key: "defaultAdvisor"): boolean;
}

export interface HostProbeDeps {
  registry: LiteHostRegistry;
  /** The composition root's session counts (SessionManager on this machine). */
  activity(): { liveSessions: number; runningTurns: number };
  /**
   * The spawn provider gate per project path. Required, never defaulted: a
   * guessed `true` would send owners work this machine cannot run.
   */
  providerReady(cwd: string): boolean;
}

/**
 * The resource/OS/package-manager probes plus the project list. Resource
 * sampling is plain node (os.cpus() deltas, /proc/meminfo on Linux) through
 * core's fleet-host; nothing here reads a window.
 */
export function createHostReportLegs(deps: HostProbeDeps): FleetHostReportLegs {
  return {
    resources: () => sampleHostResources(),
    os: () => detectHostOs(),
    packageManagers: () => detectPackageManagers(),
    ompVersion: async () => {
      const p = resolveOmpBinary();
      return p === null ? null : readInstalledOmpVersion(p);
    },
    ompPath: () => resolveOmpBinary(),
    ompPinned: () => ompPinActive(),
    activity: deps.activity,
    async projects(): Promise<FleetHostProject[]> {
      const registry = deps.registry;
      return Promise.all(
        registry.projects.map(async (project) => {
          const [repositoryKey, headCommit] = await Promise.all([
            resolveRepositoryKey(project.path).catch(() => null),
            gitHead(project.path),
          ]);
          const pinnedModel = project.defaultAdvisorModel ?? project.lastAdvisorModel;
          return {
            path: project.path,
            name: project.name,
            repositoryKey,
            headCommit,
            providerReady: deps.providerReady(project.path),
            advisor: project.lastAdvisor ?? registry.getSetting("defaultAdvisor"),
            // The desktop falls back to its advisor-defaults chain here; the
            // lite host has no renderer defaults to consult, so an unpinned
            // advisor model reports null and the owner's placement uses its
            // own default (the report field is advisory).
            advisorModel: pinnedModel ?? null,
          };
        }),
      );
    },
  };
}

async function gitHead(dir: string): Promise<string | null> {
  const { promise, resolve, reject } = Promise.withResolvers<{ stdout: Buffer }>();
  execFileCb("git", ["rev-parse", "HEAD"], { cwd: dir, timeout: 5_000, maxBuffer: 1_048_576 }, (err, stdout) => {
    if (err !== null) reject(err);
    else resolve({ stdout: Buffer.from(stdout) });
  });
  return promise.then(
    ({ stdout }: { stdout: Buffer }) => stdout.toString("utf8").trim() || null,
    () => null,
  );
}

// ── audit persistence ───────────────────────────────────────────────────────

export interface AuditSinkDeps {
  /** Session-bundle artifact override; production uses the installed default. */
  bundlePath?: string;
}

/**
 * The append-only `fleet-audit.log` sink (1 MiB rotation, ISO prefix), shared
 * with the desktop member through its electron-free main-log module. The ring
 * itself lives in `registerFleetLegs`; compose them with one audit fn per sink.
 */
export async function createAuditFileSink(logDir: string, deps: AuditSinkDeps = {}): Promise<LiteAuditFn> {
  // Same single bundle boundary as the exec/terminal legs (bundle-artifact.ts).
  const { appendMainLog } = await loadSessionBundle<LegsBundle>(deps.bundlePath);
  return (entry) => appendMainLog(logDir, "fleet-audit.log", JSON.stringify(entry));
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
