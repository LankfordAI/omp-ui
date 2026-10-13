import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  PRIVATE_DISABLED_TOOLS,
  RpcClient,
  capabilitiesMessage,
  privateGuardArmMessage,
  resolveOmpBinary,
  writeCapabilitiesExtension,
  writePrivateGuardExtension,
  writePrivateOverlay,
} from "@omp-ui/core";
import {
  CAPABILITIES_STATUS_KEY,
  parseCapabilitySnapshot,
  type CapabilitySnapshot,
} from "@omp-ui/core/capabilities";

/**
 * Live proof for private sessions (issue #852) against the real
 * `omp --mode=rpc-ui` binary — the same skip-when-no-binary discipline as
 * capability-control-live.test.ts.
 *
 * Two claims, both read back from inside a real session — never from
 * `omp config get`, which ignores `--config` and would prove nothing:
 *
 * 1. The overlay outranks the user's own project config: with both keys
 *    pinned TRUE at the project layer, a private spawn's effective settings
 *    read false for autolearn.enabled and mnemopi.autoRetain while
 *    mnemopi.autoRecall — deliberately unlisted — stays true, and an
 *    ordinary spawn of the same project reads all three true.
 * 2. The guard's arm command removes the memory-WRITE tools from the live
 *    roster, proved pairwise: an ordinary spawn and a private spawn of the
 *    identical hermetic scope publish their rosters through the real
 *    capabilities bridge, and the enabled-set difference is exactly the
 *    registered write tools — no collateral removal, and recall/reflect
 *    unchanged (write-quiet, never read-quiet).
 *
 * Every arm here is an extension command, so no user render item and no
 * assistant turn may appear throughout. HOME/XDG point at the temp scope:
 * the run reads and writes no global omp state. Real timers throughout (the
 * awaited actor is an OS process speaking NDJSON — fake clocks cannot make
 * it publish); every wait ends on an observed frame condition.
 */

const ompPath = resolveOmpBinary();

/** Both write channels pinned true by the USER's project layer: the proof
 *  shows the private overlay outranks the user's config, not omp's defaults. */
const PROJECT_MEMORY_ON = "autolearn:\n  enabled: true\nmnemopi:\n  autoRetain: true\n";

/** Publishes the runtime's effective truth for the three memory settings. */
const CONFIG_PROBE_EXT = `
let lookup = null;
// @ts-expect-error -- literal specifier resolved by omp's extension loader (ADR-0036)
void import("@oh-my-pi/pi-coding-agent/config/registry").then(
  (mod) => { lookup = mod?.lookup ?? null; },
  () => undefined,
);
let root = null;
export default function (pi) {
  // The probe command itself dispatches through prompt, so it binds the
  // root session whose \`settings\` it reads (ADR-0008 discipline).
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
  pi.registerCommand("private-config-probe", {
    description: "publish effective memory-setting values",
    handler: async (_args, ctx) => {
      const settings = root?.settings ?? {};
      const read = (id) => {
        if (lookup === null) return "unreadable";
        try {
          const s = lookup(id);
          return String(s?.get?.(settings) ?? "unset");
        } catch {
          return "error";
        }
      };
      ctx.ui.setStatus("private-config-probe", JSON.stringify({
        autolearn: read("autolearn.enabled"),
        retain: read("mnemopi.autoRetain"),
        recall: read("mnemopi.autoRecall"),
      }));
    },
  });
}
`;

interface Frame {
  type: string;
  statusKey?: string;
  statusText?: string;
  message?: { role?: string };
}

// Real timers on purpose (see header): every wait below ends on an observed
// frame condition. Promise.withResolvers needs ES2024; the node tsconfig
// targets ES2022 (same reason as every sibling live test).
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
  lineage: string;
  overlay: string | null;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}

function spawnScope(opts: { privateSession: boolean; projectConfig?: string }): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-privlive-"));
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  const home = path.join(base, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
  fs.writeFileSync(
    path.join(project, ".omp", "config.yml"),
    opts.projectConfig ?? PROJECT_MEMORY_ON,
  );
  const overlay = writePrivateOverlay(lineage, opts.privateSession);
  const guardExt = writePrivateGuardExtension(lineage);
  const capExt = writeCapabilitiesExtension(lineage);
  const probeExt = path.join(lineage, "private-config-probe.ts");
  fs.writeFileSync(probeExt, CONFIG_PROBE_EXT);
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
    extensions: [capExt, guardExt, probeExt],
    ...(opts.privateSession
      ? { initialCommands: [{ type: "prompt", message: privateGuardArmMessage() }] }
      : {}),
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
  return { base, lineage, overlay, frames, client, exited };
}

/** Arms the capabilities bridge and resolves with its first available
 *  roster. The bridge publishes only once a command has attached its ui,
 *  so this command — never a poll — is the publish trigger. */
async function armCapabilities(scope: Scope): Promise<CapabilitySnapshot> {
  const from = scope.frames.length;
  scope.client.send({ type: "prompt", message: capabilitiesMessage() } as never);
  return waitFor(
    () => snapshotsAfter(scope, from).find((s) => s.tools.status === "available"),
    60_000,
    "a capabilities publish with an available tool roster",
  );
}

