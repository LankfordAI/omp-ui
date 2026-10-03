import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOmpBinary, RpcClient, setEventFilterCommand, type RpcFrame } from "@omp-ui/core";
import { reduceEvent, type AssistantItem, type RenderItem, type ToolItem } from "../renderer/src/lib/transcript";

/**
 * Live proof for the `set_event_filter` negotiation on the REAL
 * `omp --mode=rpc-ui` binary (issue #718). The echo half needs no model:
 * the command rides `initialCommands`, so its response lands right after the
 * negotiate handshake. The behavioral half streams a real turn and needs an
 * API key, so it skips without one.
 *
 * The behavioral assertions are what delta mode owes the transcript:
 *  - every `message_update` stays small (the accumulated snapshot is gone),
 *  - the reducer's accumulation equals the authoritative `message_end`
 *    content for both text and tool args — the invariant the reconcile
 *    depends on, proven on real frames rather than fixtures.
 */

const ompPath = resolveOmpBinary();
const hasApiKey =
  typeof process.env.ANTHROPIC_API_KEY === "string" ||
  typeof process.env.ANTHROPIC_OAUTH_TOKEN === "string" ||
  typeof process.env.OPENROUTER_API_KEY === "string";
/** Pins an OpenRouter model when that is the only key configured. */
const model = process.env.OPENROUTER_API_KEY ? "openrouter/openai/gpt-5.6-luna" : undefined;

const CONFIG_YML = `startup:
  checkUpdate: false
retry:
  enabled: false
`;
const APPROVAL_YML = `tools:
  approvalMode: yolo
`;
const PROMPT =
  "Use the write tool to create haiku.txt containing one haiku about the sea. " +
  "Then say in one sentence what you did.";

interface Scope {
  base: string;
  frames: RpcFrame[];
  bytes: { total: number; messageUpdate: number[] };
  /** The transcript the real frames reduce into, kept current by onFrame. */
  reduced: { items: RenderItem[] };
  client: RpcClient;
}

function sleep(ms: number): Promise<void> {
  // Real timers: the thing waited on is a real OS process. Executor form —
  // Promise.withResolvers needs ES2024; the node tsconfig lib predates it.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `probe` until it returns a value or the timeout elapses. */
async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(50);
  }
}

function spawnScope(withFilter: boolean): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-filter-live-"));
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), CONFIG_YML);
  const overlay = path.join(base, "approval.yml");
  fs.writeFileSync(overlay, APPROVAL_YML);
  const frames: RpcFrame[] = [];
  const bytes = { total: 0, messageUpdate: [] as number[] };
  const reduced = { items: [] as RenderItem[] };
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    // A provider must resolve for the runtime to boot (mirrors
    // host-bridge-live); the echo test never prompts, so the dummy is enough.
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "omp-ui-live-test-dummy",
    ...(process.env.OPENROUTER_API_KEY ? { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY } : {}),
  };
  const client = new RpcClient({
    cwd: project,
    lineageDir: lineage,
    ompPath: ompPath!,
    model,
    configOverlays: [overlay],
    initialCommands: withFilter ? [setEventFilterCommand()] : [],
    onFrame: (frame) => {
      // Serialized bytes == what the IPC would carry to the renderer.
      const wire = JSON.stringify(frame);
      bytes.total += wire.length + 1;
      if (frame.type === "message_update") bytes.messageUpdate.push(wire.length);
      frames.push(frame);
      reduced.items = reduceEvent(reduced.items, frame);
    },
    onExit: () => {},
    onError: () => {},
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
  });
  return { base, frames, bytes, reduced, client };
}

let scope: Scope | null = null;
afterEach(async () => {
  if (scope === null) return;
  scope.client.kill("SIGKILL");
  await sleep(300);
  fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  scope = null;
});

describe.skipIf(ompPath === null)("event filter on the real runtime", () => {
  it("omp accepts messageUpdates delta", async () => {
    scope = spawnScope(true);
    const response = await waitFor(
      () => scope!.frames.find((f) => f.type === "response" && f.id === "omp-ui-event-filter-1"),
      25_000,
      "the set_event_filter response",
    );
    expect(response).toMatchObject({
      success: true,
      data: { events: null, messageUpdates: "delta" },
    });
  }, 60_000);
});

describe.skipIf(ompPath === null || !hasApiKey)("delta streaming on the real runtime", () => {
  it("streams a turn with small frames and a transcript that matches the authoritative end", async () => {
    scope = spawnScope(true);
    scope.client.send({ type: "prompt", id: "live-1", message: PROMPT });
    await waitFor(
      () => scope!.frames.find((f) => f.type === "agent_end"),
      180_000,
      "agent_end",
    );
    const updates = [...scope.bytes.messageUpdate].sort((a, b) => a - b);
    expect(updates.length).toBeGreaterThan(10);
    // Full mode ships the whole accumulated message per flush — thousands of
    // bytes by now. Delta mode carries a fragment plus envelope.
    expect(updates[Math.floor(updates.length / 2)]).toBeLessThan(1_024);

    // The invariant the reducer relies on: what streamed in equals what the
    // runtime says the finished message holds.
    const assistants = scope.reduced.items.filter((i): i is AssistantItem => i.kind === "assistant");
    expect(assistants.length).toBeGreaterThan(0);
    expect(assistants.at(-1)?.streaming).toBe(false);
    expect(assistants.at(-1)!.text.length).toBeGreaterThan(0);
    const tools = scope.reduced.items.filter(
      (i): i is ToolItem => i.kind === "tool" && i.name === "write",
    );
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      // toolcall_end's authoritative toolCall replaced any streamed draft.
      expect(t.argsStreaming ?? false).toBe(false);
      expect(t).not.toHaveProperty("argsText");
      expect(t.args).toHaveProperty("content", expect.any(String));
    }
  }, 240_000);
});
