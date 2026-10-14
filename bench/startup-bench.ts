/*
 * New-session startup benchmark (autoresearch harness entry).
 *
 * Measures the wall time from `SessionManager.spawn({origin:"new", mode:"rpc-ui"})`
 * to the settle frame of the spawn's initialCommands rail — the `response` for
 * id `omp-ui-host-tools-1`, the registration command at the rail's tail
 * (the live-test pattern from host-bridge-live.test.ts). That window covers
 * what a user waits on when opening a new rpc-ui tab: record minting,
 * extension generation (`writeRpcExtensions`), the two `omp config list
 * --json` probe subprocesses inside `writeRpcOverlays`, the omp child boot,
 * the ready handshake, and the full command rail round-trip.
 *
 * Determinism contract:
 * - Hermetic HOME under a fresh temp dir: an inert `models.yml` provider at
 *   127.0.0.1:9 (discard port) and a `config.yml` with the update check and
 *   retries off — no network, no live account, no user config (mirrors
 *   limits-live.test.ts).
 * - Provider/API-key env vars are scrubbed from this process before the
 *   first spawn, so no child inherits a real credential.
 * - One spawn alive at a time; each run terminates and awaits the exit
 *   before the next starts. The metric is the median over N runs
 *   (BENCH_RUNS, default 7), damped against process-timing noise.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CH,
  ProviderKeys,
  Registry,
  resolveOmpBinary,
  type KeyCipher,
} from "@omp-ui/core";
import { SessionManager } from "../packages/desktop/src/main/session-manager";
import { seedRegistry } from "../packages/desktop/src/main/test/fixtures";

/** The tail registration command's response id — the settle signal. */
const SETTLE_COMMAND_ID = "omp-ui-host-tools-1";
const SETTLE_TIMEOUT_MS = 30_000;
/** Keys that would let a child reach a live account; all scrubbed. */
const SCRUB_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OMP_UI_TEST_MODEL",
  "OMP_UI_TEST_ADVISOR",
];

const MODELS_YML = `providers:
  benchprobe:
    baseUrl: http://127.0.0.1:9/v1
    api: openai-completions
    apiKey: none
    models:
      - id: inert
        name: inert
        contextWindow: 4096
        maxTokens: 128
`;

const CONFIG_YML = `startup:
  checkUpdate: false
retry:
  enabled: false
`;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface Harness {
  manager: SessionManager;
  /** Marks t0 and resolves with the wall ms when the settle frame arrives. */
  armSettle(): Promise<number>;
  /** Resolves when the next `onPtyExit` arrives. */
  armExit(): Promise<void>;
  dispose(): void;
}

