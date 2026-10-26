import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  RpcClient,
  mintLineageDirName,
  writeReviewOverlay,
  type OwnedSessionRecord,
  type Registry,
} from "@omp-ui/core";
import {
  writeReviewRosterForSpawn,
  writeRpcExtensions,
  writeRpcOverlays,
  type SubagentSpawnConfig,
} from "./spawn-config";
import { gateSelector, type SpawnGate } from "./spawn-gate";

/**
 * A pre-booted, deferred-arm `omp --mode=rpc-ui` child parked against its own
 * (empty-of-session-state) lineage dir, together with everything the adopting
 * spawn must agree on: the semantic plan it was booted for and the SHA-256 of
 * the dir tree as the pool left it.
 */
export interface WarmSlot {
  readonly client: RpcClient;
  readonly planKey: string;
  readonly dirName: string;
  /** SHA-256 over the lineage-dir file tree after all pool writes and boot. */
  readonly dirHash: string;
}

/** Everything a build needs, snapshotted so planKey and bytes cannot drift apart mid-build. */
export interface WarmPlan {
  readonly planKey: string;
  readonly ompPath: string;
  /** A sanitized fresh-session record; its `lineageDir` is the dir this build owns. */
  readonly template: OwnedSessionRecord;
}

export interface WarmRpcPoolDeps {
  registry: Registry;
  getSessionsRoot: () => string;
  gate: () => SpawnGate;
  subagentSpawnConfig: () => SubagentSpawnConfig;
  /** Master switch; false parks the pool forever. */
  enabled: () => boolean;
}

/** Two consecutive build failures park the pool for the process — a machine that cannot boot one warm child will not benefit from retries. */
const MAX_BUILD_FAILURES = 2;

/**
 * The semantic identity of a fresh rpc-ui boot. Deliberately NOT byte-argv:
 * a fresh spawn's model pin rides an overlay file, not argv, so the argv that
 * actually differs between plans is `--advisor` and `--thinking auto` only;
 * `ompPath` catches a binary swap under a live slot. The advisor-model pin is
 * in the key even though it too rides an overlay file: the pin lives inside
 * the lineage dir, so a slot built for one pin can NEVER be adopted by a
 * spawn carrying another (the dir-hash re-check would always miss) — planning
 * against it avoids a guaranteed adoption miss on every alternating
 * pinned/unpinned spawn (#892). Every remaining writer input (model,
 * compaction method, roster, settings) is guarded by the dir-hash re-check at
 * adoption — a changed input misses once, cold-boots correctly, and refills
 * against the new state.
 */
export function warmPlanKey(input: {
  ompPath: string;
  projectCwd: string;
  advisor: boolean;
  /** The record's thinking seed: the only `--thinking` boot input a fresh spawn has. */
  thinking: string | null;
  /** The record's advisor-model pin: it rides an overlay file in the dir, so a
   * slot built for one pin is never adoptable by a spawn with another (#892). */
  advisorModel: string | null;
  experimentsEnabled: boolean;
}): string {
  return JSON.stringify([
    input.ompPath,
    input.projectCwd,
    input.advisor,
    input.thinking,
    input.advisorModel,
    input.experimentsEnabled,
  ]);
}

/**
 * Deterministic digest of the plan-defining dir tree: sorted relative paths +
 * raw bytes — except the generated `-e` bridge `.ts` files, digested by name
 * only. Several embed a per-write random `processKey`, so byte equality
 * across two writes is impossible; within one app process their template
 * code is a module constant and the file set is the real identity.
 */
export function hashLineageTree(root: string): string {
  const h = createHash("sha256");
  const walk = (rel: string): void => {
    const entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const child = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) {
        h.update(`d\0${child}\0`);
        walk(child);
      } else if (e.isFile()) {
        h.update(`f\0${child}\0`);
        if (!child.endsWith(".ts")) h.update(fs.readFileSync(path.join(root, child)));
      }
    }
  };
  walk("");
  return h.digest("hex");
}

