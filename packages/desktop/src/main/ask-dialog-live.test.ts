import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient, askDialogResponse, setAskDialogCommand, resolveOmpBinary } from "@omp-ui/core";

/**
 * Live proof for the multi-question `ask` dialog (issue #1234) against the
 * REAL `omp --mode=rpc-ui` binary — run it with OMP_UI_OMP_PATH pointed at
 * 19.0.0 (`/tmp/omp-19.0.0/omp`) and against the installed 18.22.2: both
 * accept `set_ask_dialog` and speak the identical wire.
 *
 * What it proves end to end, with a probe extension calling
 * `ui.askDialog` (no model turn, so no provider is ever contacted):
 * - `ui.askDialog` is undefined until the host sends `set_ask_dialog` — the
 *   boot rail's opt-in is what opens the one-frame ask path (an opted-out or
 *   older build keeps the field-by-field walk: the gate here IS the fallback
 *   posture);
 * - the enabled call arrives as ONE `extension_ui_request { method: "ask",
 *   questions }` carrying ids, options, multi and recommended verbatim;
 * - the renderer's answer builder (`askDialogResponse`) round-trips: each
 *   question reaches the extension with its exact selected labels and custom
 *   input;
 * - a `{ cancelled: true }` reply — exactly what Skip & send sends — settles
 *   the call with `undefined`, not an error;
 * - a timeout answers every question with its recommended option, else its
 *   first (omp's timer, not the host's), and emits `cancel { targetId }`
 *   naming the ask frame, which is what dismisses the card unanswered.
 */

const ompPath = resolveOmpBinary();

function requiredOmpPath(): string {
  if (ompPath === null) throw new Error("Live ask proofs require OMP 18.22 or newer; no live proof may skip.");
  return ompPath;
}

const CONFIG_YML = `startup:
  checkUpdate: false
retry:
  enabled: false
`;

/** The probe extension's fixed protocol with this test: `/probe-ask [timeout]`
 *  calls ui.askDialog once and notifies the settled result as JSON. Options
 *  are label objects throughout: upstream validates answers against
 *  `options.map(o => o.label)` and fills timeout defaults the same way, so a
 *  bare-string option would fail both paths — the wire contract is objects. */
const PROBE_EXTENSION = `export default function (pi) {
  pi.registerCommand("probe-ask", {
    description: "call ui.askDialog once and notify the result",
    handler: async (args, ctx) => {
      const ui = ctx.ui;
      if (!ui.askDialog) {
        ui.notify("PROBE NO_ASKDIALOG");
        return;
      }
      const questions = [
        { id: "db", question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }], recommended: 1 },
        { id: "features", question: "Which features?", options: [{ label: "Auth" }, { label: "Billing" }], multi: true },
      ];
      const result = await ui.askDialog(questions, args === "timeout" ? { timeout: 4000 } : undefined);
      ui.notify("PROBE RESULT " + JSON.stringify(result ?? null));
    },
  });
}
`;

interface Frame {
  type: string;
  id?: string;
  method?: string;
  command?: string;
  success?: boolean;
  message?: string;
  targetId?: unknown;
  questions?: unknown;
}

interface Scope {
  base: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}

