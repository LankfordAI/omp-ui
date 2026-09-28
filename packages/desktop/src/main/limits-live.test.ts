import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient, resolveOmpBinary, writeLimitsExtension } from "@omp-ui/core";
import { LIMITS_COMMAND, LIMITS_STATUS_KEY, parseLimits } from "@omp-ui/core/limits";

/**
 * Live drift guard for the provider-quota bridge (issue #673) against the
 * REAL `omp --mode=rpc-ui` binary — the same skip-when-no-binary discipline
 * as magic-keywords-live.test.ts. Real timers throughout: the awaited actor
 * is an OS process, and every wait polls an observed frame, never a guessed
 * duration.
 *
 * The scope's models.yml points `limprobe/inert` at port 9 (discard) with an
 * isolated HOME, so the provider is never reached and no real account's usage
 * endpoint is probed: `fetchUsageReports` reads an empty auth store. What the
 * test proves is the integration surface the renderer depends on — omp loads
 * the generated extension without a startup error, the slash command
 * dispatches through the prompt wrapper (binding the root session), and the
 * bridge publishes a parseable snapshot over `omp-ui:limits`. Whether the
 * snapshot is `available:true, windows:[]` (the discard provider reports
 * nothing) or an `available:false` reason depends on the binary's version;
 * both are honest outcomes the HUD renders as nothing.
 */

const ompPath = resolveOmpBinary();

const MODELS_YML = `providers:
  limprobe:
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

interface Frame {
  type: string;
  statusKey?: string;
  statusText?: string;
}

interface Scope {
  base: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}

function sleep(ms: number): Promise<void> {
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

function spawnScope(): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-limits-live-"));
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(home, ".omp", "agent", "models.yml"), MODELS_YML);
  fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), CONFIG_YML);
  const frames: Frame[] = [];
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
  };
  const client = new RpcClient({
    cwd: project,
    lineageDir: lineage,
    ompPath: ompPath!,
    model: "limprobe/inert",
    extensions: [writeLimitsExtension(lineage)],
    spawnProcess: (bin, args, extra) => {
      const proc = spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...extra, ...env },
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
  return { base, frames, client, exited };
}

async function kill(scope: Scope): Promise<void> {
  scope.client.kill();
  await Promise.race([scope.exited, sleep(5_000)]);
  fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const disposers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

describe.skipIf(!ompPath)("limits bridge live (real omp)", () => {
  it("loads the extension, dispatches the command, and publishes a parseable snapshot", { timeout: 180_000 }, async () => {
    const scope = spawnScope();
    disposers.push(() => kill(scope));
    await waitFor(
      () => (scope.frames.some((f) => f.type === "response") ? true : undefined),
      60_000,
      "the first rpc response",
    );
    const from = scope.frames.length;
    // The slash run is dispatched through AgentSession.prototype.prompt, so
    // this doubles as proof that the wrapper's root capture runs on the real
    // session object before the handler fetches.
    scope.client.send({ type: "prompt", message: `/${LIMITS_COMMAND}` } as never);
    const frame = await waitFor(
      () =>
        scope.frames.find(
          (f, i) => i >= from && f.type === "extension_ui_request" && f.statusKey === LIMITS_STATUS_KEY,
        ),
      30_000,
      "an omp-ui:limits setStatus frame",
    );
    const view = parseLimits(frame.statusText);
    expect(view, `unparseable snapshot: ${frame.statusText}`).not.toBeNull();
    if (view!.available) {
      expect(Array.isArray(view!.windows)).toBe(true);
      expect(typeof view!.fetchedAtMs).toBe("number");
    } else {
      expect(typeof view!.unavailable).toBe("string");
    }
  });
});
