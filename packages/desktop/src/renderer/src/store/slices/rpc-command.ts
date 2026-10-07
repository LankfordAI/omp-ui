import { sessionCommandIsOffChain, type SessionCommand } from "@omp-ui/core/session-command";
// RPC command domain (decomposed for #295): boot, command correlation and
// timeout, history backfill, and the auto-titling latch that delegates to
// omp's own `/rename`.
import type { BackendState } from "@omp-ui/core/types";
import type { VibeSnapshot } from "@omp-ui/core/vibe";
import type { AutoresearchSnapshot } from "@omp-ui/core/autoresearch";
import type {
  CapabilitySnapshot,
  SessionCapabilitiesResult,
  SetSessionToolEnabledResult,
} from "@omp-ui/core/capabilities";
import { backend } from "../../backend";
import { formatDuration } from "../../lib/duration";
import { projectKey } from "../../lib/project-key";
import { arrField } from "../../lib/fields";
import { randomId } from "../../lib/random-id";
import {
  emptySessionRuntime,
  parseCommandList,
  parseModelList,
  parseSessionStats,
} from "../../lib/rpc-types";
import { isLowSignalTitleInput, isUntitled } from "../../lib/session-title";
import { historyToItems, noticeItem } from "../../lib/transcript";
import {
  RPC_COMMAND_TIMEOUT_MS,
  RpcCommandAbandonedError,
  RpcCommandTimeoutError,
  dropPlanHandoff,
  isLateAckCommand,
  respData,
  clearRewindPrefill,
  type GetState,
  type SetState,
  type StoreMachinery,
  type Watchers,
} from "./shared";
import { freshBrowserPaneView } from "./browser-pane";
import { findRecord } from "./view";
import { isNewerSnapshot } from "../snapshot-acceptance";
import type {
  CapabilitiesToolPending,
  RpcTabState,
  UiStore,
} from "../types";

export type RpcCommandSlice = Pick<
  UiStore,
  | "bootRpcTab"
  | "refreshAvailableModels"
  | "refreshCapabilities"
  | "rpcCommand"
  | "setInitialPrompt"
  | "renameSession"
  | "setSessionToolEnabled"
  | "reloadHistory"
>;

/**
 * Capability generations are global and monotonic, mirroring
 * `nextCompactionUsageGeneration`: a value, once handed out, is never the
 * value a replacement runtime or a later push will carry. That is what makes
 * an in-flight `getSessionCapabilities` answer decidable — a discarded
 * runtime restarts at 0, so a captured generation above 0 can never silently
 * match a tab that has since been rebuilt (issue #374).
 */
let nextCapabilitiesGeneration = 0;
/** Retires the tab's current capability observation and returns its successor. */
export function bumpCapabilitiesGeneration(
  m: StoreMachinery,
  tabId: string,
): number {
  const generation = ++nextCapabilitiesGeneration;
  // `patchRuntime` refuses to invent an owner, so take the slot first: a tab
  // whose runtime has already been discarded then reads back 0, which is
  // exactly the mismatch that invalidates its stale reads.
  m.runtime(tabId);
  m.patchRuntime(tabId, { capabilitiesGeneration: generation });
  return generation;
}

/**
 * omp put a different session behind this tab (`/new`, `switch_session`,
 * `branch`): a roster sampled for the predecessor must never be labelled as
 * the successor's inventory. Clear it and re-observe the live session.
 */
export function noteCapabilitiesSessionChange(
  tabId: string,
  observedSessionId: string | null,
  get: GetState,
  m: StoreMachinery,
): void {
  const retained = get().rpc[tabId]?.capabilities ?? null;
  if (retained === null || observedSessionId === null) return;
  if (retained.sessionId === null || retained.sessionId === observedSessionId)
    return;
  // The pending mutation and its report describe the predecessor session, so
  // they retire with its roster (#379).
  m.patchRpc(tabId, {
    capabilities: null,
    capabilitiesToolPending: null,
    capabilitiesToolFeedback: null,
  });
  void get().refreshCapabilities(tabId);
}

/** The roster identity a mutation request is bound to. */
interface RosterIdentity {
  processKey: string;
  sessionId: string | null;
}

/**
 * True when both sides describe one observed session. An unobserved root id
 * (`null`) is unknown rather than different — the bridge is allowed to learn
 * it later, and main re-validates the identity it was handed before it touches
 * the registry, so the renderer never invents a mismatch out of a gap.
 */
function sameRosterIdentity(a: RosterIdentity, b: RosterIdentity): boolean {
  return (
    a.processKey === b.processKey &&
    (a.sessionId === null || b.sessionId === null || a.sessionId === b.sessionId)
  );
}

/** True when the published Tools section itself reports the membership. */
function reportsMembership(
  roster: CapabilitySnapshot | null,
  name: string,
  enabled: boolean,
): boolean {
  if (roster === null || roster.tools.status !== "available") return false;
  return roster.tools.items.some(
    (tool) => tool.name === name && tool.enabled === enabled,
  );
}

/**
 * The one acceptance rule for a complete capability snapshot (#379), shared by
 * the `setStatus` push path and by an `applied` mutation result so the two can
 * never disagree about which roster a tab shows: a same-process snapshot
 * replaces the roster only when its revision is strictly newer, a new process
 * always wins, and the roster is replaced wholesale — skills and tools come
 * and go between publishes, so a merge would resurrect what omp dropped, and a
 * single patched row would claim a change OMP never confirmed. It is data,
 * never a transcript row, chip, or dialog entry.
 *
 * A different process or a different root session is a different runtime: this
 * tab's tool-mutation state retires with it, because whatever was pending or
 * refused describes a session that no longer exists. Returns false when the
 * snapshot is older than what the tab already retains, which is how an
 * out-of-order `applied` result is kept from retargeting the tab.
 */