/** SIGKILL ceiling for a pool-owned child: SIGTERM-ignoring children must not
 * park forever holding stdio fds (#892 — the 5-hour orphan). */
const KILL_ESCALATION_MS = 5_000;

/** Kill, and SIGKILL five seconds later unless the exit edge lands first.
 * `RpcClient.kill` is SIGTERM-only with no escalation, and `onDeath` fires on
 * the real exit edge regardless of arm state; a second `kill(sig)` still
 * reaches the proc even after `#dead`. */
export function killWarmClient(client: RpcClient): void {
  let reaped = false;
  client.onDeath(() => {
    reaped = true;
  });
  client.kill();
  const timer = setTimeout(() => {
    if (!reaped) client.kill("SIGKILL");
  }, KILL_ESCALATION_MS);
  timer.unref();
}

/**
 * The pool's sanitized record: every volatile identity field reset (the warm
 * tab is a template, never a registry row), plus a freshly minted lineage dir
 * the build owns outright. Writers only read projectCwd/worktree/model/
 * thinkingLevel/advisor/advisorModel/compactionMethod/subagentModels from it.
 */
export function sanitizeWarmTemplate(record: OwnedSessionRecord): OwnedSessionRecord {
  return {
    ...record,
    tabId: `warm-${record.tabId}`,
    sessionId: null,
    lineageDir: mintLineageDirName(record.projectCwd),
    worktree: null,
    planImplementationSource: null,
    askSource: null,
    fleet: null,
    launchedAt: new Date().toISOString(),
    agentMode: "build",
    approvalMode: null,
    serviceTier: null,
    subagentModels: null,
    proposedPlans: [],
    autoTitled: false,
    snoozed: false,
    private: false,
    cachedTitle: null,
    cachedModified: null,
  };
}

/**
 * One parked warm rpc-ui child (issue #908 perf). The pool pre-boots the exact
 * argv/overlay set a fresh eligible spawn would use; adoption skips the ~170 ms
 * boot entirely. Protocol:
 *
 * - `reserve(planKey)` pops the slot iff its plan matches — call it BEFORE the
 *   record is minted so the session adopts the slot's dir as its own (omp
 *   stages session files against --session-dir at boot; renaming afterwards
 *   would strand them).
 * - The spawning side rewrites the whole dir exactly as `build` did, then
 *   re-hashes it: equal ⇒ adopt (`arm()` delivers buffered boot frames and the
 *   real initialCommands rail); unequal ⇒ kill the slot and cold-boot in the
 *   same dir. The hash is the authority; planKey is only the cheap pre-filter.
 * - A reserved-but-unused slot comes back through `release` (its files are
 *   untouched by a failed spawn); a consumed miss dies in the spawning side's
 *   own kill and never returns.
 */
export class WarmRpcPool {
  #slot: WarmSlot | null = null;
  #buildingClient: RpcClient | null = null;
  #failures = 0;
  #disposed = false;

  constructor(private readonly deps: WarmRpcPoolDeps) {}

  /** True while a reserve could ever succeed (ungated, switched on, not failed out). */
  available(): boolean {
    if (!this.deps.enabled()) return false;
    const gate = this.deps.gate();
    return (
      !this.#disposed &&
      this.#failures < MAX_BUILD_FAILURES &&
      gateSelector(gate) === null &&
      gate.advisorModel === null
    );
  }

  /** Take the slot for a matching plan; ownership moves to the caller. */
  reserve(planKey: string): WarmSlot | null {
    const slot = this.#slot;
    if (slot === null || slot.planKey !== planKey) return null;
    this.#slot = null;
    return slot;
  }

