import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient, resolveOmpBinary, writeAutoresearchExtension } from "@omp-ui/core";
import {
  AUTORESEARCH_STATUS_KEY,
  AUTORESEARCH_WIDGET_KEY,
  autoresearchArmMessage,
  parseAutoresearchSnapshot,
  type AutoresearchSnapshot,
} from "@omp-ui/core/autoresearch";

/**
 * Runtime proof for the autoresearch status bridge (Experiments Lab, issue
 * #559) against the REAL generated bridge and the real `omp --mode=rpc-ui`
 * binary — the same skip-when-no-binary discipline as
 * capability-control-live.test.ts.
 *
 * No model is ever engaged: the arm command and `/autoresearch` are extension
 * commands the runtime settles before turn processing. The proof asserts the
 * three facts the Session HUD chip and the Lab rely on: the arm publishes an
 * `off` snapshot, bare `/autoresearch` flips it to `on`, and `/autoresearch
 * off` flips it back while omp's own TUI dashboard arrives as a `setWidget`
 * frame keyed {@link AUTORESEARCH_WIDGET_KEY} — the frame native tabs swallow.
 *
 * HOME/XDG point at the temp scope so the run never reads or writes global omp
 * state (including omp's autoresearch DB dir). Real timers: the actor is a
 * genuine OS process, so every wait is on an OBSERVED frame, bounded.
 */

const ompPath = resolveOmpBinary();

interface Frame {
  type: string;
  method?: string;
  statusKey?: string;
  statusText?: string;
  widgetKey?: string;
  message?: { role?: string };
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

interface Scope {
  base: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}

function spawnScope(): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-autoresearch-"));
  const lineage = path.join(base, "lin");
  const home = path.join(base, "home");
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const bridge = writeAutoresearchExtension(lineage);
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
    XDG_STATE_HOME: path.join(home, ".local", "state"),
    // A provider must resolve for the runtime to boot; nothing here prompts it.
    ANTHROPIC_API_KEY: "omp-ui-live-test-dummy",
  };
  const client = new RpcClient({
    cwd: base,
    lineageDir: lineage,
    ompPath: ompPath!,
    extensions: [bridge],
    initialCommands: [
      { type: "prompt", id: "omp-ui-initial-autoresearch-test", message: autoresearchArmMessage() },
    ],
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

function snapshotsAfter(scope: Scope, from: number): AutoresearchSnapshot[] {
  return scope.frames
    .slice(from)
    .filter((f) => f.type === "extension_ui_request" && f.statusKey === AUTORESEARCH_STATUS_KEY)
    .map((f) => parseAutoresearchSnapshot(f.statusText))
    .filter((s): s is AutoresearchSnapshot => s !== null);
}

/** The first snapshot after `from` reporting `mode`, from the bridge's own reads (never `unavailable`). */
function modeAfter(scope: Scope, from: number, mode: AutoresearchSnapshot["mode"]): Promise<AutoresearchSnapshot> {
  return waitFor(
    () => snapshotsAfter(scope, from).find((s) => s.available && s.mode === mode),
    30_000,
    `an available autoresearch snapshot with mode ${mode}`,
  );
}

async function killScope(scope: Scope): Promise<void> {
  scope.client.kill();
  const exitedNow = await Promise.race([
    scope.exited.then(() => true),
    sleep(8_000).then(() => false),
  ]);
  if (!exitedNow) scope.client.kill("SIGKILL");
  await sleep(150);
  fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

describe.skipIf(ompPath === null)("autoresearch status bridge on the real runtime", () => {
  let scope: Scope | null = null;
  afterEach(async () => {
    if (scope !== null) {
      await killScope(scope);
      scope = null;
    }
  });

  it("publishes off on arm, on after bare /autoresearch, and off again with omp's widget", { timeout: 120_000 }, async () => {
    scope = spawnScope();
    const armed = await modeAfter(scope, 0, "off");
    expect(armed.goal).toBeNull();
    expect(armed.lastTool).toBeNull();

    let before = scope.frames.length;
    scope.client.send({ type: "prompt", message: "/autoresearch" } as never);
    const on = await modeAfter(scope, before, "on");
    expect(on.processKey).toBe(armed.processKey);
    expect(on.revision).toBeGreaterThan(armed.revision);

    before = scope.frames.length;
    scope.client.send({ type: "prompt", message: "/autoresearch off" } as never);
    const off = await modeAfter(scope, before, "off");
    expect(off.revision).toBeGreaterThan(on.revision);
    const widget = await waitFor(
      () =>
        scope!.frames
          .slice(before)
          .find((f) => f.type === "extension_ui_request" && f.method === "setWidget" && f.widgetKey === AUTORESEARCH_WIDGET_KEY),
      30_000,
      `a setWidget frame keyed ${AUTORESEARCH_WIDGET_KEY}; saw ${JSON.stringify(
        scope.frames.slice(before).filter((f) => f.type === "extension_ui_request").map((f) => ({ method: f.method, widgetKey: f.widgetKey, statusKey: f.statusKey })),
      )}`,
    );
    expect(widget.widgetKey).toBe(AUTORESEARCH_WIDGET_KEY);

    // Extension commands settle before turn processing: no user render item.
    expect(scope.frames.filter((f) => f.type === "message_start" && f.message?.role === "user")).toHaveLength(0);
  });
});