function buildHarness(base: string, ompPath: string): Harness {
  const sessionsRoot = path.join(base, "sessions");
  const archiveRoot = path.join(base, "archive", "sessions");
  const registryFile = path.join(base, "registry.json");
  const projectCwd = path.join(base, "project");
  fs.mkdirSync(projectCwd, { recursive: true });
  seedRegistry(registryFile, {
    projects: [
      {
        path: projectCwd,
        name: "bench",
        addedAt: "2026-10-13T00:00:00.000Z",
        lastModel: null,
        lastThinkingLevel: null,
        lastAdvisor: null,
        lastAdvisorModel: null,
        defaultModel: null,
        defaultAdvisorModel: null,
        browserClock: false,
        reviewRoster: null,
        knowledgeHome: null,
      },
    ],
    sessions: [],
  });
  const registry = Registry.load(registryFile);
  const cipher: KeyCipher = {
    available: true,
    backend: "bench",
    encrypt: (plain) => Buffer.from(plain),
    decrypt: (blob) => blob.toString("utf8"),
  };
  // Satisfies the fresh-spawn provider gate only; the child env carries no keys.
  const providerKeys = new ProviderKeys(path.join(base, "provider-keys.json"), cipher, {
    OPENROUTER_API_KEY: "bench-not-a-key",
  });

  let settle: { resolve: (ms: number) => void; reject: (err: Error) => void } | null = null;
  let settleTimer: NodeJS.Timeout | null = null;
  let exit: (() => void) | null = null;
  let startedAt = 0;

  const manager = new SessionManager({
    registry,
    registryFile,
    providerKeys,
    getOmpPath: () => ompPath,
    // The collab poll never shells out: every probe reads as a CLI hiccup.
    collabCli: { exec: async () => ({ stdout: "", stderr: "bench stub", code: 1 }) },
    getSessionsRoot: () => sessionsRoot,
    getArchiveRoot: () => archiveRoot,
    getWorktreesRoot: () => path.join(base, "worktrees"),
    appVersion: "0.0.0-bench",
    mainLog: () => {},
    // The pane seam the unit tests fake: a real bridge listener would bind a
    // ws port per run for behavior this benchmark never exercises.
    browserPane: {
      createListener: async (listenerDeps) => ({
        port: 45999,
        url: `http://127.0.0.1:45999/${listenerDeps.token}`,
        close: () => {},
        clientCount: () => 0,
      }),
    },
    send: (channel: string, ...args: unknown[]) => {
      const frame = args[1];
      if (channel === CH.onRpcFrame && frame !== null && typeof frame === "object") {
        if (settle !== null && "type" in frame && frame.type === "response" && "id" in frame && frame.id === SETTLE_COMMAND_ID) {
          const { resolve, reject } = settle;
          settle = null;
          if (settleTimer !== null) clearTimeout(settleTimer);
          resolve(performance.now() - startedAt);
          void reject;
        } else if (
          settle !== null &&
          "type" in frame &&
          frame.type === "omp_ui_error" &&
          "message" in frame &&
          typeof frame.message === "string"
        ) {
          const { resolve, reject } = settle;
          settle = null;
          if (settleTimer !== null) clearTimeout(settleTimer);
          reject(new Error(`omp_ui_error: ${frame.message}`));
          void resolve;
        }
      } else if (channel === CH.onPtyExit && exit !== null) {
        const settleFail = settle;
        settle = null;
        if (settleTimer !== null) clearTimeout(settleTimer);
        const resolveExit = exit;
        exit = null;
        resolveExit();
        if (settleFail !== null) settleFail.reject(new Error("spawn exited before the settle frame"));
      }
    },
    broadcast: async () => {},
  });

  return {
    manager,
    armSettle: () => {
      const resolvers = Promise.withResolvers<number>();
      settle = resolvers;
      startedAt = performance.now();
      settleTimer = setTimeout(() => {
        if (settle !== null) {
          const { reject } = settle;
          settle = null;
          reject(new Error(`timeout waiting for the ${SETTLE_COMMAND_ID} response`));
        }
      }, SETTLE_TIMEOUT_MS);
      return resolvers.promise;
    },
    armExit: () => {
      const resolvers = Promise.withResolvers<void>();
      exit = resolvers.resolve;
      return resolvers.promise;
    },
    dispose: () => manager.killAll(),
  };
}

async function main(): Promise<number[]> {
  const ompPath = resolveOmpBinary();
  if (ompPath === null) {
    console.error("no omp binary resolved (OMP_UI_OMP_PATH / managed bin / PATH)");
    process.exit(1);
  }
  const runs = Number(process.env.BENCH_RUNS ?? "7");
  if (!Number.isFinite(runs) || runs < 3) {
    console.error("BENCH_RUNS must be a number >= 3");
    process.exit(1);
  }

  // Resolve the real binary path BEFORE the hermetic HOME lands.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-bench-"));
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".omp", "agent", "models.yml"), MODELS_YML);
  fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), CONFIG_YML);
  for (const key of SCRUB_ENV_KEYS) delete process.env[key];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.XDG_CONFIG_HOME = path.join(home, ".config");
  process.env.XDG_DATA_HOME = path.join(home, ".local", "share");

  const harness = buildHarness(base, ompPath);
  const projectCwd = path.join(base, "project");
  const samples: number[] = [];
  try {
    for (let i = 0; i < runs; i += 1) {
      const settled = harness.armSettle();
      let tabId: string;
      try {
        tabId = (await harness.manager.spawn({
          origin: "new",
          projectCwd,
          mode: "rpc-ui",
          advisor: false,
          cols: 80,
          rows: 24,
          worktree: null,
        })).tabId;
      } catch (err) {
        settle = null;
        throw err;
      }
      let ms: number;
      try {
        ms = await settled;
      } catch (err) {
        console.error(`run ${i + 1}: spawn failed before settle: ${(err as Error).message}`);
        process.exit(1);
      }
      samples.push(ms);
      console.error(`run ${i + 1}: ${ms.toFixed(1)} ms`);
      const exited = harness.armExit();
      harness.manager.terminate(tabId);
      await exited;
      // Let the process table settle between runs.
      const { promise: nap, resolve: wake } = Promise.withResolvers<void>();
      setTimeout(wake, 250);
      await nap;
    }
  } finally {
    harness.dispose();
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return samples;
}

main().then(
  (samples) => {
    console.log(`METRIC session_startup_ms=${median(samples).toFixed(1)}`);
    console.log(`METRIC session_startup_min_ms=${Math.min(...samples).toFixed(1)}`);
    console.log(`METRIC session_startup_max_ms=${Math.max(...samples).toFixed(1)}`);
  },
  (err) => {
    console.error(String(err));
    process.exit(1);
  },
);
