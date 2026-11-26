import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RpcClient,
  parseModelRole,
  resolveOmpBinary,
  writeDefaultModelOverlay,
  writeSubagentModelOverlay,
} from "@omp-ui/core";
import { LiveExitTracker, closeAwareSpawn, waitForOrExit } from "./test/live-exit";

/**
 * The load-bearing live proof for ADR-0031: omp re-reads the `--config`
 * subagent overlay before EVERY subagent spawn. One real `omp --mode=rpc-ui`
 * process spawns a `task` subagent on the parent model; the overlay file is
 * then rewritten in place — no restart — and a second spawn must run on the
 * pinned model, proven from the two subagent transcripts' model_change lines.
 *
 * A second proof pins #881: `"*"` resolves through `modelRoles.default`, not
 * the parent's live model, so a `set_model` alone leaves inheriting subagents
 * on the boot model until the default-model overlay is rewritten in place.
 *
 * Requires a reachable omp and a model session that can actually answer. Both
 * follow the #86 convention of skipping cleanly when the environment cannot
 * produce them (#744, #1229): an oauth-free or credential-poor boot still
 * answers `get_state` and accepts prompts with `success: true`, so readiness
 * alone proves nothing — the suite checks `get_available_models` up front and
 * skips on the first provider-errored prompt turn instead of hanging the full
 * spawn timeout waiting for a subagent the dead turn can never spawn.
 */
type Frame = {
  type: string;
  id?: string;
  command?: string;
  success?: boolean;
  data?: {
    subagents?: Array<{ id: string; name?: string; agent?: string; status?: string; sessionFile?: string }>;
    models?: Array<{ id?: string; provider?: string }>;
    isStreaming?: boolean;
    queuedMessageCount?: number;
  };
  message?: {
    role?: string;
    provider?: string;
    model?: string;
    stopReason?: string;
    errorStatus?: number;
    errorMessage?: string;
  };
  payload?: unknown;
};

/** Concrete id — a `…-latest` alias may resolve to a dated id in the transcript. */
const PIN_SELECTOR =
  process.env.OMP_UI_LIVE_SUBAGENT_MODEL ?? "openrouter/openai/gpt-5.6-luna:medium";
/** model_change carries the model id; thinking level is a separate transcript entry. */
const PIN_MODEL = PIN_SELECTOR.replace(/:[a-z]+$/, "");
/** The #881 proof's boot model: any cheap model distinct from the pin. */
const BOOT_SELECTOR =
  process.env.OMP_UI_LIVE_SUBAGENT_BOOT_MODEL ?? "openrouter/z-ai/glm-5.3-flash:low";
const BOOT_MODEL = BOOT_SELECTOR.replace(/:[a-z]+$/, "");
function spawnPrompt(ordinal: number): string {
  return (
    "This is a required live verification of the task tool. MUST call the task tool exactly once. " +
    `Use agent task and name it LiveCheck${ordinal}. Give it a self-contained task that says reply with exactly ok. ` +
    "After the task tool returns its spawned-job receipt, DO NOT call hub, wait, or any other tool. " +
    "Reply done immediately; the test harness observes the child itself."
  );
}
const READY_TIMEOUT_MS = 90_000;
const SPAWN_TIMEOUT_MS = 240_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(150);
  }
}

/** Marks "the environment could not produce an oauth session" — the suite skips on this. */
class OauthUnavailable extends Error {}

/**
 * Marks "a model session exists but cannot answer" (#1229): the live CI
 * evidence is a prompt turn that ends `stopReason: "error"` (402 out of
 * credits on the credential-less runner's fallback model) while the harness
 * waits 240 s for a subagent the dead turn never spawns. An oauth-ready boot
 * is NOT promptable — CI proves both.
 */
class ModelUnavailable extends Error {}

function skipIfEnvironmentUnavailable(
  ctx: { skip: (reason?: string) => never },
  error: unknown,
): void {
  if (error instanceof OauthUnavailable || error instanceof ModelUnavailable) {
    ctx.skip(error.message);
  }
  throw error;
}

