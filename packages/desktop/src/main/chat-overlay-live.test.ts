import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient, resolveOmpBinary, writeChatOverlay } from "@omp-ui/core";

/**
 * Live proof for the chat memory overlay (issue #894, ADR-0059) against the
 * real `omp --mode=rpc-ui` binary — the same skip-when-no-binary discipline
 * as private-guard-live.test.ts.
 *
 * With the user's project layer pinning `mnemopi.scoping: per-project-tagged`,
 * a chat spawn's effective scoping, read back from INSIDE the session (never
 * `omp config get`, which ignores `--config`), is `global`; an ordinary spawn
 * of the identical scope keeps `per-project-tagged`. HOME/XDG point at the
 * temp scope. Real timers: the awaited actor is an OS process speaking NDJSON;
 * every wait ends on an observed frame condition.
 */

const ompPath = resolveOmpBinary();

const PROJECT_SCOPING = "mnemopi:\n  scoping: per-project-tagged\n";

/** Publishes the runtime's effective mnemopi.scoping. */
const SCOPING_PROBE_EXT = `
let lookup = null;
// @ts-expect-error -- literal specifier resolved by omp's extension loader (ADR-0036)
void import("@oh-my-pi/pi-coding-agent/config/registry").then(
  (mod) => { lookup = mod?.lookup ?? null; },
  () => undefined,
);
let root = null;
export default function (pi) {
  try {
    const proto = pi.pi?.AgentSession?.prototype;
    const original = proto?.prompt;
    if (proto && typeof original === "function") {
      proto.prompt = function () {
        if (root === null) root = this;
        return original.apply(this, arguments);
      };
    }
  } catch { /* no prototype: the publish below reports unreadable */ }
  pi.registerCommand("chat-scoping-probe", {
    description: "publish the effective mnemopi.scoping",
    handler: async (_args, ctx) => {
      let scoping = "unreadable";
      if (lookup !== null) {
        try {
          scoping = String(lookup("mnemopi.scoping")?.get?.(root?.settings ?? {}) ?? "unset");
        } catch {
          scoping = "error";
        }
      }
      ctx.ui.setStatus("chat-scoping-probe", scoping);
    },
  });
}
`;

interface Frame {
  type: string;
  statusKey?: string;
  statusText?: string;
}

// Promise.withResolvers needs ES2024; the node tsconfig targets ES2022.
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

function spawnScope(chat: boolean): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-chatlive-"));
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(project, ".omp", "config.yml"), PROJECT_SCOPING);
  const overlay = writeChatOverlay(lineage, chat);
  const probeExt = path.join(lineage, "chat-scoping-probe.ts");
  fs.writeFileSync(probeExt, SCOPING_PROBE_EXT);
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
    configOverlays: overlay === null ? [] : [overlay],
    extensions: [probeExt],
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

async function probeScoping(scope: Scope): Promise<string> {
  const from = scope.frames.length;
  scope.client.send({ type: "prompt", message: "/chat-scoping-probe" } as never);
  return waitFor(
    () =>
      scope.frames
        .slice(from)
        .find((f) => f.type === "extension_ui_request" && f.statusKey === "chat-scoping-probe")?.statusText,
    60_000,
    "the chat-scoping-probe publish",
  );
}

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

function track(scope: Scope): Scope {
  disposers.push(async () => {
    scope.client.kill();
    const exitedNow = await Promise.race([
      scope.exited.then(() => true),
      sleep(8_000).then(() => false),
    ]);
    if (!exitedNow) scope.client.kill("SIGKILL");
    await sleep(150);
    fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return scope;
}

describe.skipIf(ompPath === null)("chat memory overlay on the real runtime", () => {
  it("a chat reads the global bank over the project's per-project scoping", { timeout: 180_000 }, async () => {
    expect(await probeScoping(track(spawnScope(true)))).toBe("global");
  });

  it("an ordinary spawn of the same scope keeps the project's scoping", { timeout: 180_000 }, async () => {
    expect(await probeScoping(track(spawnScope(false)))).toBe("per-project-tagged");
  });
});