function sleep(ms: number): Promise<void> {
  // Real timers: the thing waited on is a real OS process.
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

function spawnScope(enable: boolean): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-ask-dialog-live-"));
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  const home = path.join(base, "home");
  const extension = path.join(base, "probe");
  fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(extension, { recursive: true });
  fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), CONFIG_YML);
  fs.writeFileSync(path.join(extension, "probe-ask.js"), PROBE_EXTENSION);
  const frames: Frame[] = [];
  // Executor form on purpose: Promise.withResolvers needs ES2024 and the
  // node tsconfig lib predates it (the event-filter-live.test.ts idiom).
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
    // A provider must resolve for the runtime to boot (mirrors event-filter-
    // live / knowledge-vault-live); the probe only calls ui.askDialog — no
    // model turn — so this dummy is never used against a provider. Without it
    // the ready frame never arrives on a clean runner with no ambient keys.
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? "omp-ui-live-test-dummy",
  };
  const client = new RpcClient({
    cwd: project,
    lineageDir: lineage,
    ompPath: requiredOmpPath(),
    extensions: [extension],
    // The same command session-manager.ts rides the boot rail with. With
    // enable=false no opt-in goes out at all — the older-build posture.
    initialCommands: enable ? [setAskDialogCommand()] : [],
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
  const exitedNow = await Promise.race([scope.exited.then(() => true), sleep(8_000).then(() => false)]);
  if (!exitedNow) scope.client.kill("SIGKILL");
  await sleep(150);
  fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const disposers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

/** Boots one scope and waits out the ready handshake (and, enabled, the
 *  opt-in's own success response — the boot-rail guarantee). */
async function booted(enable: boolean): Promise<Scope> {
  const scope = spawnScope(enable);
  disposers.push(() => kill(scope));
  await waitFor(() => scope.frames.find((f) => f.type === "ready"), 20_000, "the ready frame");
  if (enable) {
    const response = await waitFor(
      () =>
        scope.frames.find(
          (f) => f.type === "response" && f.command === "set_ask_dialog",
        ),
      20_000,
      "the set_ask_dialog response",
    );
    expect(response.success).toBe(true);
  }
  return scope;
}

function extRequest(scope: Scope, method: string, after = 0): Frame | undefined {
  return scope.frames
    .slice(after)
    .find((f) => f.type === "extension_ui_request" && f.method === method);
}

function probeNotify(scope: Scope, prefix: string, after = 0): Frame | undefined {
  return scope.frames
    .slice(after)
    .find((f) => f.type === "extension_ui_request" && f.method === "notify" && (f.message ?? "").startsWith(prefix));
}

describe("multi-question ask dialog against the real binary (issue #1234)", () => {
  it("answers a multi-question ask exactly as the renderer builds it", async () => {
    const scope = await booted(true);
    scope.client.send({ type: "prompt", message: "/probe-ask" } as never);

    const request = await waitFor(() => extRequest(scope, "ask"), 20_000, "the ask request");
    // The probed wire shape, verbatim: questions of both styles, no title.
    expect(request.questions).toEqual([
      {
        id: "db",
        question: "Which database?",
        options: [{ label: "Postgres" }, { label: "SQLite" }],
        recommended: 1,
      },
      {
        id: "features",
        question: "Which features?",
        options: [{ label: "Auth" }, { label: "Billing" }],
        multi: true,
      },
    ]);
    const before = scope.frames.length;
    // The very payload the renderer's submit path builds through core.
    scope.client.send({
      type: "extension_ui_response",
      id: request.id!,
      ...askDialogResponse(
        [
          { id: "db", question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }], multi: false, recommended: 1 },
          { id: "features", question: "Which features?", options: [{ label: "Auth" }, { label: "Billing" }], multi: true },
        ],
        { db: { selectedOptions: [], customInput: "DuckDB" }, features: { selectedOptions: ["Auth"] } },
      ),
    } as never);

    const settled = await waitFor(() => probeNotify(scope, "PROBE RESULT", before), 20_000, "the extension's result");
    expect(JSON.parse((settled.message ?? "").slice("PROBE RESULT ".length).trim())).toEqual({
      kind: "submit",
      results: [
        { id: "db", question: "Which database?", options: ["Postgres", "SQLite"], multi: false, selectedOptions: [], customInput: "DuckDB" },
        { id: "features", question: "Which features?", options: ["Auth", "Billing"], multi: true, selectedOptions: ["Auth"] },
      ],
    });
  }, 60_000);

  it("settles the ask with undefined on the Skip & send cancel", async () => {
    const scope = await booted(true);
    scope.client.send({ type: "prompt", message: "/probe-ask" } as never);
    const request = await waitFor(() => extRequest(scope, "ask"), 20_000, "the ask request");
    const before = scope.frames.length;
    // Exactly what skipPendingQuestion sends with the composer's draft.
    scope.client.send({ type: "extension_ui_response", id: request.id!, cancelled: true } as never);
    const settled = await waitFor(() => probeNotify(scope, "PROBE RESULT", before), 20_000, "the extension's result");
    expect(settled.message).toBe("PROBE RESULT null");
  }, 60_000);

  it("times out with the recommended-or-first defaults and a cancel naming the ask frame", async () => {
    const scope = await booted(true);
    scope.client.send({ type: "prompt", message: "/probe-ask timeout" } as never);
    const request = await waitFor(() => extRequest(scope, "ask"), 20_000, "the ask request");
    // omp's own timer answers every question — the host sends nothing.
    const settled = await waitFor(
      () => probeNotify(scope, "PROBE RESULT", scope.frames.indexOf(request)),
      20_000,
      "the timed-out result",
    );
    const results = JSON.parse((settled.message ?? "").slice("PROBE RESULT ".length).trim()).results as Array<{
      id: string;
      selectedOptions: string[];
      timedOut?: boolean;
    }>;
    expect(results.map((r) => [r.id, r.selectedOptions, r.timedOut])).toEqual([
      ["db", ["SQLite"], true],
      ["features", ["Auth"], true],
    ]);
    // And the card dismissal: a cancel frame names the ask's own id (#1191
    // rule) — late answers after this point would be ignored by omp.
    const cancel = await waitFor(
      () => scope.frames.find((f) => f.method === "cancel" && f.targetId === request.id),
      20_000,
      "the cancel frame naming the ask",
    );
    expect(cancel.type).toBe("extension_ui_request");
  }, 60_000);

  it("leaves ui.askDialog undefined when the host never opted in", async () => {
    // The older-build posture, on a build that DOES support the command: no
    // set_ask_dialog on the rail means no ask frame and no error — the
    // extension sees askDialog absent, which is what keeps the field-by-field
    // select/editor walk (the fallback omp-ui keeps answering today).
    const scope = await booted(false);
    scope.client.send({ type: "prompt", message: "/probe-ask" } as never);
    const notify = await waitFor(() => probeNotify(scope, "PROBE NO_ASKDIALOG"), 20_000, "the gate notice");
    expect(notify.message).toBe("PROBE NO_ASKDIALOG");
    expect(extRequest(scope, "ask")).toBeUndefined();
  }, 60_000);
});
