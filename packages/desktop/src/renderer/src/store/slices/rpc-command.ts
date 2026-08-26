// RPC command domain (decomposed for #295): boot, command correlation and
// timeout, history backfill, and the two-phase auto titling.
import type { BackendState } from "@omp-ui/core/types";
import { backend } from "../../backend";
import { arrField } from "../../lib/fields";
import { randomId } from "../../lib/random-id";
import {
  emptySessionRuntime,
  parseCommandList,
  parseModelList,
  parseSessionStats,
} from "../../lib/rpc-types";
import {
  generateTitleFromPrompt,
  isLowSignalTitleInput,
  isUntitled,
} from "../../lib/session-title";
import { historyToItems } from "../../lib/transcript";
import {
  RPC_COMMAND_TIMEOUT_MS,
  RpcCommandTimeoutError,
  compactionUsageGenerations,
  handedOffPlanSources,
  respData,
  timedOutCommands,
  type GetState,
  type SetState,
  type StoreMachinery,
  type Watchers,
} from "./shared";
import { findRecord } from "./view";
import type { RpcTabState, UiStore } from "../types";

export type RpcCommandSlice = Pick<
  UiStore,
  "bootRpcTab" | "rpcCommand" | "setInitialPrompt" | "renameSession"
>;

export interface RpcCommandDeps extends Watchers {
  reconcilePlanGates(state: BackendState): void;
}

function freshRpcTabState(advisorReply: boolean): RpcTabState {
  return {
    status: "starting",
    items: [],
    todos: [],
    model: null,
    availableModels: [],
    commands: [],
    session: emptySessionRuntime(),
    stats: null,
    subagents: [],
    subagentItems: {},
    selectedSubagent: null,
    subagentMarkers: new Map(),
    subagentLevel: "progress",
    extensionStatus: {},
    pendingCommands: new Map(),
    streamCheckpoint: undefined,
    streamStallMs: undefined,
    stallAbortPending: undefined,
    stallCount: 0,
    extensionQueue: [],
    busy: false,
    failure: undefined,
    initialPrompt: null,
    autoTitleSent: null,
    hasRenamed: false,
    plan: null,
    planReview: null,
    planText: null,
    planHtml: null,
    planDeferred: false,
    plans: [],
    advisorStats: null,
    mcpStatus: null,
    advisorReply,
  };
}

/** A new rpc process emits exactly one ready frame — that's the boot signal. */
const rpcBooting = new Set<string>();

