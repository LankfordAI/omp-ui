import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  hostToolsDefinition,
  parseVaultDetails,
  resolveOmpBinary,
  RpcClient,
  setHostToolsCommand,
  setHostUriSchemesCommand,
  type OwnedSessionRecord,
  type RpcFrame,
  type SessionsResourceDeps,
} from "@omp-ui/core";
import { HostBridge, type VaultBridgeDeps } from "./host-bridge";

/**
 * Live proof for the knowledge-vault tools and the omp-ui://sessions index on
 * the REAL `omp --mode=rpc-ui` binary (issue #769). The registration half
 * needs no model: the shipped `initialCommands` (session-manager.ts, with a
 * vault registered) ride the negotiate handshake, so the set_host_tools
 * response lands right after it and names all eight tools. The answering
 * half — a model that actually calls omp-ui_vault_search and reads
 * omp-ui://sessions — is gated on an API key: with none configured no
 * prompt can run, so those tests skip.
 */

const ompPath = resolveOmpBinary();
const hasApiKey =
  typeof process.env.ANTHROPIC_API_KEY === "string" ||
  typeof process.env.ANTHROPIC_OAUTH_TOKEN === "string";

const CONFIG_YML = `startup:
  checkUpdate: false
retry:
  enabled: false
`;

interface Scope {
  base: string;
  frames: RpcFrame[];
  sent: RpcFrame[];
  bridge: HostBridge;
  client: RpcClient;
}