export function acceptCapabilitySnapshot(
  tabId: string,
  snapshot: CapabilitySnapshot,
  get: GetState,
  m: StoreMachinery,
): boolean {
  const retained = get().rpc[tabId]?.capabilities ?? null;
  if (!isNewerSnapshot(retained, snapshot)) return false;
  const replacement =
    retained !== null && !sameRosterIdentity(retained, snapshot);
  m.patchRpc(
    tabId,
    replacement
      ? {
          capabilities: snapshot,
          capabilitiesLoad: "available",
          capabilitiesToolPending: null,
          capabilitiesToolFeedback: null,
        }
      : { capabilities: snapshot, capabilitiesLoad: "available" },
  );
  // The roster owns the tab now; an in-flight getSessionCapabilities read must
  // not overwrite it (#374).
  bumpCapabilitiesGeneration(m, tabId);
  return true;
}

/**
 * The one acceptance rule for a vibe snapshot (issue #683), shared by the
 * `setStatus` push path and by the boot-time summary under `isNewerSnapshot`:
 * same-process snapshots must carry a strictly newer revision, a different
 * processKey always replaces what an older generation left behind, and a
 * malformed publish never reaches here — the parser refused it.
 *
 * Accepting the snapshot settles this tab's pending vibe command row whose
 * requestId the result carries; a result addressed to another client or an
 * older generation matches no entry in this tab's map.
 */
export function acceptVibeSnapshot(
  tabId: string,
  snapshot: VibeSnapshot,
  get: GetState,
  m: StoreMachinery,
): boolean {
  const retained = get().rpc[tabId]?.vibe ?? null;
  if (!isNewerSnapshot(retained, snapshot)) return false;
  m.patchRpc(tabId, { vibe: snapshot });
  const result = snapshot.result;
  if (result === null) return true;
  const requests = m.runtime(tabId).vibeRequests;
  const itemId = requests.get(result.requestId);
  if (itemId === undefined) return true;
  requests.delete(result.requestId);
  m.patchItems(tabId, (item) =>
    item.kind === "command" && item.id === itemId && item.status === "running"
      ? {
          ...item,
          status: result.ok ? "done" : "failed",
          output: result.text,
          ...(result.ok ? {} : { error: result.text }),
        }
      : item,
  );
  return true;
}

/**
 * The one acceptance rule for an autoresearch snapshot (ADR-0030), shared by
 * the `setStatus` push path and the boot-time summary hydration, under the
 * same `isNewerSnapshot` revision/processKey rule as vibe snapshots. It has no
 * command row to settle: `/autoresearch` is omp's own command and its row
 * settles through the ordinary prompt path.
 *
 * It is also the Lab's one live-reload trigger. Run history lives in omp's
 * SQLite DB, which no frame announces; a mode flip or a finished autoresearch
 * tool is the moment that DB may have changed, so a project whose experiments
 * the Lab (or a HUD chip) already read is re-read here — from both paths, so a
 * late joiner hydrating from the summary refreshes exactly like a live frame.
 */
export function acceptAutoresearchSnapshot(
  tabId: string,
  snapshot: AutoresearchSnapshot,
  get: GetState,
  m: StoreMachinery,
): boolean {
  const retained = get().rpc[tabId]?.autoresearch ?? null;
  if (!isNewerSnapshot(retained, snapshot)) return false;
  m.patchRpc(tabId, { autoresearch: snapshot });
  if (
    retained !== null &&
    retained.mode === snapshot.mode &&
    retained.lastTool?.at === snapshot.lastTool?.at
  )
    return true;
  const tab = get().tabs.find((t) => t.tabId === tabId);
  if (tab === undefined) return true;
  const load = get().experiments[projectKey(tab.instanceId, tab.projectCwd)]?.load;
  if (load !== undefined && load !== "idle")
    void get().loadExperiments(tab.projectCwd, tab.instanceId);
  return true;
}

export interface RpcCommandDeps extends Watchers {
  reconcilePlanGates(state: BackendState): void;
  /** Aligns dialog queues with main's list after boot (#555). */
  reconcilePendingDialogs(state: BackendState): void;
}

interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: number;
  /** Background sync — must never drive the busy sweep. */
  quiet: boolean;
  /** Budget measures omp's silence, not the command's duration (issue #335). */
  lateAck: boolean;
  /** Command name only — never retain the command payload in diagnostics. */
  command: string;
  startedAt: number;
  timeoutMs: number;
}

const pendingCommands = new Map<string, Map<string, PendingCommand>>();

function commandAttribution(
  tabId: string,
  startedAt: number,
  m: StoreMachinery,
): string | null {
  const holder = m
    .runtime(tabId)
    .timedOutCommands.find((entry) => entry.startedAt < startedAt);
  if (holder)
    return `queued behind ${holder.command} (timed out ${formatDuration(
      Date.now() - holder.timedOutAt,
    )} ago, response not yet observed)`;
  const inFlight = [...(pendingCommands.get(tabId)?.values() ?? [])].map((p) =>
    p.quiet
      ? `${p.command} (bg, ${formatDuration(Date.now() - p.startedAt)})`
      : `${p.command} (${formatDuration(Date.now() - p.startedAt)})`,
  );
  return inFlight.length > 0
    ? `other commands still in flight: ${inFlight.join(", ")}`
    : null;
}

