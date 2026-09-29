import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RpcClient,
  getWatchdogRoster,
  resolveOmpBinary,
  writeAdvisorOverlay,
  writeAdvisorStatsExtension,
  writePlanExtension,
} from "@omp-ui/core";
import { ADVISOR_STATS_KEY, parseAdvisorStats, type AdvisorStatsView } from "@omp-ui/core/advisor-stats";
import type { WatchdogRosterResult } from "@omp-ui/core/types";

/**
 * ADR-0039 parity check: omp's live advisor roster (published by the
 * advisor-stats bridge) and omp-ui's own WATCHDOG.yml catalog
 * (`getWatchdogRoster().effective`, ADR-0039's bridge-truth model) MUST name
 * the same advisors. This is the drift guard the ADR promises: if omp's
 * discovery, merge, or status rules change shape, the name sets (and the
 * machine-independent `paused` / `no_model` statuses) diverge and this fails.
 *
 * Needs oauth (the command handler only runs once a session can prompt — an
 * oauth-free boot emits no extension frames at all), so it reuses the
 * advisor-stats-live spawn/retry/skip harness, and overrides HOME/XDG at spawn
 * (capability-control-live pattern) so the real binary reads the fixture user
 * file instead of the developer's `~/.omp`. Skips cleanly when the binary or an
 * oauth session is unavailable.
 */

interface Frame {
  type: string;
  statusKey?: string;
  statusText?: string;
}

/** These are real timers on purpose: the thing being polled is a real OS
 *  process speaking over pipes — a fake clock cannot make it publish. Every
 *  wait below ends on an observed frame condition, never a tuned sleep. */
function sleep(ms: number): Promise<void> {
  // Promise.withResolvers needs ES2024; the node tsconfig lib predates it.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `probe` until non-undefined or the timeout elapses. */
async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

// Oauth readiness depends on machine load and oauth timing, so these budgets
// are deliberately generous; exhausting them means the environment cannot
// produce an oauth session, which skips the test rather than failing it (#86).
const OAUTH_READY_TIMEOUT_MS = 60_000;
const OAUTH_ATTEMPTS = 2;

/** Marks "the environment could not produce an oauth session" — the suite
 *  skips on this instead of failing. */
class OauthUnavailable extends Error {}

/** Skips the running test when oauth can't be produced; rethrows anything else. */
function skipIfOauthUnavailable(ctx: { skip: (reason?: string) => never }, error: unknown): void {
  if (error instanceof OauthUnavailable) ctx.skip(error.message);
  throw error;
}

const ompPath = resolveOmpBinary();

interface Scope {
  base: string;
  home: string;
  lineage: string;
}

interface Harness {
  client: RpcClient;
  /** Parsed stats frames published by THIS process only (since its spawn). */
  statsFrames(): AdvisorStatsView[];
  /** Any response frames from THIS process (indexed from its spawn). */
  seenResponse(): boolean;
  /** Signals the child and resolves once it has actually exited. */
  kill(): Promise<void>;
}

/**
 * The fixture roster. User scope: alpha (plain), beta (`enabled: false` →
 * bridge status "paused"), gamma (`model: nosuch/nope` → "no_model",
 * machine-independent by construction). Project scope: alpha again (the
 * per-name override) and delta with `tools: [read]`.
 */
const USER_WATCHDOG = `advisors:
  - name: alpha
  - name: beta
    enabled: false
  - name: gamma
    model: nosuch/nope
`;

const PROJECT_WATCHDOG = `instructions: project instructions
advisors:
  - name: alpha
  - name: delta
    tools:
      - read
`;

function makeScope(): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-wdlive-"));
  const home = path.join(base, "home");
  const agentDir = path.join(home, ".omp", "agent");
  const lineage = path.join(base, "lin");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(lineage, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "WATCHDOG.yml"), USER_WATCHDOG);
  // `base` doubles as the omp cwd, so this is the project-scope file.
  fs.writeFileSync(path.join(base, "WATCHDOG.yml"), PROJECT_WATCHDOG);
  // omp's `Gcn` discovers WATCHDOG.md beside the .yml; the catalog must list
  // it while omp stays warning-free with the file present (#691).
  fs.writeFileSync(path.join(base, "WATCHDOG.md"), "Watch module boundaries; verify before approving.");
  return { base, home, lineage };
}

/** The env the roster catalog is read with: the fixture HOME and agent dir. */
function rosterEnv(scope: Scope): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: scope.home,
    PI_CODING_AGENT_DIR: path.join(scope.home, ".omp", "agent"),
  };
}

/**
 * Deletes a scope tree. Retries because a straggler write between the child's
 * exit and the walk still surfaces as ENOTEMPTY (#123) — `force` forgives a
 * missing path, not a directory being written to.
 */