function sleep(ms: number): Promise<void> {
  // Real timers on purpose: the awaited condition is a real OS process
  // answering over a pipe, which no fake clock can advance.
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
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

/** Today's one owned session: the row omp-ui://sessions must list. */
function todayRecord(projectCwd: string): OwnedSessionRecord {
  const now = new Date().toISOString();
  return {
    tabId: "tab-live",
    sessionId: "sess-live",
    lineageDir: "omp-ui--proj--11111111-2222-3333-4444-555555555555",
    projectCwd,
    worktree: null,
    planImplementationSource: null, experiment: null,
    launchedAt: now,
    mode: "rpc-ui",
    compactionMethod: null,
    approvalMode: null,
    serviceTier: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null,
    subagentModels: null,
    proposedPlans: [],
    cachedTitle: "Live Day Row",
    cachedModified: now,
    agentMode: "build",
  };
}

function spawnScope(): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-vault-live-"));
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  const home = path.join(base, "home");
  const vault = path.join(base, "vault");
  fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), CONFIG_YML);
  // One note the search must find, and the empty omp-ui home folder.
  fs.mkdirSync(path.join(vault, "Reference"), { recursive: true });
  fs.mkdirSync(path.join(vault, "omp-ui"), { recursive: true });
  fs.writeFileSync(
    path.join(vault, "Reference", "Live.md"),
    "# Live\n\nThe zephyrine note the live vault search must find.\n",
  );
  const vaultDeps: VaultBridgeDeps = {
    context: () => ({
      projectName: "Live",
      projectFolder: "Live",
      pinnedVault: null,
      lineage: "019a38bf-bbaa-7111-8123-123456789abc",
    }),
    registry: () => ({
      vaults: [{ name: "Live", path: vault, homeFolder: "omp-ui/", allowWritesOutsideHome: false }],
      defaultWriteVault: "Live",
    }),
    // Every guarded root sits under base; none is, or contains, the vault.
    guard: () => ({
      home: path.join(base, "guard-home"),
      userData: path.join(base, "data"),
      agentDir: path.join(base, "agent"),
      sessionsRoot: path.join(base, "sessions"),
      archiveRoot: path.join(base, "archive"),
    }),
    obsidianList: async () => [],
    appVersion: "live-769",
    now: () => new Date(),
    mainLog: () => {},
  };
  const sessionsDeps: SessionsResourceDeps = {
    records: () => [todayRecord(project)],
    projects: () => [],
    locate: async () => ({ where: "missing" }),
    now: () => new Date(),
  };
  const frames: RpcFrame[] = [];
  const sent: RpcFrame[] = [];
  const bridge = new HostBridge({
    readPlanFile: async () => ({ ok: false, reason: "unreadable" }),
    planSnapshot: () => null,
    planRoot: () => lineage,
    notify: () => "posted",
    capabilitySessionId: () => null,
    log: () => {},
    vault: vaultDeps,
    sessions: sessionsDeps,
  });
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    // A provider must resolve for the runtime to boot (mirrors autoresearch-live);
    // the registration test never prompts, so this key is never used there.
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "omp-ui-live-test-dummy",
  };
  const client = new RpcClient({
    cwd: project,
    lineageDir: lineage,
    ompPath: ompPath!,
    configOverlays: [],
    // The shipped registration with a vault registered (session-manager.ts).
    initialCommands: [setHostUriSchemesCommand(), setHostToolsCommand({ vault: true })],
    onInputFrame: (frame) => {
      // The same seam SessionManager wires: route before delivery.
      bridge.route("live", frame, (answer) => {
        sent.push(answer);
        client.send(answer);
      });
    },
    onFrame: (frame) => {
      bridge.noteFrame("live", frame);
      frames.push(frame);
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
  return { base, frames, sent, bridge, client };
}

let scope: Scope | null = null;
afterEach(async () => {
  if (scope === null) return;
  scope.client.kill("SIGKILL");
  await sleep(300);
  fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  scope = null;
});

describe.skipIf(ompPath === null)("vault tools register on the real runtime", () => {
  it("omp accepts omp-ui_notify and the seven vault tools", async () => {
    scope = spawnScope();
    const toolsResponse = await waitFor(
      () => scope!.frames.find((f) => f.type === "response" && f.id === "omp-ui-host-tools-1"),
      25_000,
      "the set_host_tools response",
    );
    expect(toolsResponse).toMatchObject({ success: true });
    expect((toolsResponse.data as { toolNames?: unknown } | undefined)?.toolNames).toEqual(
      hostToolsDefinition({ vault: true }).map((t) => t.name),
    );
  }, 60_000);
});

describe.skipIf(ompPath === null || !hasApiKey)("vault answering on the real runtime", () => {
  it("omp hands an omp-ui_vault_search call to the host bridge", async () => {
    scope = spawnScope();
    await waitFor(
      () =>
        scope!.frames.some((f) => f.type === "response" && f.id === "omp-ui-host-tools-1")
          ? true
          : undefined,
      25_000,
      "the tool registration",
    );
    scope.client.send({
      type: "prompt",
      message: "Call the omp-ui_vault_search tool once with query zephyrine. Then reply DONE.",
    } as never);
    const call = await waitFor(
      () => scope!.frames.find((f) => f.type === "host_tool_call" && f.toolName === "omp-ui_vault_search"),
      90_000,
      "the host_tool_call for omp-ui_vault_search",
    );
    await waitFor(
      () => (scope!.sent.some((f) => f.type === "host_tool_result") ? true : undefined),
      10_000,
      "the bridge's host_tool_result",
    );
    const results = scope.sent.filter((f) => f.type === "host_tool_result");
    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.isError).not.toBe(true);
    expect(result.id).toBe(call.id);
    const details = parseVaultDetails((result.result as { details?: unknown } | undefined)?.details);
    expect(details).toMatchObject({ action: "search", vaultName: "Live", matchedFiles: 1 });
  }, 180_000);

  it("omp hands an omp-ui://sessions read to the host bridge", async () => {
    scope = spawnScope();
    await waitFor(
      () =>
        scope!.frames.some((f) => f.type === "response" && f.id === "omp-ui-host-uri-1")
          ? true
          : undefined,
      25_000,
      "the scheme registration",
    );
    scope.client.send({
      type: "prompt",
      message: "Use the read tool on the URL omp-ui://sessions once. Then reply DONE.",
    } as never);
    const request = await waitFor(
      () =>
        scope!.frames.find(
          (f) => f.type === "host_uri_request" && typeof f.url === "string" && f.url.startsWith("omp-ui://sessions"),
        ),
      90_000,
      "the host_uri_request for omp-ui://sessions",
    );
    await waitFor(
      () => (scope!.sent.some((f) => f.type === "host_uri_result") ? true : undefined),
      10_000,
      "the bridge's host_uri_result",
    );
    const results = scope.sent.filter((f) => f.type === "host_uri_result");
    expect(results).toHaveLength(1);
    const result = results[0]!;
    expect(result.isError).not.toBe(true);
    expect(result.id).toBe(request.id);
    expect(result.content).toEqual(expect.stringContaining("Live Day Row"));
  }, 180_000);
});