/** The command bus owns its correlation map; consumers see operations only. */
export const rpcCommandMachinery = {
  begin(
    tabId: string,
    cmd: Record<string, unknown>,
    opts: { quiet?: boolean; captureId?: (id: string) => void } | undefined,
    get: GetState,
    m: StoreMachinery,
  ): Promise<unknown> {
    const id = randomId();
    const command = typeof cmd.type === "string" ? cmd.type : "unknown";
    const startedAt = Date.now();
    const timeoutMs = RPC_COMMAND_TIMEOUT_MS;
    const lateAck = isLateAckCommand(cmd);
    // Quiet commands are background sync (usage ticks, subagent roster
    // heartbeats). They never touch `busy`: each round-trip would otherwise
    // strobe the progress sweeps for a few ms, jittering the transcript.
    const quiet = opts?.quiet ?? false;
    const tabPending = pendingCommands.get(tabId) ?? new Map<string, PendingCommand>();
    pendingCommands.set(tabId, tabPending);
    // Executor form required: the pending entry must exist before send.
    const promise = new Promise<unknown>((resolve, reject) => {
      const expire = (): void => {
        const entry = tabPending.get(id);
        if (!entry) return;
        // An off-chain command (`bash`, `predict_word`) emits no frames while
        // it runs, so silence proves nothing: never fail it on the window
        // (issues #678, #715). Process death still settles it through
        // abandon, and omp bounds both server-side (bash timeout; predict
        // client 30 s request budgets).
        if (sessionCommandIsOffChain(entry.command)) {
          entry.timer = window.setTimeout(expire, timeoutMs);
          return;
        }
        // A late-ack command's window measures omp's silence: while frames
        // keep arriving the process is alive and merely slow, so re-arm for
        // the remainder of the quiet window instead of failing a healthy
        // session (issue #335).
        const quietFor = Date.now() - (m.runtime(tabId).lastFrameAt ?? startedAt);
        if (lateAck && quietFor < timeoutMs) {
          entry.timer = window.setTimeout(expire, timeoutMs - quietFor);
          return;
        }
        // Remove before settling so the map remains the authoritative ref
        // count when `finally` recomputes busy.
        tabPending.delete(id);
        if (tabPending.size === 0) pendingCommands.delete(tabId);
        // Attribution memory: the entry outlives the budget until a
        // completion response is observed, so a later quiet timeout can
        // name the command holding the chain (issue #302).
        const timedOutCommands = [
          ...m.runtime(tabId).timedOutCommands,
          { id, command, startedAt, timedOutAt: Date.now() },
        ];
        m.patchRuntime(tabId, { timedOutCommands });
        const runtime = get().rpc[tabId];
        const liveState = findRecord(get().state, tabId)?.live;
        const details = {
          tabId,
          commandId: id,
          command,
          timeoutMs,
          elapsedMs: Date.now() - startedAt,
          lateAck,
          quietForMs: quietFor,
          pendingCommandCount: tabPending.size,
          pending: [...tabPending.values()].map((p) => ({
            command: p.command,
            quiet: p.quiet,
            elapsedMs: Date.now() - p.startedAt,
          })),
          sessionStatus: runtime?.status ?? null,
          isStreaming: runtime?.session.isStreaming ?? null,
          liveState: liveState ?? null,
        };
        console.warn("[rpc] command timeout", details);
        reject(
          new RpcCommandTimeoutError(
            command,
            timeoutMs,
            startedAt,
            lateAck ? "silence" : "response",
            commandAttribution(tabId, startedAt, m),
          ),
        );
      };
      tabPending.set(id, {
        resolve,
        reject,
        timer: window.setTimeout(expire, timeoutMs),
        quiet,
        lateAck,
        command,
        startedAt,
        timeoutMs,
      });
    });
    if (!quiet) m.patchRpc(tabId, { busy: true });
    // Callers correlating async frames (prompt_result) with this command
    // learn the wire id before the first byte leaves.
    opts?.captureId?.(id);
    backend.rpcSend(tabId, { ...cmd, id });
    // The map is the ref count: both settle paths remove their entry before
    // settling, so concurrent commands can't clear `busy` for each other.
    // Only loud entries count — a lingering quiet heartbeat must not pin
    // `busy`, and a settling quiet one must not clear it early either way.
    return promise.finally(() => {
      let loud = 0;
      for (const p of pendingCommands.get(tabId)?.values() ?? [])
        if (!p.quiet) loud++;
      if (loud === 0 && get().rpc[tabId]?.busy) {
        m.patchRpc(tabId, { busy: false });
      }
    });
  },

  /**
   * Resolves or drops the pending wait for `id`. Returns the command name
   * when the response is the late completion of a timed-out command — the
   * observation the #302 attribution waits for, and for `compact` the only
   * proof the work landed (issue #625) — and null otherwise.
   */
  settle(
    tabId: string,
    id: string,
    response: { success: boolean; frame: unknown; error?: unknown },
    m: StoreMachinery,
  ): string | null {
    const tabPending = pendingCommands.get(tabId);
    const pending = tabPending?.get(id);
    if (!pending) {
      // The budget expired first: this late response is the completion
      // observation the timeout attribution waits for (issue #302), and it is
      // also the only proof some commands — `compact` — have of finishing.
      const late =
        m
          .runtime(tabId)
          .timedOutCommands.find((entry) => entry.id === id)?.command ?? null;
      m.patchRuntime(tabId, {
        timedOutCommands: m
          .runtime(tabId)
          .timedOutCommands.filter((entry) => entry.id !== id),
      });
      return late;
    }
    clearTimeout(pending.timer);
    tabPending!.delete(id);
    if (tabPending!.size === 0) pendingCommands.delete(tabId);
    // The chain is FIFO: this completion proves every earlier-started
    // command completed. An off-chain command bypasses the chain, so it
    // proves nothing (issues #302, #715).
    if (!sessionCommandIsOffChain(pending.command)) {
      const timedOutCommands = m
        .runtime(tabId)
        .timedOutCommands.filter((entry) => entry.startedAt >= pending.startedAt);
      m.patchRuntime(tabId, { timedOutCommands });
    }
    if (!response.success) {
      const message =
        typeof response.error === "string" ? response.error : "command failed";
      pending.reject(new Error(message));
    } else {
      pending.resolve(response.frame);
    }
    return null;
  },

  abandon(tabId: string, reason: string, m: StoreMachinery): void {
    m.patchRuntime(tabId, { timedOutCommands: [], lastFrameAt: undefined });
    // The process left, so no completion frame will ever land: close an open
    // manual compaction as failed even when its own promise already returned
    // past the budget (issue #625). A no-op when no record is open.
    m.finishCompaction(tabId, "failed");
    const tabPending = pendingCommands.get(tabId);
    if (tabPending === undefined || tabPending.size === 0) return;
    pendingCommands.delete(tabId);
    for (const pending of tabPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new RpcCommandAbandonedError(pending.command, reason));
    }
  },

  snapshotPending(
    tabId: string,
    opts?: { includeQuiet?: boolean },
  ): ReadonlySet<string> {
    const includeQuiet = opts?.includeQuiet ?? true;
    return new Set(
      [...(pendingCommands.get(tabId)?.entries() ?? [])]
        .filter(([, pending]) => includeQuiet || !pending.quiet)
        .map(([id]) => id),
    );
  },

  hasPending(tabId: string, id: string): boolean {
    return pendingCommands.get(tabId)?.has(id) === true;
  },

  /** Test seam: store tests replace state wholesale, so clear the private bus too. */
  resetForTests(): void {
    for (const commands of pendingCommands.values()) {
      for (const pending of commands.values()) clearTimeout(pending.timer);
    }
    pendingCommands.clear();
  },
};

