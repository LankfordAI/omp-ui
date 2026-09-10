import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient, planMessage, resolveOmpBinary, writeCapabilitiesExtension, writePlanExtension } from "@omp-ui/core";
import {
  CAPABILITIES_STATUS_KEY,
  capabilitiesMessage,
  capabilityToolMutationMessage,
  parseCapabilitySnapshot,
  type CapabilitySnapshot,
} from "@omp-ui/core/capabilities";

/**
 * Runtime proof for session-local tool control (issue #379) against the REAL
 * generated bridges and the real `omp --mode=rpc-ui` binary — the same
 * skip-when-no-binary discipline as advisor-stats-live.test.ts.
 *
 * No model is ever engaged: every prompt frame sent here is an extension
 * command (arm, plan, or a `tool` mutation verb), which the runtime handles
 * before turn processing. The proof asserts exactly that — no user render
 * item and no assistant turn may appear for a toggle — plus the correlated
 * published result, the roster it promises, Plan mode's write lock, the
 * temporary-write ownership across Plan/Build, unknown-name refusal, and an
 * expired request never touching the registry.
 *
 * The throwaway tool extension registers two harmless tools — one enabled,
 * one default-inactive — so a real enable/disable round trip needs no
 * user-global configuration and cannot cost tokens. HOME/XDG are pointed at
 * the temp scope so the run never reads or writes global omp state.
 *
 * Real timers throughout: the awaited actor is a genuine OS process speaking
 * NDJSON, so deterministic time control cannot make it publish sooner — the
 * same exception advisor-stats-live.test.ts documents. Every wait is on an
 * OBSERVED frame condition (a correlated publish, a revision bump), never a
 * guessed duration. Promise.withResolvers would read better but needs ES2024;
 * the node tsconfig targets ES2022 (same reason as advisor-stats-live).
 */

const ompPath = resolveOmpBinary();

interface Frame {
  type: string;
  statusKey?: string;
  statusText?: string;
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

const THROWAWAY_TOOLS = `
export default function (pi) {
  const inert = {
    name: "proof-inert",
    description: "proof extension tool — returns a constant",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => ({ content: [{ type: "text", text: "proof" }], details: {} }),
  };
  pi.registerTool({ ...inert });
  pi.registerTool({ ...inert, name: "proof-inactive", defaultInactive: true });
}
`;

interface Scope {
  base: string;
  lineage: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}

function spawnScope(): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-capctl-"));
  const lineage = path.join(base, "lin");
  const home = path.join(base, "home");
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  const toolExt = path.join(base, "tools.ts");
  fs.writeFileSync(toolExt, THROWAWAY_TOOLS);
  const planExt = writePlanExtension(lineage);
  const capExt = writeCapabilitiesExtension(lineage);
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
    extensions: [planExt, capExt, toolExt],
    initialCommands: [
      { type: "prompt", message: planMessage(false, "md") },
      { type: "prompt", message: capabilitiesMessage() },
    ],
    spawnProcess: (bin, args, extra) => {
      const proc = spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...extra, ...env },
      });
      return {
        pid: proc.pid,
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
  return { base, lineage, frames, client, exited };
}

function snapshotsAfter(scope: Scope, from: number): CapabilitySnapshot[] {
  return scope.frames
    .slice(from)
    .filter((f) => f.type === "extension_ui_request" && f.statusKey === CAPABILITIES_STATUS_KEY)
    .map((f) => parseCapabilitySnapshot(f.statusText))
    .filter((s): s is CapabilitySnapshot => s !== null);
}

function toolEnabled(snapshot: CapabilitySnapshot, name: string): boolean | null | undefined {
  if (snapshot.tools.status !== "available") return undefined;
  return snapshot.tools.items.find((t) => t.name === name)?.enabled;
}

function userMessagesAfter(scope: Scope, from: number): Frame[] {
  return scope.frames.slice(from).filter((f) => f.type === "message_start" && f.message?.role === "user");
}

/** Waits for the first publish strictly newer than `baseRevision`. Revisions
 *  increase on every replacement, so this is an observed frame condition. */
async function publishAfter(scope: Scope, from: number, baseRevision: number): Promise<CapabilitySnapshot> {
  return waitFor(
    () => snapshotsAfter(scope, from).find((s) => s.revision > baseRevision),
    25_000,
    `publish newer than revision ${baseRevision}`,
  );
}