interface ProbePublish {
  autolearn: string;
  retain: string;
  recall: string;
}

async function probeSettings(scope: Scope): Promise<ProbePublish> {
  const from = scope.frames.length;
  scope.client.send({ type: "prompt", message: "/private-config-probe" } as never);
  return waitFor(() => {
    const frame = scope.frames
      .slice(from)
      .find((f) => f.type === "extension_ui_request" && f.statusKey === "private-config-probe");
    return frame?.statusText === undefined
      ? undefined
      : (JSON.parse(frame.statusText) as ProbePublish);
  }, 60_000, "the private-config-probe publish");
}

function snapshotsAfter(scope: Scope, from: number): CapabilitySnapshot[] {
  return scope.frames
    .slice(from)
    .filter((f) => f.type === "extension_ui_request" && f.statusKey === CAPABILITIES_STATUS_KEY)
    .map((f) => parseCapabilitySnapshot(f.statusText))
    .filter((s): s is CapabilitySnapshot => s !== null);
}

function toolState(snapshot: CapabilitySnapshot, name: string): boolean | undefined {
  if (snapshot.tools.status !== "available") return undefined;
  const enabled = snapshot.tools.items.find((t) => t.name === name)?.enabled;
  return typeof enabled === "boolean" ? enabled : undefined;
}

function enabledNames(snapshot: CapabilitySnapshot): Set<string> {
  if (snapshot.tools.status !== "available") return new Set();
  return new Set(snapshot.tools.items.filter((t) => t.enabled).map((t) => t.name));
}

function userMessagesAfter(scope: Scope, from: number): Frame[] {
  return scope.frames.slice(from).filter((f) => f.type === "message_start" && f.message?.role === "user");
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

describe.skipIf(ompPath === null)("private sessions on the real runtime", () => {
  it("the private overlay outranks the user's project config", { timeout: 180_000 }, async () => {
    const scope = track(spawnScope({ privateSession: true }));
    const published = await probeSettings(scope);
    // The project layer pins BOTH write keys true; the session's private
    // overlay must win, or the promise a private session makes is a lie
    // against any user who ever enabled these keys.
    expect(published.autolearn).toBe("false");
    expect(published.retain).toBe("false");
    // Recall is deliberately unlisted: with the project layer silent on it,
    // omp's default keeps a private session able to remember.
    expect(published.recall).toBe("true");
    // The overlay file itself never names the read-side switches — absence
    // is the design (ADR-0055: only the write channels are pinned).
    const overlayText = fs.readFileSync(scope.overlay!, "utf8");
    expect(overlayText).not.toContain("autoRecall");
    expect(overlayText).not.toContain("memory.backend");
  });

  it("an ordinary session of the same project keeps the user's config", { timeout: 180_000 }, async () => {
    const scope = track(spawnScope({ privateSession: false }));
    const published = await probeSettings(scope);
    // Same project layer, no overlay: every key stays where the user put it.
    expect(published.autolearn).toBe("true");
    expect(published.retain).toBe("true");
    expect(published.recall).toBe("true");
    // A non-private spawn lays no overlay artifact at all.
    expect(scope.overlay).toBeNull();
  });

  it("the arm removes exactly the registered write tools, pairwise", { timeout: 300_000 }, async () => {
    const baseline = track(spawnScope({ privateSession: false }));
    const guarded = track(spawnScope({ privateSession: true }));
    // The baseline arms the bridge directly: its roster is what a plain
    // session runs. The guarded scope armed the guard via initialCommands;
    // the bridge command below attaches the ui and publishes POST-arm truth.
    const baseRoster = await armCapabilities(baseline);
    const guardRoster = await armCapabilities(guarded);

    const baseEnabled = enabledNames(baseRoster);
    const guardEnabled = enabledNames(guardRoster);

    // Every write tool the runtime registers and enables must be gone from
    // the guarded session's enabled set.
    for (const name of PRIVATE_DISABLED_TOOLS) {
      if (baseEnabled.has(name)) {
        expect(guardEnabled.has(name), `${name} removed from enabled set`).toBe(false);
      }
    }
    // At least one write tool was actually in play, or the removal above
    // proved nothing.
    expect(
      PRIVATE_DISABLED_TOOLS.some((name) => baseEnabled.has(name)),
      "the runtime registers at least one memory-write tool",
    ).toBe(true);

    // No collateral damage: whatever the plain session runs enabled, the
    // guarded session keeps enabled except for write tools.
    const disabled = new Set<string>(PRIVATE_DISABLED_TOOLS);
    for (const name of baseEnabled) {
      if (!disabled.has(name)) {
        expect(guardEnabled.has(name), `${name} untouched by the guard`).toBe(true);
      }
    }
    // The read half is unchanged wherever both rosters can speak about it.
    for (const name of ["recall", "reflect"]) {
      const before = toolState(baseRoster, name);
      const after = toolState(guardRoster, name);
      if (before !== undefined && after !== undefined) expect(after, `${name} unchanged`).toBe(before);
    }
    // Every command sent was an extension command: never a user turn.
    expect(userMessagesAfter(baseline, 0)).toHaveLength(0);
    expect(userMessagesAfter(guarded, 0)).toHaveLength(0);
  });
});