function removeScope(scope: Scope): void {
  fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

// SIGTERM only asks omp to stop; it can still be flushing the session file
// under the lineage dir afterwards. Deleting the scope during that window is
// what made teardown flake with ENOTEMPTY (#123).
const EXIT_GRACE_MS = 5_000;

/**
 * Resolves once the child has exited, escalating to SIGKILL after the grace
 * period. Gives up at twice the grace rather than hanging the suite — a child
 * that never spawned has no exit to deliver, and `removeScope`'s retries are
 * the backstop for whatever is left on disk.
 */
function awaitExit(client: RpcClient, exited: Promise<void>): Promise<void> {
  return new Promise((resolve) => {
    const escalate = setTimeout(() => client.kill("SIGKILL"), EXIT_GRACE_MS);
    const abandon = setTimeout(resolve, EXIT_GRACE_MS * 2);
    void exited.then(() => {
      clearTimeout(escalate);
      clearTimeout(abandon);
      resolve();
    });
  });
}

function spawnHarness(scope: Scope): Harness {
  const extension = writeAdvisorStatsExtension(scope.lineage);
  const planExt = writePlanExtension(scope.lineage);
  const overlay = writeAdvisorOverlay(scope.lineage, null, true);
  if (!overlay) throw new Error("advisor overlay was not written");
  let killed = false;
  // Promise.withResolvers would read better but needs ES2024; the node
  // tsconfig targets ES2022 (same reason as `sleep` above).
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  // Frames live only in this harness: the scope is spawned at most once here.
  const frames: Frame[] = [];
  const client = new RpcClient({
    cwd: scope.base,
    lineageDir: scope.lineage,
    ompPath: ompPath!,
    advisor: true,
    configOverlays: [overlay],
    extensions: [planExt, extension],
    // capability-control-live pattern: the real binary must read the fixture
    // user file, not the developer's `~/.omp`.
    spawnProcess: (bin, args, extra) => {
      const proc = spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...extra,
          HOME: scope.home,
          XDG_CONFIG_HOME: path.join(scope.home, ".config"),
          XDG_DATA_HOME: path.join(scope.home, ".local", "share"),
        },
      });
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
    onError: () => {},
  });
  return {
    client,
    statsFrames: () =>
      frames
        .filter((f) => f.type === "extension_ui_request" && f.statusKey === ADVISOR_STATS_KEY)
        .map((f) => parseAdvisorStats(f.statusText))
        .filter((v): v is AdvisorStatsView => v !== null),
    seenResponse: () => frames.some((f) => f.type === "response"),
    kill: async () => {
      if (!killed) {
        killed = true;
        client.kill();
      }
      await awaitExit(client, exited);
    },
  };
}

/** Boots omp and waits for its oauth-ready response, retrying the whole
 *  spawn a bounded number of times before declaring oauth unavailable. */
async function spawnOauthReady(scope: Scope): Promise<Harness> {
  let lastError: unknown;
  for (let attempt = 0; attempt < OAUTH_ATTEMPTS; attempt++) {
    const harness = spawnHarness(scope);
    try {
      await waitFor(
        () => (harness.seenResponse() ? true : undefined),
        OAUTH_READY_TIMEOUT_MS,
        "oauth ready response",
      );
      return harness;
    } catch (error) {
      lastError = error;
      await harness.kill();
    }
  }
  throw new OauthUnavailable(`oauth session never became ready: ${String(lastError)}`);
}

const disposers: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

describe.skipIf(!ompPath)("watchdog roster parity live (real omp)", () => {
  it("bridge roster and WATCHDOG.yml catalog name the same advisors", { timeout: 180_000 }, async (ctx) => {
    const scope = makeScope();
    disposers.push(() => removeScope(scope));
    let harness: Harness;
    try {
      harness = await spawnOauthReady(scope);
    } catch (error) {
      return skipIfOauthUnavailable(ctx, error);
    }
    let view: AdvisorStatsView;
    let catalog: Extract<WatchdogRosterResult, { status: "available" }>;
    try {
      harness.client.send({ type: "prompt", message: "/omp-ui-advisor-stats" });
      view = await waitFor(
        () => harness.statsFrames().find((v) => v.available && v.advisors.length > 0),
        30_000,
        "an available advisor-stats frame with a non-empty roster",
      );
      expect(
        view.configWarnings,
        `unexpected config warnings: ${JSON.stringify(view.configWarnings)}`,
      ).toEqual([]);
      const catalogResult = await getWatchdogRoster(scope.base, rosterEnv(scope), scope.home);
      if (catalogResult.status !== "available") throw new Error(`roster read failed: ${catalogResult.message}`);
      catalog = catalogResult;
    } finally {
      await harness.kill();
    }

    // The .md instruction file is live for omp (attention block) yet must
    // surface in the catalog with no advisor or warning drift (#691).
    expect(catalog.sharedInstructions).toContain(path.join(scope.base, "WATCHDOG.md"));
    // The ADR-0039 parity claim itself: same advisor names on both sides.
    expect(new Set(view.advisors.map((a) => a.name))).toEqual(
      new Set(catalog.effective.map((a) => a.name)),
    );

    // Machine-independent status pairings, matched by name — never by index.
    const bridge = (name: string) => view.advisors.find((a) => a.name === name);
    const entry = (name: string) => catalog.effective.find((a) => a.name === name);

    expect(bridge("beta")?.status).toBe("paused");
    expect(entry("beta")?.enabled).toBe(false);

    expect(bridge("gamma")?.status).toBe("no_model");
    expect(entry("gamma")?.model).toBe("nosuch/nope");

    // alpha/delta statuses are deliberately not asserted: a healthy status
    // depends on the machine's resolvable fallback model and would flake.
    // Their names are already covered by the set equality above.
  });
});
