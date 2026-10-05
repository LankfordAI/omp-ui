import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  CODE_REVIEW_COMMAND,
  RpcClient,
  parseReviewDocument,
  resolveOmpBinary,
  writeReviewExtension,
  writeReviewOverlay,
  writeReviewRosterSnapshot,
} from "@omp-ui/core";

/**
 * The code-review bridge (issue #728, ADR-0047) against the REAL
 * `omp --mode=rpc-ui`: the generated extension loads (omp's TS loader accepts
 * it, the command registers, and it appears in `available_commands_update`),
 * and `/code-review` puts the inert-fenced batch launch into the session via
 * `pi.sendMessage`. The model turns at a discard-port model, so no prompt
 * ever reaches a provider; the assertions run against frames and the
 * transcript the launch writes before the doomed turn.
 */

const ompPath = resolveOmpBinary();

const MODELS_YML = `providers:
  kwprobe:
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

// The roster app state would hold; main snapshots it at spawn the way
// spawn-config does, and the bridge reads only the snapshot.
const ROSTER_DOC = parseReviewDocument(
  `instructions: "review thoroughly"
reviewers:
  - name: style-critic
  - name: security-hawk
    model: "kwprobe/inert"
    targets: [local, commit]
`,
  "REVIEW.yml",
).document;

interface Frame {
  type: string;
  id?: string;
  command?: string;
  success?: boolean;
  error?: string;
  data?: Record<string, unknown>;
  message?: { role?: string; customType?: string; content?: unknown };
  commands?: Array<{ name?: string }>;
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

function sleep(ms: number): Promise<void> {
  // Real timers: the awaited actor is an OS process speaking NDJSON.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(25);
  }
}

async function spawnScope(): Promise<{
  base: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-review-live-"));
  dirs.push(base);
  const home = path.join(base, "home");
  const agent = path.join(home, ".omp", "agent");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "models.yml"), MODELS_YML);
  fs.writeFileSync(path.join(agent, "config.yml"), CONFIG_YML);
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "a.txt"), "hello\n");
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: project, stdio: "pipe" });
  };
  git(["init", "-q"]);
  git(["add", "a.txt"]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed"]);
  // An untracked file so the local target is non-empty; a clean tree answers "Nothing to review".
  fs.writeFileSync(path.join(project, "b.txt"), "world\n");
  // Main writes this roster snapshot on every rpc spawn; the bridge reads only it.
  await writeReviewRosterSnapshot(lineage, ROSTER_DOC, null);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
  };
  const frames: Frame[] = [];
  const { promise: exited, resolve: markExited } = Promise.withResolvers<void>();
  const client = new RpcClient({
    cwd: project,
    lineageDir: lineage,
    ompPath: ompPath!,
    model: "kwprobe/inert",
    configOverlays: [writeReviewOverlay(lineage)],
    extensions: [writeReviewExtension(lineage)],
    spawnProcess: (bin, args, extra) => {
      const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...extra, ...env } });
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
  return { base, frames, client, exited };
}

describe.skipIf(!ompPath)("code-review extension (real omp)", () => {
  it(
    "loads the bridge and /code-review sends the batch launch into the session",
    { timeout: 180_000 },
    async () => {
      const { frames, client, exited } = await spawnScope();
      try {
        client.send({ type: "get_state", id: "ready-probe" });
        const loaded = await waitFor(
          () =>
            frames.find(
              (f) => f.type === "available_commands_update" && f.commands?.some((c) => c.name === CODE_REVIEW_COMMAND),
            ),
          90_000,
          "the code-review command in available_commands_update",
        );
        expect(loaded).toBeDefined();

        client.send({ type: "prompt", id: "p1", message: `/${CODE_REVIEW_COMMAND}` });
        const launch = await waitFor(
          () =>
            frames.find(
              (f) => f.type === "message_start" && f.message?.customType === "omp-ui-code-review-launch",
            ),
          60_000,
          "the batch launch custom message in the session",
        );
        const content = JSON.stringify(launch.message?.content);
        expect(content).toContain("style-critic");
        expect(content).toContain("security-hawk");
        expect(content).toContain("kwprobe/inert");
        expect(content).toContain("review thoroughly");
      } finally {
        client.kill();
        await Promise.race([exited, sleep(10_000)]);
      }
    },
  );
});