/** Cancels every process-local dependency before removing its runtime. */
export function disposeTabRuntime(
  tabId: string,
  reason: string,
  deps: Watchers,
  m: StoreMachinery,
): void {
  // A relaunch must never prefill a prompt staged for the old lifetime
  // (issue #680).
  clearRewindPrefill(tabId);
  deps.concern.cancel(tabId);
  deps.advisorReply.cancel(tabId);
  // The roster belongs to the dying process, not to whatever session reuses
  // this tab id: retire it, and retire its observation token so a read that
  // is still in flight can never publish it into the next lifetime (#374).
  // So does any tool mutation: its answer belongs to the dead runtime (#379).
  m.patchRpc(tabId, {
    capabilities: null,
    capabilitiesLoad: "idle",
    capabilitiesToolPending: null,
    capabilitiesToolFeedback: null,
    // The goal belongs to the dying process too; the successor's get_state
    // reports its own.
    goal: null,
    // The vibe roster is the dying process's director state: omp's worker
    // scopes died with it, and the successor republishes its own (#683).
    vibe: null,
    // Likewise the side-question topics: the next process republishes its own.
    sideQuestions: null,
    // The live session died with the process; the successor owns its own
    // realtime state (issue #778).
    live: null,
    subagentControlBusy: {},
    subagentControlError: null,
    autoresearch: null,
  });
  rpcCommandMachinery.abandon(tabId, reason, m);
  m.discardTabRuntime(tabId);
}

/**
 * `thinkingConfigured` seeds the automatic-thinking selector from the session
 * record (`"auto"` when the record stores it): get_state has no configured
 * field, so without the seed an auto session's pill would show the boot-time
 * resolved level until the first per-turn frame.
 */
function freshRpcTabState(
  advisorReply: boolean,
  thinkingConfigured: string | null,
): RpcTabState {
  return {
    status: "starting",
    activeTurnKeywords: [],
    items: [],
    transcriptRevision: 0,
    todos: [],
    model: null,
    availableModels: [],
    commands: [],
    session: { ...emptySessionRuntime(), thinkingConfigured },
    stats: null,
    subagents: [],
    subagentItems: {},
    selectedSubagent: null,
    browserPane: freshBrowserPaneView(),
    composerQueue: undefined,
    subagentMarkers: new Map(),
    subagentAckLevel: undefined,
    extensionStatus: {},
    streamCheckpoint: undefined,
    streamStallMs: undefined,
    stallAbortPending: undefined,
    stallCount: 0,
    extensionQueue: [],
    busy: false,
    failure: undefined,
    initialPrompt: null,
    hasRenamed: false,
    plan: null,
    planReview: null,
    planText: null,
    planHtml: null,
    planDeferred: false,
    planReadiness: null,
    experimentProposal: null,
    approvalPrompt: null,
    advisorStats: null,
    mcpStatus: null,
    goal: null,
    vibe: null,
    sideQuestions: null,
    live: null,
    autoresearch: null,
    limits: null,
    capabilities: null,
    capabilitiesLoad: "idle",
    subagentControlBusy: {},
    subagentControlError: null,
    advisorReply,
  };
}

