import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient, resolveOmpBinary, writeBrowserPaneExtension } from "@omp-ui/core";
import {
  BROWSER_PANE_CUSTOM_TYPE,
  browserPaneInstruction,
  browserPaneSetMessage,
} from "@omp-ui/core/browser-pane";

/**
 * Runtime proof for the browser pane handshake (issue #519, ADR-0029) against
 * the REAL `omp --mode=rpc-ui` binary: the spawner's hidden `set` command in
 * `initialCommands` must leave exactly one hidden `omp-ui:browser-pane` custom
 * message in the session and raise no rpc error or extension warning. This is
 * the seam the unit harness fakes — `registerCommand`, the `prompt` hook on
 * `AgentSession.prototype`, and `sendCustomMessage` — so it is the one place a
 * change in omp's extension API surfaces.
 *
 * The session is read back through omp's `get_messages`: omp writes the
 * `.jsonl` under the lineage dir only once a user message exists, so before
 * any model turn the delivered custom message lives in session state alone.
 *
 * Skips cleanly when no omp binary resolves (mirrors how the app resolves it).
 */

const ompPath = resolveOmpBinary();

/** A well-formed endpoint nobody listens on: the handshake never connects to it. */
const ENDPOINT = `http://127.0.0.1:1/${"A".repeat(43)}`;

interface Frame {
  type: string;
  command?: string;
  method?: string;
  data?: { messages?: SessionMessage[] };
}

interface SessionMessage {
  role: string;
  customType?: string;
  content?: unknown;
  display?: boolean;
  attribution?: string;
}

// Real timers on purpose: the awaited condition is a real OS process answering
// over a pipe, which no fake clock can advance. Promise.withResolvers would
// read better but needs ES2024; the node tsconfig targets ES2022.
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
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-bplive-"));
  const lineage = path.join(base, "lin");
  const home = path.join(base, "home");
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const paneExt = writeBrowserPaneExtension(lineage);
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
    cwd: base,
    lineageDir: lineage,
    ompPath: ompPath!,
    extensions: [paneExt],
    initialCommands: [{ type: "prompt", message: browserPaneSetMessage(ENDPOINT) }],
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

describe.skipIf(ompPath === null)("browser pane handshake on the real runtime", () => {
  let scope: Scope | null = null;
  afterEach(async () => {
    if (scope !== null) {
      await killScope(scope);
      scope = null;
    }
  });

  it("leaves exactly one hidden browser pane message in the session", { timeout: 60_000 }, async () => {
    scope = spawnScope();
    const frames = scope.frames;
    // The arming prompt is a slash command: it settles without invoking the agent.
    await waitFor(
      () => frames.find((f) => f.type === "prompt_result"),
      30_000,
      "the hidden set command to settle",
    );
    scope.client.send({ type: "get_messages" } as never);
    const messages = await waitFor(
      () => frames.find((f) => f.type === "response" && f.command === "get_messages")?.data?.messages,
      10_000,
      "omp's get_messages answer",
    );

    const paneMessages = messages.filter((m) => m.customType === BROWSER_PANE_CUSTOM_TYPE);
    expect(paneMessages).toHaveLength(1);
    expect(paneMessages[0]).toMatchObject({
      role: "custom",
      content: browserPaneInstruction(ENDPOINT),
      display: false,
      attribution: "agent",
    });
    // Nothing else reached the session and nothing went wrong: no rpc error,
    // and no extension warning (ui.notify surfaces as an extension_ui_request).
    expect(messages).toHaveLength(1);
    expect(frames.filter((f) => f.type === "omp_ui_error")).toEqual([]);
    expect(frames.filter((f) => f.type === "extension_ui_request" && f.method === "notify")).toEqual([]);
  });
});
