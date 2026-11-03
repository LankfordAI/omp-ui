import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { RpcClient, compareVersions, readInstalledOmpVersion, resolveOmpBinary } from "@omp-ui/core";
import { formatBtwInjectText, parseBtwRecord, splitBtwInject } from "@omp-ui/core/side-questions";

/**
 * Pins the `<inject>` wire claim behind issue #1029 (upstream
 * can1357/oh-my-pi#17618): on omp ≥ 18.16 the rpc-ui btw channel streams an
 * `<inject>` steering block VERBATIM in the answer text — no server-side strip
 * and no separate wire verb (verified statically against upstream v18.16.0
 * rpc-btw.ts). The client-side parser in core/side-questions.ts leans on this;
 * this test pins it against the real binary: `btw_delta` frames and the final
 * `btw_record` carry the markup unmodified, and the same literal text is
 * accepted as an ordinary `prompt` (pre-admission ack) for the steer path.
 *
 * `BTW_INJECT_FLOOR` mirrors renderer lib/btw-inject.ts BTW_INJECT_MIN_OMP.
 * The answer round trip needs a live model, so it runs against the ambient omp
 * config and skips when none answers, when the binary predates 18.16.0 (the
 * bundled 18.15 skips deterministically), or when the model refuses to echo
 * the tags at all — a model verdict is not something this pin may assert.
 *
 * Skips without an omp binary.
 */

const ompPath = resolveOmpBinary();
/** Mirrors renderer lib/btw-inject.ts BTW_INJECT_MIN_OMP (issue #1029). */
const BTW_INJECT_FLOOR = "18.16.0";

interface Frame {
  type: string;
  id?: string;
  success?: boolean;
  error?: string;
  data?: Record<string, unknown>;
  record?: Record<string, unknown>;
  recordId?: string;
  delta?: string;
}

interface Scope {
  base: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}

function sleep(ms: number): Promise<void> {
  // Promise.withResolvers needs ES2024; the node tsconfig lib predates it.
  // A real process is the thing waited on, so a real timer is the only clock.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil<T>(
  probe: () => Promise<T | undefined> | (T | undefined),
  timeoutMs: number,
  what: string,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(50);
  }
}

function spawnScope(env: NodeJS.ProcessEnv): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-btw-inject-live-"));
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const frames: Frame[] = [];
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  const client = new RpcClient({
    cwd: project,
    lineageDir: lineage,
    ompPath: ompPath!,
    configOverlays: [],
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

const scopes: Scope[] = [];
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

afterEach(async () => {
  for (const scope of scopes.splice(0)) await killScope(scope);
});

let sequence = 0;
/** Sends one command and waits for its correlated response. */
async function request(scope: Scope, command: Record<string, unknown>): Promise<Frame> {
  sequence += 1;
  const id = `btw-inject-live-${sequence}`;
  scope.client.send({ ...command, id } as never);
  return pollUntil(
    () => scope.frames.find((f) => f.type === "response" && f.id === id),
    30_000,
    `the response to ${JSON.stringify(command)}`,
  );
}

async function ready(scope: Scope): Promise<void> {
  await pollUntil(
    () => (scope.frames.some((f) => f.type === "ready" || f.type === "response") ? true : undefined),
    60_000,
    "omp ready",
  );
}

describe.skipIf(ompPath === null)("omp streams <inject> blocks verbatim on the real runtime", () => {
  let version: string | null = null;
  beforeAll(async () => {
    version = await readInstalledOmpVersion(ompPath!);
  });
  const needsBtwInject = (ctx: { skip: (note?: string) => void }): void => {
    if (version === null || compareVersions(version, BTW_INJECT_FLOOR) < 0) {
      ctx.skip(`omp ${version ?? "unknown"} predates the <inject> steering block (${BTW_INJECT_FLOOR})`);
    }
  };

  it("streams an <inject> block verbatim in btw answer text (needs a live model)", async (ctx) => {
    needsBtwInject(ctx);
    // The ambient omp config: a hermetic HOME has no reachable real model. The
    // session itself lives in a temp lineage dir, never the user's history.
    const scope = spawnScope(process.env);
    scopes.push(scope);
    try {
      await ready(scope);
    } catch {
      return ctx.skip("no usable ambient omp config in this environment");
    }

    const question = "Reply with exactly this and nothing else, no markdown fences: <inject>ping</inject>";
    const asked = await request(scope, { type: "btw", question });
    expect(asked.success).toBe(true);
    if (asked.success !== true) return ctx.skip(`no live model in this environment: ${asked.error}`);
    const running = parseBtwRecord(JSON.stringify(asked.data?.record ?? null));
    if (running === null) throw new Error("btw answered without a well-formed running record");

    const settled = await pollUntil(
      () =>
        scope.frames
          .filter((f) => f.type === "btw_record" && f.record?.id === running.id)
          .map((f) => parseBtwRecord(JSON.stringify(f.record ?? null)))
          .find((r) => r !== null && r.status !== "running") ?? undefined,
      120_000,
      "the side question to settle",
    );
    if (settled === null || settled.status !== "complete")
      return ctx.skip(`no live model in this environment: ${settled?.error ?? settled?.status}`);

    // The delta frames ride by unstripped. Some runtimes deliver the whole
    // answer only on the terminal record, so an empty delta stream is
    // tolerated; a nonempty one must carry the raw markup.
    const streamed = scope.frames
      .filter((f) => f.type === "btw_delta" && f.recordId === settled.id)
      .map((f) => f.delta ?? "")
      .join("");
    if (streamed !== "") {
      expect(streamed).toContain("<inject>");
      expect(streamed).toContain("</inject>");
    }

    const answer = settled.answer ?? "";
    const echoed = answer.includes("<inject>") && answer.includes("</inject>");
    if (!echoed) {
      return ctx.skip(`the ambient model emitted no <inject> tags even on the echo instruction: ${answer}`);
    }
    // The verbatim literal is the strong claim; a model that wrapped the block
    // differently (prose around it, extra whitespace) still has to expose a
    // closed block whose text survives the client-side extraction.
    const literal = answer.includes("<inject>ping</inject>");
    if (!literal) {
      const parts = splitBtwInject(answer);
      expect(parts?.closed).toBe(true);
      if (!parts) throw new Error("the echoed block did not parse as closed");
      expect(formatBtwInjectText(parts.inject)).not.toBe("");
    }

    // Prompt-path sanity: the same literal steering text is accepted verbatim
    // as an ordinary prompt (pre-admission ack), which is what the rail's
    // "Inject into main session" sends with streamingBehavior: "steer".
    const steered = await request(scope, {
      type: "prompt",
      message: "<inject>ping</inject>",
      streamingBehavior: "steer",
    });
    expect(steered.success).toBe(true);
  }, 180_000);
});