/** A new rpc process emits exactly one ready frame — that's the boot signal. */
const rpcBooting = new Set<string>();

/** The failure surface's model-recovery marker (issue #774): an
 *  `omp_ui_error` frame may stamp it on the tab's failure while a boot
 *  command is in flight, and the boot's own failure patch must not drop it —
 *  without the marker the model picker never appears. */
function carriedFailedModel(
  state: UiStore,
  tabId: string,
): { failedModel?: string } {
  const failed = state.rpc[tabId]?.failure?.failedModel;
  return failed === undefined ? {} : { failedModel: failed };
}

export function createRpcCommandSlice(
  set: SetState,
  get: GetState,
  m: StoreMachinery,
  deps: RpcCommandDeps,
): RpcCommandSlice & {
  /**
   * Hydration of the goal each live process reports. Plumbing, not a UI action:
   * store.ts runs it beside `reconcilePlanGates` on every state read (issue #381).
   */
  reconcileGoals(state: BackendState): void;
  /** The autoresearch twin of `reconcileGoals`, run beside it (ADR-0030). */
  reconcileAutoresearch(state: BackendState): void;
  /** The vibe twin of `reconcileGoals`, run beside it (issue #683). */
  reconcileVibe(state: BackendState): void;
} {
  // The bodies moved from the root closure keep their original names.
  const {
    advisorReply: advisorReplyWatcher,
    stall: stallContinueWatcher,
  } = deps;

  const loadHistory = async (tabId: string): Promise<void> => {
    const resp = await get().rpcCommand(tabId, { type: "get_messages" });
    // History replaces the transcript wholesale — a batch reduced from the
    // pre-history items would clobber it on the next flush. Per-agent marker
    // memory must not outlive the render items it was deduping against.
    m.cancelTranscriptBatch(tabId);
    m.patchRpc(tabId, {
      items: historyToItems(arrField(respData(resp), "messages")),
      subagentMarkers: new Map(),
    });
    // A resumed transcript's advisories are history, not a live review: the
    // baseline moves past them so nothing here is ever answered.
    advisorReplyWatcher.reset(tabId);
    stallContinueWatcher.reset(tabId);
  };

  const bootRpcTab = async (tabId: string): Promise<void> => {
    set((state) => ({ handedOffFor: dropPlanHandoff(state.handedOffFor, tabId) }));
    if (rpcBooting.has(tabId)) return;
    rpcBooting.add(tabId);
    try {
      // A re-boot must not slam the Agents pane's drill-down shut: the open
      // detail view and the retained buffers behind it survive the process
      // restart, and the subscription re-escalates after boot (issue #63).
      const prior = get().rpc[tabId];
      const pendingNotices = m.runtime(tabId).pendingNotices;
      disposeTabRuntime(tabId, "the session was relaunched", deps, m);
      // Ready can beat the spawn IPC response. The renderer-only owner must
      // exist synchronously before any command can produce another frame.
      m.createTabRuntime(tabId);
      m.patchRuntime(tabId, { pendingNotices });
      const seedConfigured =
        findRecord(get().state, tabId)?.thinkingLevel === "auto" ? "auto" : null;
      m.patchRpc(tabId, {
        ...freshRpcTabState(get().state?.advisorAutoReply ?? true, seedConfigured),
        selectedSubagent: prior?.selectedSubagent ?? null,
        subagentItems: prior?.subagentItems ?? {},
        // The pane's open/fullscreen posture survives the reboot (#528); the
        // ensure answer belongs to the dead process, so the component re-asks.
        browserPane: prior
          ? { ...prior.browserPane, ensure: "idle", state: null }
          : freshBrowserPaneView(),
      });
      // The tab may not exist in state yet — ensure the slot exists.
      if (!get().rpc[tabId]) {
        set((s) => ({
          rpc: {
            ...s.rpc,
            [tabId]: freshRpcTabState(
              get().state?.advisorAutoReply ?? true,
              seedConfigured,
            ),
          },
        }));
      }
      // Subscribe first, but do not serialize boot behind this optional bus.
      // The ack field records only what this process has actually accepted.
      const subagentSubscription = get()
        .rpcCommand(tabId, {
          type: "set_subagent_subscription",
          level: "progress",
        })
        .then(
          () => m.patchRpc(tabId, { subagentAckLevel: "progress" }),
          () => {},
        );
      // Boot can outrun init()'s first getState — the record decides whether
      // history (get_messages) is fetched, so don't read it from thin air.
      if (!get().state) set({ state: await backend.getState() });
      const rec = findRecord(get().state, tabId);
      // Boot can outrun the state read above, so the seed may have read thin
      // air; re-assert it from the record before get_state merges over it.
      if (rec?.thinkingLevel === "auto")
        m.patchSession(tabId, { thinkingConfigured: "auto" });
      // get_state is the canary: if it fails, the tab is dead, not "ready".
      const stateFailure = await get()
        .rpcCommand(tabId, { type: "get_state" })
        .then(
          (resp) => {
            m.applyRpcState(tabId, resp);
            // The snapshot is the only evidence a mid-turn attach ever gets:
            // its agent_start went by before this tab existed. Later frames are
            // ordered after this reply, so an agent_end still settles it.
            if (get().rpc[tabId]?.session.isStreaming === true) {
              m.patchRpc(tabId, { status: "running" });
            }
            return null;
          },
          (err: unknown) =>
            err instanceof Error ? err : new Error(String(err)),
        );
      // allSettled, not all: a missing subagent bus or a slow stats read must
      // never leave the tab stuck in "starting".
      const boots: Promise<unknown>[] = [
        subagentSubscription,
        get()
          .rpcCommand(tabId, { type: "get_available_models" })
          .then((resp) => {
            m.patchRpc(tabId, {
              availableModels: parseModelList(respData(resp)),
            });
          }),
        get()
          .rpcCommand(tabId, { type: "get_available_commands" })
          .then((resp) => {
            m.patchRpc(tabId, { commands: parseCommandList(respData(resp)) });
          }),
        get()
          .rpcCommand(tabId, { type: "get_session_stats" })
          .then((resp) => {
            m.patchRpc(tabId, { stats: parseSessionStats(respData(resp)) });
          }),
      ];
      if (rec?.sessionId) boots.push(loadHistory(tabId));
      await Promise.allSettled(boots);
      // Re-escalate only when a detail view survived the process restart.
      if (get().rpc[tabId]?.selectedSubagent)
        m.syncSubagentSubscription(tabId);
      // Arm the advisor-stats extension (its first slash run sets its `ui`
      // channel, after which it auto-publishes at each turn end). Armed for
      // every session, not just advisor-on ones: the extension is always loaded,
      // this one shot is cheap and idempotent, and it publishes `available:false`
      // for an advisor-off session that the HUD simply hides. Gating on the
      // record flag would let a stale `advisor` (race with the broadcast after the
      // advisor-toggle relaunch) skip the arm and starve the readout forever.
      void get().refreshAdvisorStats(tabId);
      // Arm the limits bridge for the same reason (issue #673): one cheap,
      // idempotent shot at ready; the bridge then auto-refreshes at turn ends
      // past omp's five-minute usage-probe cooldown.
      void get().refreshLimits(tabId);
      // The roster is a backend read, not a command: boot takes one whether
      // or not the session ever publishes, so an open viewer is never stuck
      // on "idle" for want of a turn (issue #374).
      void get().refreshCapabilities(tabId);
      if (stateFailure) {
        m.patchRpc(tabId, {
          status: "error",
          failure: {
            message: `RPC boot failed while running "get_state": ${stateFailure.message}`,
            kind: "boot",
            fatal: true,
            command: "get_state",
            ...(stateFailure instanceof RpcCommandTimeoutError
              ? { timeoutMs: stateFailure.timeoutMs }
              : {}),
            sessionStatus: "error",
            ...(rec?.live !== undefined ? { liveState: rec.live } : {}),
            // A model-restore death stamps its marker via the omp_ui_error
            // frame, which dropped this boot command — the marker must
            // survive the rephrasing or the picker never appears (issue #774).
            ...carriedFailedModel(get(), tabId),
            recovery: "Retry boot to reconnect to the live session.",
          },
        });
      } else {
        // "running" here came from the snapshot above or a live agent_start
        // that landed mid-boot; the stamp must not erase either. The tab was
        // reset to "starting" at boot entry, so nothing stale can be carried in.
        m.patchRpc(tabId, {
          status: get().rpc[tabId]?.status === "running" ? "running" : "ready",
        });
        // Boot reset the tab to fresh state before this ran, so a pending
        // gate on the record hydrates now instead of being clobbered.
        const bootedState = get().state;
        if (bootedState !== null) deps.reconcilePlanGates(bootedState);
        // Same hydration for a question this tab mounted but never received.
        if (bootedState !== null) deps.reconcilePendingDialogs(bootedState);
        // History is in and the tab is live: notices staged across the
        // relaunch land now, after everything that would have dropped them
        // (issue #334).
        const runtime = m.runtime(tabId);
        for (const notice of runtime.pendingNotices) {
          m.appendItem(tabId, noticeItem(notice.text, notice.level));
        }
        m.patchRuntime(tabId, { pendingNotices: [] });
      }
    } catch (err) {
      const liveState = findRecord(get().state, tabId)?.live;
      m.patchRpc(tabId, {
        status: "error",
        failure: {
          message: `RPC boot failed: ${err instanceof Error ? err.message : String(err)}`,
          kind: "boot",
          fatal: true,
          ...(err instanceof RpcCommandTimeoutError
            ? { command: err.command, timeoutMs: err.timeoutMs }
            : {}),
          sessionStatus: "error",
          ...(liveState !== undefined ? { liveState } : {}),
          ...carriedFailedModel(get(), tabId),
          recovery: "Retry boot to reconnect to the live session.",
        },
      });
    } finally {
      rpcBooting.delete(tabId);
    }
  };

  const rpcCommand = (
    tabId: string,
    cmd: SessionCommand,
    opts?: { quiet?: boolean; captureId?: (id: string) => void },
  ): Promise<unknown> => {
    if (!get().rpc[tabId])
      return Promise.reject(new Error("rpc tab not initialized"));
    return rpcCommandMachinery.begin(tabId, cmd, opts, get, m);
  };

  const setInitialPrompt = (tabId: string, prompt: string): void => {
    const tab = get().rpc[tabId];
    if (!tab || tab.initialPrompt || tab.hasRenamed) return;
    // A resumed or user-named session owns its title — never overwrite it.
    // Decided here, at prompt time, because `set_session_name` writes with
    // source "user" and omp then refuses every later auto title.
    if (!isUntitled(findRecord(get().state, tabId)?.title)) {
      m.patchRpc(tabId, { hasRenamed: true });
      return;
    }
    // A greeting or bare ack would latch permanently — defer to the next
    // prompt instead (same policy as omp's own titling). The deferral also
    // avoids a pointless engine call: omp's generator gates its digest,
    // but the latch here would already be set by then.
    if (isLowSignalTitleInput(prompt)) return;
    // Titling fires at the first untitled `agent_end` (reduce-agent-event's
    // rename-session effect); nothing goes out at prompt time.
    m.patchRpc(tabId, { initialPrompt: prompt });
  };

  const renameSession = (tabId: string): void => {
    const tab = get().rpc[tabId];
    if (!tab || !tab.initialPrompt || tab.hasRenamed) return;
    // Latch before anything is sent so a second agent_end can't double-fire.
    // One shot per session: omp's generator retries across its model
    // candidates internally, and a declined generation leaves the session
    // titled by the next manual path — matching omp's own `/rename`
    // semantics (issue #788).
    m.patchRpc(tabId, { hasRenamed: true, initialPrompt: null });
    // A plan-seeded implementation session's title comes from the plan,
    // which the record already names (the sidebar's Implements note reads
    // the same field); a model digest would only paraphrase the seed.
    const planTitle =
      findRecord(get().state, tabId)?.planImplementationSource?.planTitle?.trim() || null;
    if (planTitle !== null) {
      void get()
        .rpcCommand(tabId, { type: "set_session_name", name: planTitle }, { quiet: true })
        .catch((err: unknown) => {
          console.warn("[session-rename] plan title send failed:", err);
        });
      return;
    }
    // omp owns model choice, digest, prompt, parsing, retries, and title
    // precedence: the bare `/rename` runs its generator in the background
    // over rpc-ui and answers with a `command_output` notice. The command
    // is checked before the streaming-queue branch in omp's prompt path,
    // so the dispatch is safe even if the session resumed streaming in the
    // interim; at the agent_end trigger point the session is idle.
    void get()
      .rpcCommand(tabId, { type: "prompt", message: "/rename" }, { quiet: true })
      .catch((err: unknown) => {
        console.warn("[session-rename] /rename dispatch failed:", err);
      });
  };

  const refreshAvailableModels = (tabId: string): Promise<void> =>
    get()
      .rpcCommand(tabId, { type: "get_available_models" }, { quiet: true })
      .then((resp) => {
        m.patchRpc(tabId, { availableModels: parseModelList(respData(resp)) });
      });

  /**
   * Read this session's capability roster through the backend getter — never
   * through the command bus, and never as an `rpcCommand`: the bridge
   * publishes the same snapshot over `setStatus`, so a push can land while
   * this read is in flight and owns the roster afterwards (issue #374).
   */
  const refreshCapabilities = async (tabId: string): Promise<void> => {
    if (get().rpc[tabId] === undefined) return;
    // Every read takes a fresh observation token. Whoever holds it last owns
    // the roster: a push that lands mid-read takes it over, and so does a
    // relaunch's discarded runtime (a rebuilt one restarts at 0, never at a
    // token this read handed out).
    const generation = bumpCapabilitiesGeneration(m, tabId);
    m.patchRpc(tabId, { capabilitiesLoad: "loading" });
    let result: SessionCapabilitiesResult;
    try {
      result = await backend.getSessionCapabilities(tabId);
    } catch (err) {
      // The read failed; the session may be perfectly healthy. Retain the
      // roster on screen and touch neither `status` nor `failure`.
      console.warn("[capabilities] getSessionCapabilities failed:", err);
      if (
        get().rpc[tabId] !== undefined &&
        m.runtime(tabId).capabilitiesGeneration === generation
      )
        m.patchRpc(tabId, { capabilitiesLoad: "error" });
      return;
    }
    const tab = get().rpc[tabId];
    // Torn down while awaiting: the roster belonged to that process.
    if (tab === undefined) return;
    if (m.runtime(tabId).capabilitiesGeneration !== generation) {
      // A push replaced the roster (or a relaunch cleared it) mid-read, and
      // the push is the fresher observation. Re-affirm it; never overwrite.
      if (tab.capabilities !== null)
        m.patchRpc(tabId, { capabilitiesLoad: "available" });
      return;
    }
    if (result.status === "available") {
      m.patchRpc(tabId, {
        capabilities: result.snapshot,
        capabilitiesLoad: "available",
      });
      return;
    }
    // An unavailable session has no roster to show — never a stale one, and
    // never a mutation record for a session that stopped answering (#379).
    m.patchRpc(tabId, {
      capabilities: null,
      capabilitiesLoad: result.status,
      capabilitiesToolPending: null,
      capabilitiesToolFeedback: null,
    });
  };

  /**
   * Session-local enable/disable of one registered tool (issue #379). The
   * change is OMP runtime state only — no config write, no restart, no prompt —
   * and the published roster is the only thing allowed to confirm it: this
   * action never patches a single row, and an answer that arrives after the
   * process or session moved on retires instead of retargeting the tab.
   */
  const setSessionToolEnabled = async (
    tabId: string,
    name: string,
    enabled: boolean,
  ): Promise<SetSessionToolEnabledResult> => {
    const tab = get().rpc[tabId];
    if (tab === undefined) return { status: "missing-session" };
    const observed = tab.capabilities;
    // The roster is the only session identity this tab has observed, so
    // without one there is nothing to bind the request to; a legacy bridge
    // that publishes no tool control is never probed at all.
    if (observed === null) return { status: "bridge-unavailable" };
    if (observed.toolControl !== "available") return { status: "unsupported" };
    const attempt: CapabilitiesToolPending = {
      name,
      enabled,
      processKey: observed.processKey,
      sessionId: observed.sessionId,
    };
    // One mutation per live session at a time, guarded in the store rather
    // than in React: the modal can close and reopen over the same session, and
    // a second deliberate click must never reach the runtime twice.
    const pending = tab.capabilitiesToolPending ?? null;
    if (pending !== null && sameRosterIdentity(pending, attempt))
      return { status: "busy" };
    m.patchRpc(tabId, {
      capabilitiesToolPending: attempt,
      capabilitiesToolFeedback: null,
    });
    let result: SetSessionToolEnabledResult;
    try {
      result = await backend.setSessionToolEnabled(
        tabId,
        attempt.processKey,
        attempt.sessionId,
        name,
        enabled,
      );
    } catch (err) {
      // The channel never rejects by contract, so a rejection is a lost reply:
      // the change may or may not have landed. That is "could not confirm",
      // and it is never reported as a failure that left everything alone.
      console.warn("[capabilities] setSessionToolEnabled failed:", err);
      result = { status: "unconfirmed" };
    }
    // Our attempt must still own the pending slot. Process replacement, a root
    // session change, and teardown all clear it, so a late answer for a
    // retired session writes nothing here.
    const oursNow = (): boolean => {
      const record = get().rpc[tabId]?.capabilitiesToolPending ?? null;
      return (
        record !== null &&
        record.name === attempt.name &&
        record.enabled === attempt.enabled &&
        sameRosterIdentity(record, attempt)
      );
    };
    if (!oursNow()) return { status: "stale" };
    try {
      if (result.status !== "applied") {
        m.patchRpc(tabId, {
          capabilitiesToolFeedback: { name, enabled, status: result.status },
        });
        return result;
      }
      const reply = result.snapshot;
      if (!sameRosterIdentity(reply, attempt)) {
        // An "applied" answer about a different runtime is not this session's
        // answer, whatever it carries.
        m.patchRpc(tabId, {
          capabilitiesToolFeedback: { name, enabled, status: "stale" },
        });
        return { status: "stale" };
      }
      // The completion force-publishes first — which bumps the observation
      // generation, so that token is deliberately NOT consulted here — and the
      // shared acceptance rule then decides by revision which roster this tab
      // shows. Either way the published membership is the confirmation the
      // switch may show; the reply's word alone never is.
      const accepted = acceptCapabilitySnapshot(tabId, reply, get, m);
      const roster = get().rpc[tabId]?.capabilities ?? null;
      const confirmed = accepted || reportsMembership(roster, name, enabled);
      m.patchRpc(tabId, {
        capabilitiesToolFeedback: confirmed
          ? null
          : { name, enabled, status: "not-applied" },
      });
      return confirmed
        ? { status: "applied", snapshot: roster ?? reply }
        : { status: "not-applied" };
    } finally {
      if (oursNow()) m.patchRpc(tabId, { capabilitiesToolPending: null });
    }
  };

  /**
   * Hydrates the goal each tab's live process reports (ADR-0046). Main mirrors
   * omp's goal state onto the session summary, so a renderer that joins late —
   * or a second remote client — shows the goal that already exists. A tab
   * whose process died shows none.
   */
  const reconcileGoals = (state: BackendState): void => {
    for (const [tabId, tab] of Object.entries(get().rpc)) {
      const rec = findRecord(state, tabId);
      if (rec?.goal !== undefined) {
        if (JSON.stringify(rec.goal) !== JSON.stringify(tab.goal))
          m.patchRpc(tabId, { goal: rec.goal });
        continue;
      }
      // No live process reports it: a tab that had a goal from a process that
      // has since died must not keep showing one.
      if (tab.goal !== null && rec?.live !== "live") m.patchRpc(tabId, { goal: null });
    }
  };

  /**
   * Hydrates the autoresearch snapshot each tab's live process reports
   * (ADR-0030), with `reconcileGoals`' semantics: the summary carries it for
   * late joiners, the shared acceptance helper keeps a live frame and a
   * hydrated record in agreement, and a tab whose process died shows none.
   */
  const reconcileAutoresearch = (state: BackendState): void => {
    for (const [tabId, tab] of Object.entries(get().rpc)) {
      const rec = findRecord(state, tabId);
      const snapshot = rec?.autoresearch;
      if (snapshot === undefined) {
        if (tab.autoresearch !== null && rec?.live !== "live")
          m.patchRpc(tabId, { autoresearch: null });
        continue;
      }
      acceptAutoresearchSnapshot(tabId, snapshot, get, m);
    }
  };

  /**
   * Hydrates the vibe snapshot each tab's live process reports (issue #683),
   * with `reconcileGoals`' semantics: the summary carries it for late joiners,
   * the shared acceptance helper keeps a live frame and a hydrated record in
   * agreement, and a tab whose process died shows none.
   */
  const reconcileVibe = (state: BackendState): void => {
    for (const [tabId, tab] of Object.entries(get().rpc)) {
      const rec = findRecord(state, tabId);
      const snapshot = rec?.vibe;
      if (snapshot === undefined) {
        if (tab.vibe !== null && rec?.live !== "live")
          m.patchRpc(tabId, { vibe: null });
        continue;
      }
      acceptVibeSnapshot(tabId, snapshot, get, m);
    }
  };

  return {
    bootRpcTab,
    refreshAvailableModels,
    refreshCapabilities,
    rpcCommand,
    setInitialPrompt,
    renameSession,
    setSessionToolEnabled,
    reloadHistory: loadHistory,
    reconcileGoals,
    reconcileAutoresearch,
    reconcileVibe,
  };
}
