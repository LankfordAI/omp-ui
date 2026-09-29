import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  resolveOmpBinary,
  RpcClient,
  setHostToolsCommand,
  setHostUriSchemesCommand,
  type RpcFrame,
} from "@omp-ui/core";
import { HostBridge } from "./host-bridge";

/**
 * Live proof for the host-tools / host-URI bridge on the REAL
 * `omp --mode=rpc-ui` binary (issue #688, ADR-0043). The registration half
 * needs no model: both commands ride `initialCommands`, so their response
 * frames land right after the negotiate handshake. The answering half — a
 * model that actually reads `omp-ui://plan` — is gated on an API key: with
 * none configured no prompt can run, so that test skips.
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
  // Real timers: the thing waited on is a real OS process.
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

function spawnScope(): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-host-live-"));
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), CONFIG_YML);
  const frames: RpcFrame[] = [];
  const sent: RpcFrame[] = [];
  const bridge = new HostBridge({
    // A fresh session has proposed no plan, so no read is attempted; a read
    // that DOES happen proves the wiring, and answers as unreadable.
    readPlanFile: async () => ({ ok: false, reason: "unreadable" }),
    planSnapshot: () => null,
    planRoot: () => lineage,
    notify: () => "posted",
    capabilitySessionId: () => null,
    log: () => {},
  });
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    // A provider must resolve for the runtime to boot (mirrors autoresearch-live);
    // the registration tests never prompt, so this key is never used.
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "omp-ui-live-test-dummy",
  };
  const client = new RpcClient({
    cwd: project,
    lineageDir: lineage,
    ompPath: ompPath!,
    configOverlays: [],
    initialCommands: [setHostUriSchemesCommand(), setHostToolsCommand()],
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

describe.skipIf(ompPath === null)("host registration on the real runtime", () => {
  it("omp accepts the omp-ui scheme and the omp-ui_notify tool", async () => {
    scope = spawnScope();
    const uriResponse = await waitFor(
      () => scope!.frames.find((f) => f.type === "response" && f.id === "omp-ui-host-uri-1"),
      25_000,
      "the set_host_uri_schemes response",
    );
    expect(uriResponse).toMatchObject({ success: true, data: { schemes: ["omp-ui"] } });
    const toolsResponse = await waitFor(
      () => scope!.frames.find((f) => f.type === "response" && f.id === "omp-ui-host-tools-1"),
      25_000,
      "the set_host_tools response",
    );
    expect(toolsResponse).toMatchObject({
      success: true,
      data: { toolNames: ["omp-ui_notify"] },
    });
  }, 60_000);
});

describe.skipIf(ompPath === null || !hasApiKey)("host answering on the real runtime", () => {
  it("omp hands an omp-ui://plan read to the host bridge", async () => {
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
      message: "Use the read tool on the URL omp-ui://plan once. Then reply DONE.",
    } as never);
    const request = await waitFor(
      () => scope!.frames.find((f) => f.type === "host_uri_request"),
      90_000,
      "the host_uri_request for omp-ui://plan",
    );
    expect(request).toMatchObject({ operation: "read", url: "omp-ui://plan" });
    // The bridge answered it — exactly one result, the no-plan error for a
    // session that never proposed a plan — and omp saw that answer.
    await waitFor(
      () => (scope!.sent.some((f) => f.type === "host_uri_result") ? true : undefined),
      10_000,
      "the bridge's host_uri_result",
    );
    expect(scope.sent.filter((f) => f.type === "host_uri_result")).toHaveLength(1);
    expect(scope.sent.at(-1)).toMatchObject({
      type: "host_uri_result",
      id: request.id,
      isError: true,
      error: "no plan has been proposed for this session yet",
    });
  }, 180_000);

  it("omp hands an omp-ui_notify call to the host bridge", async () => {
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
      message: "Call the omp-ui_notify tool once with message \"live check\". Then reply DONE.",
    } as never);
    const call = await waitFor(
      () => scope!.frames.find((f) => f.type === "host_tool_call"),
      90_000,
      "the host_tool_call for omp-ui_notify",
    );
    expect(call).toMatchObject({ toolName: "omp-ui_notify" });
    await waitFor(
      () => (scope!.sent.some((f) => f.type === "host_tool_result") ? true : undefined),
      10_000,
      "the bridge's host_tool_result",
    );
    expect(scope.sent.filter((f) => f.type === "host_tool_result")).toHaveLength(1);
    expect(scope.sent.at(-1)).toMatchObject({
      type: "host_tool_result",
      id: call.id,
      result: { content: [{ type: "text", text: "posted" }] },
    });
  }, 180_000);
});