  /**
   * Hand an unused reservation back. Only a never-armed, still-alive client is
   * re-parked — anything else was consumed by adoption or died, and the
   * spawning side has already killed what it adopted.
   */
  release(slot: WarmSlot): void {
    if (
      this.#slot === null &&
      !this.#disposed &&
      this.deps.enabled() &&
      slot.client.armed === false &&
      slot.client.dead === false
    ) {
      this.#slot = slot;
    } else {
      killWarmClient(slot.client);
    }
  }

  /**
   * Park a fresh warm child for `plan`. Single-flight: a refill while one is
   * building or a slot already stands parked is dropped — the next eligible
   * spawn reschedules, and a stale-but-matching slot beats no slot.
   */
  scheduleRefill(plan: WarmPlan): void {
    if (
      !this.available() ||
      this.#slot !== null ||
      this.#buildingClient !== null ||
      !fs.existsSync(plan.template.projectCwd)
    ) {
      return;
    }
    void this.#build(plan);
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#slot !== null) killWarmClient(this.#slot.client);
    this.#slot = null;
    if (this.#buildingClient !== null) killWarmClient(this.#buildingClient);
    this.#buildingClient = null;
  }

  /** Mirrors `spawnRpc`'s writes exactly, then boots deferred and hashes the settled dir. */
  async #build(plan: WarmPlan): Promise<void> {
    const dir = path.join(this.deps.getSessionsRoot(), plan.template.lineageDir);
    let client: RpcClient | null = null;
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.mkdirSync(dir, { recursive: true });
      const experimentsEnabled = this.deps.registry.getSetting("experimentsEnabled");
      const { paths: extensions, loaded } = writeRpcExtensions(dir, experimentsEnabled);
      const configOverlays = await writeRpcOverlays(
        plan.template,
        dir,
        plan.ompPath,
        this.deps.gate(),
        this.deps.subagentSpawnConfig(),
      );
      if (loaded.review) {
        configOverlays.push(writeReviewOverlay(dir));
        const projectRecord = this.deps.registry.projects.find(
          (project) => project.path === plan.template.projectCwd,
        );
        await writeReviewRosterForSpawn(
          dir,
          this.deps.registry.getSetting("reviewRoster"),
          projectRecord?.reviewRoster ?? null,
        );
      }
      let resolveReady: () => void = () => {};
      const ready = new Promise<void>((resolve) => {
        resolveReady = resolve;
      });
      client = new RpcClient({
        cwd: plan.template.projectCwd,
        lineageDir: dir,
        ompPath: plan.ompPath,
        deferArm: true,
        advisor: plan.template.advisor,
        // A fresh spawn's model pin is an overlay file, never argv (#843):
        // the only boot argv a fresh record adds beyond cwd/session-dir is
        // the auto-thinking flag — mirror it or frames lack configured:"auto".
        ...(plan.template.thinkingLevel === "auto" ? { thinking: "auto" } : {}),
        configOverlays,
        extensions,
        onBootReady: resolveReady,
        // The deferArm ctor installs inert sinks; these three opts only exist
        // to satisfy the required-opts shape — nothing reaches them.
        onFrame: () => {},
        onExit: () => {},
        onError: () => {},
      });
      const booted = client;
      this.#buildingClient = booted;
      await new Promise<void>((resolve, reject) => {
        booted.onDeath(() => reject(new Error("warm rpc-ui child died before adoption")));
        void ready.then(resolve);
      });
      if (this.#disposed) {
        killWarmClient(booted);
        return;
      }
      this.#slot = {
        client: booted,
        planKey: plan.planKey,
        dirName: plan.template.lineageDir,
        dirHash: hashLineageTree(dir),
      };
      this.#failures = 0;
      const slot = this.#slot;
      booted.onDeath(() => {
        if (this.#slot === slot) this.#slot = null;
      });
    } catch (err) {
      this.#failures += 1;
      if (client !== null) killWarmClient(client);
      console.warn(`[warm-pool] build failed (${this.#failures}):`, err);
    } finally {
      this.#buildingClient = null;
    }
  }
}