const ompPath = resolveOmpBinary();
const scopes: string[] = [];
afterEach(() => {
  for (const dir of scopes.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

/** The model a subagent transcript resolved to — its first model_change line. */
function transcriptModel(sessionFile: string): string {
  for (const line of fs.readFileSync(sessionFile, "utf8").split("\n")) {
    if (!line.includes('"model_change"')) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; model?: string };
      if (entry.type === "model_change" && typeof entry.model === "string") return entry.model;
    } catch {
      // A partially flushed line is not evidence either way; keep scanning.
    }
  }
  throw new Error(`no model_change line in ${sessionFile}`);
}

/**
 * If the PARENT session transcript's LATEST assistant turn ended at the
 * provider, its one-line summary; null otherwise (a recovered run's newest
 * turn is healthy, so a transient failure never trips this). Reads only the
 * top-level lineage files — subagent transcripts live in the per-session
 * subdirectory, so a dead child never counts here (#1229: the CI runner's
 * credit-less parent turn dies at 402 seconds after the ack, and the spawn it
 * can never perform used to hang the full budget).
 */
function parentDeath(lineage: string): string | null {
  let last: { ok: boolean; summary: string } | null = null;
  for (const name of fs.readdirSync(lineage).filter((n) => n.endsWith(".jsonl"))) {
    for (const line of fs.readFileSync(path.join(lineage, name), "utf8").split("\n")) {
      if (!line.includes('"role":"assistant"')) continue;
      try {
        const entry = JSON.parse(line) as {
          message?: { provider?: string; model?: string; stopReason?: string; errorMessage?: string };
        };
        const m = entry.message ?? {};
        if (m.stopReason === "error") {
          last = {
            ok: false,
            summary: `${String(m.provider)}/${String(m.model)}: ${String(m.errorMessage ?? "turn ended at the provider").slice(0, 200)}`,
          };
        } else if (m.stopReason !== undefined) {
          last = { ok: true, summary: "" };
        }
      } catch {
        // A partially flushed line is not evidence either way; keep scanning.
      }
    }
  }
  return last !== null && !last.ok ? last.summary : null;
}

interface Harness {
  client: RpcClient;
  frames: Frame[];
  exited: Promise<void>;
  /** Sends one command under a generated id and resolves its response frame. */
  command(cmd: Record<string, unknown>, timeoutMs?: number): Promise<Frame>;
  /** Skips unless every selector names a model this session can bill against. */
  requireModels(ctx: { skip: (reason?: string) => never }, selectors: string[]): Promise<void>;
  /** Prompts one `task` spawn and resolves the new child's transcript and model. */
  spawnOnce(ordinal: number): Promise<{ file: string; model: string }>;
  /** Waits out the task-result follow-up turn, then an idle command lane. */
  settleAfterTaskResult(): Promise<void>;
}

/**
 * Boots one real `omp --mode=rpc-ui` with the given overlays and waits for the
 * oauth ready probe; throws OauthUnavailable when none arrives (#86). The
 * caller owns `client.kill()`.
 */
async function bootHarness(base: string, lineage: string, configOverlays: string[]): Promise<Harness> {
  const frames: Frame[] = [];
  const tracker = new LiveExitTracker();
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  const client = new RpcClient({
    cwd: base,
    lineageDir: lineage,
    // Callers skip on a missing binary first, same guard as advisor-stats-live.
    ompPath: ompPath!,
    configOverlays,
    spawnProcess: closeAwareSpawn(),
    onFrame: (frame) => frames.push(frame as Frame),
    onExit: (code) => {
      tracker.recordExit(code);
      markExited();
    },
    onError: (msg) => tracker.recordError(msg),
  });
  /** The response frame for one command id, or undefined while it is in flight. */
  const responseFor = (id: string): Frame | undefined =>
    frames.find((f) => f.type === "response" && f.id === id);

  const command = async (cmd: Record<string, unknown>, timeoutMs = 30_000): Promise<Frame> => {
    const id = `${String(cmd.type)}-${frames.length}-${Math.random().toString(36).slice(2)}`;
    client.send({ ...cmd, id });
    return waitFor(() => responseFor(id), timeoutMs, `${String(cmd.type)} response`);
  };

  /** get_subagents, answered from the raw response frame. */
  const subagents = async (): Promise<NonNullable<Frame["data"]>["subagents"]> =>
    (await command({ type: "get_subagents" })).data?.subagents ?? [];

  // A model session is not a promptable one: on the credential-less CI
  // runners get_state answers and prompts ack success:true, yet every turn
  // dies at the provider (#744 proved availability must gate before any
  // spawn; #1229 extends the same guard to the first proof).
  const requireModels = async (
    ctx: { skip: (reason?: string) => never },
    selectors: string[],
  ): Promise<void> => {
    const models = (await command({ type: "get_available_models" }, 60_000)).data?.models ?? [];
    const available = new Set(models.map((model) => `${model.provider}/${model.id}`));
    const missing = selectors
      .map((selector) => selector.replace(/:[a-z]+$/, ""))
      .filter((model) => !available.has(model));
    if (missing.length > 0) {
      ctx.skip(`${missing.join(" and ")} ${missing.length === 1 ? "is" : "are"} not available to this session`);
    }
  };

  /** Waits for rpc-ui's own state to report a genuinely idle command lane. */
  const waitUntilIdle = async (): Promise<void> => {
    for (;;) {
      const response = await command({ type: "get_state" }, 60_000);
      if (response.data?.isStreaming === false && (response.data.queuedMessageCount ?? 0) === 0) {
        return;
      }
      await sleep(150);
    }
  };

  // oauth readiness: any response frame at all. None in time = unavailable (#86).
  client.send({ type: "get_state", id: "ready-probe" });
  try {
    await waitForOrExit(
      () => (frames.some((f) => f.type === "response") ? true : undefined),
      () => tracker.state(),
      READY_TIMEOUT_MS,
      "oauth ready response",
      100,
    );
  } catch (error) {
    tracker.markTestKilling();
    client.kill();
    throw new OauthUnavailable(`oauth session never became ready: ${String(error)}`);
  }

  const seenAgentIds = new Set<string>();
  const spawnOnce = async (ordinal: number): Promise<{ file: string; model: string }> => {
    const promptId = `prompt-${ordinal}`;
    client.send({ type: "prompt", id: promptId, message: spawnPrompt(ordinal) });
    const promptResponse = await waitFor(
      () => responseFor(promptId),
      SPAWN_TIMEOUT_MS,
      `prompt ${ordinal} response`,
    );
    // The task tool returns immediately after spawn. Capture the child's
    // sessionFile before the parent can consume a settled job receipt.
    const start = Date.now();
    for (;;) {
      const agents = (await subagents()) ?? [];
      const target = agents.find(
        (agent) => agent.agent === "task" && !seenAgentIds.has(agent.id),
      );
      if (target !== undefined && typeof target.sessionFile === "string") {
        seenAgentIds.add(target.id);
        const model = await waitFor(
          () => {
            if (!fs.existsSync(target.sessionFile!)) return undefined;
            try {
              return transcriptModel(target.sessionFile!);
            } catch {
              return undefined;
            }
          },
          SPAWN_TIMEOUT_MS,
          `subagent ${ordinal} model_change`,
        );
        return { file: target.sessionFile, model };
      }
      // No child has EVER spawned on this harness and the parent's turn is
      // dead at the provider: no prompt can ever produce one, so waiting out
      // the spawn budget tells nothing new (#1229). Once a child has spawned
      // the environment can spawn, and any later death is a runtime failure
      // that must fail loudly, not skip.
      if (seenAgentIds.size === 0) {
        const death = parentDeath(lineage);
        if (death !== null) {
          throw new ModelUnavailable(
            `cannot spawn: the parent's own turn ended at the provider (${death}); ` +
              `prompt response: ${JSON.stringify(promptResponse)}`,
          );
        }
      }
      if (Date.now() - start > SPAWN_TIMEOUT_MS) {
        const lifecycle = frames.filter((frame) => frame.type.startsWith("subagent_"));
        const mainFiles = fs.readdirSync(lineage).filter((name) => name.endsWith(".jsonl"));
        const mainTail = mainFiles
          .map((name) => fs.readFileSync(path.join(lineage, name), "utf8").slice(-8_000))
          .join("\n--- main transcript ---\n");
        throw new Error(
          `subagent ${ordinal} never appeared; prompt response: ${JSON.stringify(promptResponse)}; ` +
          `last roster: ${JSON.stringify(agents)}; lifecycle: ${JSON.stringify(lifecycle)}; ` +
          `main transcript tail: ${mainTail}`,
        );
      }
      await sleep(250);
    }
  };

  const settleAfterTaskResult = async (): Promise<void> => {
    // The task result auto-delivery starts a second parent turn after the
    // prompt turn. Wait until the lineage records BOTH the async-result and
    // the assistant message that follows it before sending the next prompt;
    // otherwise rpc-ui can absorb it as a follow-up to the busy turn.
    await waitFor(
      () => {
        const text = fs
          .readdirSync(lineage)
          .filter((name) => name.endsWith(".jsonl"))
          .map((name) => fs.readFileSync(path.join(lineage, name), "utf8"))
          .join("\n");
        const delivered = text.lastIndexOf('"customType":"async-result"');
        return delivered >= 0 && text.lastIndexOf('"role":"assistant"') > delivered
          ? true
          : undefined;
      },
      60_000,
      "parent to settle the task-result follow-up",
    );
    await waitUntilIdle();
  };

  return { client, frames, exited, command, requireModels, spawnOnce, settleAfterTaskResult };
}

describe("subagent model overlay — live reload (ADR-0031)", () => {
  it("a rewritten overlay moves the NEXT spawn to the pinned model, no restart", async (ctx) => {
    if (ompPath === null) ctx.skip("omp binary not found");
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-sublive-"));
    scopes.push(base);
    const lineage = path.join(base, "lin");
    fs.mkdirSync(lineage, { recursive: true });

    // Present but silent on `task`: spawn 1 resolves exactly as without an overlay.
    const overlay = writeSubagentModelOverlay(lineage, { scout: "*" });
    if (overlay === null) throw new Error("subagent overlay was not written");

    let harness: Harness | undefined;
    try {
      harness = await bootHarness(base, lineage, [overlay]);
      // Spawn 1 runs on the parent's own model and the proof needs to REACH
      // the pin, so both must be billable here — the guard test 2 gained in
      // #744, missing here, is why CI hung 240 s instead of skipping (#1229).
      await harness.requireModels(ctx, [PIN_SELECTOR]);
      const first = await harness.spawnOnce(1);
      if (first.model === PIN_MODEL) {
        ctx.skip(`the parent model already is the pin (${PIN_MODEL})`);
      }
      await harness.settleAfterTaskResult();

      // The rewrite under the live process — the claim this test exists for.
      const rewritten = writeSubagentModelOverlay(lineage, { task: PIN_SELECTOR });
      if (rewritten === null) throw new Error("pinned overlay was not written");

      const second = await harness.spawnOnce(2);

      expect(second.model).toBe(PIN_MODEL);
      expect(first.model).not.toBe(PIN_MODEL);
      expect(second.file).not.toBe(first.file);
    } catch (error) {
      skipIfEnvironmentUnavailable(ctx, error);
    } finally {
      if (harness !== undefined) {
        harness.client.kill();
        await Promise.race([harness.exited, sleep(10_000)]);
      }
    }
  }, 420_000);

  it('a set_model alone leaves "*" subagents on the boot model; the rewritten model overlay moves them', async (ctx) => {
    if (ompPath === null) ctx.skip("omp binary not found");
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-sublive-"));
    scopes.push(base);
    const lineage = path.join(base, "lin");
    fs.mkdirSync(lineage, { recursive: true });

    const bootRole = parseModelRole(BOOT_SELECTOR);
    const pinRole = parseModelRole(PIN_SELECTOR);
    if (bootRole === null || pinRole === null) throw new Error("unparseable live model selector");
    const modelOverlay = writeDefaultModelOverlay(lineage, bootRole);
    const subagentOverlay = writeSubagentModelOverlay(lineage, { task: "*" });
    if (subagentOverlay === null) throw new Error("subagent overlay was not written");

    let harness: Harness | undefined;
    try {
      harness = await bootHarness(base, lineage, [modelOverlay, subagentOverlay]);
      // Both models must be reachable, or omp's no-credentials fallback turns
      // a skip into a misleading failure (#744).
      await harness.requireModels(ctx, [BOOT_SELECTOR, PIN_SELECTOR]);

      // The live model becomes the pin; omp never persists it to the role.
      const slash = PIN_MODEL.indexOf("/");
      const switched = await harness.command(
        { type: "set_model", provider: PIN_MODEL.slice(0, slash), modelId: PIN_MODEL.slice(slash + 1) },
        60_000,
      );
      if (switched.success !== true) ctx.skip(`set_model ${PIN_MODEL} failed: ${JSON.stringify(switched)}`);

      // The defect mechanism: "*" follows the default role, not the live model.
      const first = await harness.spawnOnce(1);
      expect(first.model).toBe(BOOT_MODEL);
      await harness.settleAfterTaskResult();

      // Exactly what SessionManager.syncModelOverlay writes on session:setModel.
      writeDefaultModelOverlay(lineage, pinRole);

      const second = await harness.spawnOnce(2);
      expect(second.model).toBe(PIN_MODEL);
      expect(second.file).not.toBe(first.file);
    } catch (error) {
      skipIfEnvironmentUnavailable(ctx, error);
    } finally {
      if (harness !== undefined) {
        harness.client.kill();
        await Promise.race([harness.exited, sleep(10_000)]);
      }
    }
  }, 420_000);
});