async function mutate(
  scope: Scope,
  snapshot: CapabilitySnapshot,
  name: string,
  enabled: boolean,
  opts: { expiresAt?: number } = {},
): Promise<CapabilitySnapshot> {
  const request = {
    id: `live-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    processKey: snapshot.processKey,
    sessionId: snapshot.sessionId,
    name,
    enabled,
    expiresAt: opts.expiresAt ?? Date.now() + 30_000,
  };
  const before = scope.frames.length;
  scope.client.send({ type: "prompt", message: capabilityToolMutationMessage(request) } as never);
  return waitFor(
    () =>
      snapshotsAfter(scope, before).find(
        (s) =>
          s.toolMutation?.id === request.id &&
          s.toolMutation.name === name &&
          s.toolMutation.enabled === enabled,
      ),
    25_000,
    `correlated publish for ${name}=${enabled}`,
  );
}

async function arm(scope: Scope): Promise<CapabilitySnapshot> {
  const before = scope.frames.length;
  scope.client.send({ type: "prompt", message: capabilitiesMessage() } as never);
  return waitFor(
    () => {
      const published = snapshotsAfter(scope, before).find((s) => s.tools.status === "available");
      return published !== undefined && toolEnabled(published, "proof-inert") === true
        ? published
        : undefined;
    },
    25_000,
    "armed roster carrying the proof tools",
  );
}

async function sendPlan(scope: Scope, on: boolean, baseRevision: number): Promise<CapabilitySnapshot> {
  const before = scope.frames.length;
  scope.client.send({ type: "prompt", message: planMessage(on, "md") } as never);
  return publishAfter(scope, before, baseRevision);
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

describe.skipIf(ompPath === null)("capability tool control on the real runtime", () => {
  let scope: Scope | null = null;
  afterEach(async () => {
    if (scope !== null) {
      await killScope(scope);
      scope = null;
    }
  });

  it("publishes a mutable surface and round-trips enable/disable with correlation", { timeout: 180_000 }, async () => {
    scope = spawnScope();
    const armed = await arm(scope);
    expect(armed.toolControl).toBe("available");
    expect(toolEnabled(armed, "proof-inactive")).toBe(false);

    const enabled = await mutate(scope, armed, "proof-inactive", true);
    expect(enabled.toolMutation?.status).toBe("applied");
    expect(toolEnabled(enabled, "proof-inactive")).toBe(true);
    // Unrelated selection survived: the enabled proof tool is still enabled.
    expect(toolEnabled(enabled, "proof-inert")).toBe(true);
    const disabled = await mutate(scope, enabled, "proof-inactive", false);
    expect(disabled.toolMutation?.status).toBe("applied");
    expect(toolEnabled(disabled, "proof-inactive")).toBe(false);

    // A deliberate toggle starts no agent turn: no user render item appeared.
    expect(userMessagesAfter(scope, 0)).toHaveLength(0);
  });

  it("refuses unknown names and expired requests without touching the roster", { timeout: 180_000 }, async () => {
    scope = spawnScope();
    const armed = await arm(scope);
    const refused = await mutate(scope, armed, "no-such-tool", true);
    expect(refused.toolMutation?.status).toBe("unknown-tool");
    expect(toolEnabled(refused, "proof-inactive")).toBe(false);

    const expired = await mutate(scope, refused, "proof-inactive", true, {
      expiresAt: Date.now() - 1,
    });
    expect(expired.toolMutation?.status).toBe("expired");
    expect(toolEnabled(expired, "proof-inactive")).toBe(false);
  });

  it("locks write in Plan mode and preserves other selections across Plan/Build", { timeout: 180_000 }, async () => {
    scope = spawnScope();
    const armed = await arm(scope);
    // OMP v18.1.10 keeps `write` in the enabled set no matter which apply
    // seam is asked to remove it (verified against the real binary: both
    // setActiveToolPresentation and setActiveToolsByName retain it). The
    // bridge reports that runtime truth as not-applied rather than claiming
    // success — the whole point of readback confirmation.
    expect(toolEnabled(armed, "write")).toBe(true);
    const refusedBuild = await mutate(scope, armed, "write", false);
    expect(refusedBuild.toolMutation?.status).toBe("not-applied");
    expect(toolEnabled(refusedBuild, "write")).toBe(true);

    // Plan entry therefore adds nothing and records no ownership: write was
    // already enabled, so exit must leave it in place untouched.
    const entered = await sendPlan(scope, true, refusedBuild.revision);
    expect(toolEnabled(entered, "write")).toBe(true);

    // While Plan is on, disabling write is refused by the bridge's policy
    // veto before any setter runs — distinct from the Build-mode outcome.
    const refusedPlan = await mutate(scope, entered, "write", false);
    expect(refusedPlan.toolMutation?.status).toBe("mode-required");

    // Another selection changes while Plan mode is on; it must survive exit.
    const toggled = await mutate(scope, refusedPlan, "proof-inert", false);
    expect(toggled.toolMutation?.status).toBe("applied");
    expect(toolEnabled(toggled, "proof-inert")).toBe(false);

    const exited = await sendPlan(scope, false, toggled.revision);
    expect(toolEnabled(exited, "proof-inert")).toBe(false);
    expect(toolEnabled(exited, "write")).toBe(true);

    expect(userMessagesAfter(scope, 0)).toHaveLength(0);
  });
});