export function createRpcCommandSlice(
  set: SetState,
  get: GetState,
  m: StoreMachinery,
  deps: RpcCommandDeps,
): RpcCommandSlice {
  // The bodies moved from the root closure keep their original names.
  const {
    concern: concernWatcher,
    advisorReply: advisorReplyWatcher,
    stall: stallContinueWatcher,
  } = deps;

  const loadHistory = async (tabId: string): Promise<void> => {
    const resp = await get().rpcCommand(tabId, { type: "get_messages" });
    // History replaces the transcript wholesale — a batch reduced from the
    // pre-history items would clobber it on the next flush. Per-agent marker
    // memory must not outlive the render items it was deduping against.
    m.cancelTranscriptBatch(tabId);
    get().rpc[tabId]?.subagentMarkers?.clear();
    m.patchRpc(tabId, {
      items: historyToItems(arrField(respData(resp), "messages")),
    });
    // A resumed transcript's advisories are history, not a live review: the
    // baseline moves past them so nothing here is ever answered.
    advisorReplyWatcher.reset(tabId);
    stallContinueWatcher.reset(tabId);
  };

  const bootRpcTab = async (tabId: string): Promise<void> => {
    handedOffPlanSources.delete(tabId);
    if (rpcBooting.has(tabId)) return;
    rpcBooting.add(tabId);
    try {
      // A pending concern handoff belongs to the session that just went away.
      concernWatcher.cancel(tabId);
      advisorReplyWatcher.cancel(tabId);
      stallContinueWatcher.cancel(tabId);
      m.cancelTranscriptBatch(tabId);
      compactionUsageGenerations.delete(tabId);
      // A re-boot must not slam the Agents pane's drill-down shut: the open
      // detail view and the retained buffers behind it survive the process
      // restart, and the subscription re-escalates after boot (issue #63).
      const prior = get().rpc[tabId];
      m.patchRpc(tabId, {
        ...freshRpcTabState(get().state?.advisorAutoReply ?? true),
        selectedSubagent: prior?.selectedSubagent ?? null,
        subagentItems: prior?.subagentItems ?? {},
      });
      // The tab may not exist in state yet — ensure the slot exists.
      if (!get().rpc[tabId]) {
        set((s) => ({
          rpc: {
            ...s.rpc,
            [tabId]: freshRpcTabState(get().state?.advisorAutoReply ?? true),
          },
        }));
      }
      // Boot can outrun init()'s first getState — the record decides whether
      // history (get_messages) is fetched, so don't read it from thin air.
      if (!get().state) set({ state: await backend.getState() });
      const rec = findRecord(get().state, tabId);
      // get_state is the canary: if it fails, the tab is dead, not "ready".
      const stateFailure = await get()
        .rpcCommand(tabId, { type: "get_state" })
        .then(
          (resp) => {
            m.applyRpcState(tabId, resp);
            return null;
          },
          (err: unknown) =>
            err instanceof Error ? err : new Error(String(err)),
        );
      // allSettled, not all: a missing subagent bus or a slow stats read must
      // never leave the tab stuck in "starting".
      const boots: Promise<unknown>[] = [
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
        // "progress" | "events" are the only legal levels; progress is the
        // cheap one — per-agent status, not every subagent token.
        get().rpcCommand(tabId, {
          type: "set_subagent_subscription",
          level: "progress",
        }),
      ];
      if (rec?.sessionId) boots.push(loadHistory(tabId));
      await Promise.allSettled(boots);
      // The fresh process just heard "progress" — reflect that in the
      // tracked level, then re-escalate if a detail view is still open.
      const runtime = get().rpc[tabId];
      if (runtime) {
        runtime.subagentLevel = "progress";
        m.syncSubagentSubscription(tabId);
      }
      // Arm the advisor-stats extension (its first slash run sets its `ui`
      // channel, after which it auto-publishes at each turn end). Armed for
      // every session, not just advisor-on ones: the extension is always loaded,
      // this one shot is cheap and idempotent, and it publishes `available:false`
      // for an advisor-off session that the HUD simply hides. Gating on the
      // record flag would let a stale `advisor` (race with the broadcast after the
      // advisor-toggle relaunch) skip the arm and starve the readout forever.
      void get().refreshAdvisorStats(tabId);
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
            recovery: "Retry boot to reconnect to the live session.",
          },
        });
      } else {
        m.patchRpc(tabId, { status: "ready" });
        // Boot reset the tab to fresh state before this ran, so a pending
        // gate on the record hydrates now instead of being clobbered.
        const bootedState = get().state;
        if (bootedState !== null) deps.reconcilePlanGates(bootedState);
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
          recovery: "Retry boot to reconnect to the live session.",
        },
      });
    } finally {
      rpcBooting.delete(tabId);
    }
  };

  const rpcCommand = (
    tabId: string,
    cmd: Record<string, unknown>,
    opts?: { quiet?: boolean; captureId?: (id: string) => void },
  ): Promise<unknown> => {
    const tab = get().rpc[tabId];
    if (!tab) return Promise.reject(new Error("rpc tab not initialized"));
    const id = randomId();
    const command = typeof cmd.type === "string" ? cmd.type : "unknown";
    const startedAt = Date.now();
    const timeoutMs = RPC_COMMAND_TIMEOUT_MS;
    // Quiet commands are background sync (usage ticks, subagent roster
    // heartbeats). They never touch `busy`: each round-trip would otherwise
    // strobe the progress sweeps for a few ms, jittering the transcript.
    const quiet = opts?.quiet ?? false;
    // Executor form required: the pending entry must exist before send.
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        // Remove before settling so the map remains the authoritative ref
        // count when `finally` recomputes busy.
        tab.pendingCommands.delete(id);
        // Attribution memory: the entry outlives the budget until a
        // completion response is observed, so a later quiet timeout can
        // name the command holding the chain (issue #302).
        const timedOut = timedOutCommands.get(tabId) ?? [];
        timedOut.push({ id, command, startedAt, timedOutAt: Date.now() });
        timedOutCommands.set(tabId, timedOut);
        const runtime = get().rpc[tabId];
        const liveState = findRecord(get().state, tabId)?.live;
        const details = {
          tabId,
          commandId: id,
          command,
          timeoutMs,
          elapsedMs: Date.now() - startedAt,
          pendingCommandCount: tab.pendingCommands.size,
          pending: [...tab.pendingCommands.values()].map((p) => ({
            command: p.command,
            quiet: p.quiet,
            elapsedMs: Date.now() - p.startedAt,
          })),
          sessionStatus: runtime?.status ?? null,
          isStreaming: runtime?.session.isStreaming ?? null,
          liveState: liveState ?? null,
        };
        console.warn("[rpc] command timeout", details);
        reject(new RpcCommandTimeoutError(command, timeoutMs, startedAt));
      }, timeoutMs);
      tab.pendingCommands.set(id, {
        resolve,
        reject,
        timer,
        quiet,
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
      const pending = get().rpc[tabId]?.pendingCommands;
      let loud = 0;
      if (pending) for (const p of pending.values()) if (!p.quiet) loud++;
      if (loud === 0 && get().rpc[tabId]?.busy) {
        m.patchRpc(tabId, { busy: false });
      }
    });
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
    // prompt instead (same policy as omp's own titling).
    if (isLowSignalTitleInput(prompt)) return;
    m.patchRpc(tabId, { initialPrompt: prompt });
    // Two-phase titling starts here: the derived name goes out immediately
    // (renameSession phase 1) and the model title is a background upgrade
    // (phase 2). `renameSession` guards on hasRenamed so the concurrent
    // agent_end path stays a harmless no-op (or a retry of phase 1).
    get().renameSession(tabId);
  };

  const renameSession = (tabId: string): void => {
    const tab = get().rpc[tabId];
    if (!tab || !tab.initialPrompt || tab.hasRenamed) return;
    const prompt = tab.initialPrompt;
    // Latch before the first await so a second agent_end can't double-rename.
    m.patchRpc(tabId, { hasRenamed: true });
    const record = findRecord(get().state, tabId);
    const projectCwd = record?.projectCwd;
    const sessionId = record?.sessionId ?? null;
    const derived = generateTitleFromPrompt(prompt);
    // Phase 1: the derived name goes out immediately, so the session is
    // named before any model round trip — no cold spawn, no provider wait.
    void (async () => {
      try {
        await get().rpcCommand(
          tabId,
          { type: "set_session_name", name: derived },
          { quiet: true },
        );
        const current = get().rpc[tabId];
        if (!current || current.initialPrompt !== prompt) return;
        m.patchRpc(tabId, { autoTitleSent: derived });
        // No model path: the derived name is final.
        if (!projectCwd) m.patchRpc(tabId, { initialPrompt: null });
      } catch (err) {
        // Release the latch so the next agent_end retries the whole titling.
        m.patchRpc(tabId, { hasRenamed: false });
        console.warn("[session-rename] set_session_name failed:", err);
      }
    })();
    // Phase 2: the model title is a background upgrade, never the first
    // name. A cold `omp -p` spawn plus the provider round trip takes
    // seconds (up to the 90 s timeout); waiting on it kept the session
    // unnamed for its whole duration.
    if (!projectCwd) return;
    void (async () => {
      const modelTitle = await backend
        .generateTitle(projectCwd, prompt)
        .catch((err: unknown) => {
          console.warn("[session-rename] model titling failed:", err);
          return null;
        });
      const current = get().rpc[tabId];
      // Tab gone, prompt re-latched, or a manual rename in the interim
      // (renameSessionTo clears initialPrompt): the derived name stands.
      if (!current || current.initialPrompt !== prompt) return;
      // Phase 1 must have landed, or the upgrade could send first and the
      // derived send would then overwrite it.
      if (current.autoTitleSent !== derived) return;
      // A /new or /branch while the model thought: never title the
      // replacement session with the previous prompt.
      if (
        sessionId !== null &&
        findRecord(get().state, tabId)?.sessionId !== sessionId
      )
        return;
      const title = findRecord(get().state, tabId)?.title;
      // The record shows a name we did not set: leave it alone.
      if (!isUntitled(title) && title !== derived) return;
      if (!modelTitle || modelTitle === derived || modelTitle === title) {
        m.patchRpc(tabId, { initialPrompt: null });
        return;
      }
      try {
        // A second user-sourced rename overwrites the first: omp only
        // refuses an "auto" title once a "user" one exists
        // (SessionManager.setSessionName, verified in omp 18.0.4). If a
        // future omp refuses the overwrite, the catch keeps the derived
        // name and settles — the session keeps its phase-1 name.
        await get().rpcCommand(
          tabId,
          { type: "set_session_name", name: modelTitle },
          { quiet: true },
        );
        m.patchRpc(tabId, { autoTitleSent: modelTitle, initialPrompt: null });
      } catch (err) {
        m.patchRpc(tabId, { initialPrompt: null });
        console.warn("[session-rename] title upgrade failed:", err);
      }
    })();
  };

  return {
    bootRpcTab,
    rpcCommand,
    setInitialPrompt,
    renameSession,
  };
}
