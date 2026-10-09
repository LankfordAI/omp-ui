// Live voice recordings (#809, #810): the list/load verbs the strip probes,
// and the replay state machine the strip's and the rail's Play buttons drive.
// Recording identity is assembled from state the store already has — the
// owned session's id from the capability frame and the connectionId
// `startLiveVoice` minted — or, after a reopen wiped `live`, from a
// `listLiveRecordings` entry's own connectionId: disk enumeration carries
// identity off disk, so replay survives the process death that reset the
// snapshot. Nothing here invents an id: a session that never materialized,
// or a tab that never started live voice, answers `unavailable` without
// dispatching. Replay dispatches only the read channel — it never sends a
// live command or touches runtime fields, so #811's pending-feedback state
// and the sidebar speaker glyph cannot see it (AC 5).
import {
  formatLiveAudioRef,
  isLiveConnectionId,
  type LiveAudioEntry,
  type LiveAudioLoad,
  type LiveHistoryEntry,
  type LiveTurn,
} from "@omp-ui/core/live-voice";
import type { StoreApi } from "zustand";
import { backend } from "../../backend";
import type { UiStore } from "../types";
import type { GetState, SetState } from "./shared";

/** What a Play button points at: a strip row's turn, or a rail row's entry. */
export type LiveReplayTarget =
  | { kind: "turn"; turn: LiveTurn; connectionId?: string } // strip rows; history rows carry their own
  | { kind: "entry"; entry: LiveAudioEntry }; // rail rows, reopen-safe

/**
 * The one clip omp-ui replays at a time. `key` names it across renders:
 * `${tabId}:${connectionId}:${turn}` — components compare it to decide
 * which row shows Pause. `notice` carries the guard's visible reason:
 * "live-speaking" means the guard paused this clip because omp's live
 * output took the audio back; an explicit resume clears it.
 */
export interface LiveReplayState {
  key: string;
  tabId: string;
  /** The v1 reference the load was dispatched with. */
  ref: string;
  status: "loading" | "playing" | "paused";
  notice: "live-speaking" | null;
}

export type LiveAudioSlice = Pick<
  UiStore,
  | "liveReplay"
  | "listLiveRecordings"
  | "loadLiveRecording"
  | "appendLiveHistory"
  | "listLiveHistory"
  | "playLiveRecording"
  | "pauseLiveReplay"
  | "resumeLiveReplay"
  | "stopLiveReplay"
>;

// One clip at a time across every mount (LiveVoiceSection's previewAudio
// precedent): claiming the singleton IS the mutual exclusion — a second
// play supersedes the first by replacing the src, and superseded slice
// state is replaced, never torn down twice. A data URI carries the bytes
// (the ToolCard inline-bytes convention): blob URLs' backing-store reads
// fail under the harness, and a data URI needs no revoke path.
let replayAudio: HTMLAudioElement | null = null;

export function createLiveAudioSlice(get: GetState, set: SetState): LiveAudioSlice {
  const listLiveRecordings = async (tabId: string): Promise<LiveAudioEntry[]> =>
    backend.listLiveAudio(tabId);

  /**
   * Persist one final spoken turn (#817). Fire-and-forget from the frame
   * reducer: the snapshot already rendered the text, so a disk failure (or
   * a rejected arg codec) swallows — the durable copy is a bonus, never the
   * render source. Non-finals and un-minted connection ids never dispatch:
   * only finals are persisted, and only under a real connection.
   */
  const appendLiveHistory = async (
    tabId: string,
    connectionId: string,
    turn: LiveTurn,
  ): Promise<void> => {
    if (!turn.final || !isLiveConnectionId(connectionId)) return;
    try {
      await backend.liveTranscriptAppend(tabId, connectionId, {
        role: turn.role,
        turn: turn.turn,
        text: turn.text,
      });
    } catch {
      // The strip keeps showing the text either way.
    }
  };

  // Channels never throw by contract; the catch is the renderer-side twin
  // of that promise (and of appendLiveHistory's swallow): a failed read
  // shows the snapshot alone, never an error boundary.
  const listLiveHistory = async (tabId: string): Promise<LiveHistoryEntry[]> => {
    try {
      return await backend.liveTranscriptRead(tabId);
    } catch {
      return [];
    }
  };

  // `connectionId` overrides the snapshot's (#817): a history row from an
  // earlier connection probes its own connection's files — the snapshot's
  // id would read the wrong connection's take and miss.
  const loadLiveRecording = async (
    tabId: string,
    turn: LiveTurn,
    connectionId?: string | null,
  ): Promise<LiveAudioLoad> => {
    const tab = get().rpc[tabId];
    const sessionId = tab?.session.sessionId ?? null;
    const refConnectionId = connectionId ?? tab?.live?.connectionId ?? null;
    // No session, no connection: there is no honest reference to build, and
    // dispatching a fabricated one would be a lie — not an unavailable.
    if (sessionId === null || refConnectionId === null) return { status: "unavailable" };
    return backend.readLiveAudio(
      tabId,
      formatLiveAudioRef({ sessionId, connectionId: refConnectionId, role: turn.role, turn: turn.turn }),
    );
  };

  const pauseLiveReplay = (): void => {
    const state = get().liveReplay;
    if (state === null || state.status !== "playing") return;
    replayAudio?.pause();
    set({ liveReplay: { ...state, status: "paused" } });
  };

  const resumeLiveReplay = (): void => {
    const state = get().liveReplay;
    if (state === null || state.status !== "paused") return;
    // The notice clears only here: resume is the user taking control back,
    // and a stale "live output is speaking" badge under a clip the user
    // just started would be a lie.
    set({ liveReplay: { ...state, status: "playing", notice: null } });
    void replayAudio?.play().catch(() => {
      const now = get().liveReplay;
      if (now !== null && now.key === state.key) {
        set({ liveReplay: { ...now, status: "paused" } });
      }
    });
  };

  const stopLiveReplay = (): void => {
    if (replayAudio !== null) {
      replayAudio.pause();
      // Dropping the src releases the decoded buffer; the next play
      // re-assigns before it plays.
      replayAudio.src = "";
    }
    if (get().liveReplay !== null) set({ liveReplay: null });
  };

  const playLiveRecording = async (
    tabId: string,
    target: LiveReplayTarget,
  ): Promise<void> => {
    const state = get();
    const live = state.rpc[tabId]?.live ?? null;
    // The belt to the UI's braces: a row that rendered enabled can still be
    // clicked during the frame where live output started speaking. Refuse
    // without a state change; the component owns the visible reason. Same
    // rule as isLiveSessionActive, inlined for narrowing — the ended check
    // matters, because applyLiveEnd keeps the phase and a stopped session
    // has no live output to overlap (AC 2).
    if (live !== null && !live.ended && live.phase === "speaking") return;
    const sessionId = state.rpc[tabId]?.session.sessionId ?? null;
    if (sessionId === null) return;
    // The ref's connection segment: an entry carries its own (disk truth,
    // reopen-safe); a strip turn rides an explicit history connectionId
    // when the row came from disk (#817), else the live snapshot — no
    // local start and no row id means no honest ref to build.
    const connectionId =
      target.kind === "entry"
        ? target.entry.connectionId
        : target.connectionId ?? live?.connectionId ?? null;
    if (connectionId === null) return;
    const role = target.kind === "entry" ? target.entry.role : target.turn.role;
    const turnNumber = target.kind === "entry" ? target.entry.turn : target.turn.turn;
    const ref = formatLiveAudioRef({ sessionId, connectionId, role, turn: turnNumber });
    const key = `${tabId}:${connectionId}:${turnNumber}`;
    // Claiming the slot stops the previous clip: the src swap below happens
    // before any play, and a superseded play's continuation checks this key
    // before touching anything.
    set({ liveReplay: { key, tabId, ref, status: "loading", notice: null } });
    const load = await backend.readLiveAudio(tabId, ref);
    if (get().liveReplay?.key !== key) return;
    if (load.status !== "ready" || load.wavBase64 === undefined) {
      // Never fall back, never fabricate: the affordance re-renders idle.
      set({ liveReplay: null });
      return;
    }
    replayAudio ??= new Audio();
    const audio = replayAudio;
    audio.onended = () => {
      if (get().liveReplay?.key === key) stopLiveReplay();
    };
    audio.src = `data:audio/wav;base64,${load.wavBase64}`;
    try {
      await audio.play();
    } catch {
      // An autoplay refusal keeps the clip loaded and paused: the row shows
      // Resume, and a user click resumes without reloading.
      const now = get().liveReplay;
      if (now !== null && now.key === key) set({ liveReplay: { ...now, status: "paused" } });
      return;
    }
    const now = get().liveReplay;
    if (now !== null && now.key === key) set({ liveReplay: { ...now, status: "playing" } });
  };

  return {
    liveReplay: null,
    listLiveRecordings,
    loadLiveRecording,
    appendLiveHistory,
    listLiveHistory,
    playLiveRecording,
    pauseLiveReplay,
    resumeLiveReplay,
    stopLiveReplay,
  };
}

const replayGuardsInstalled = new WeakSet<StoreApi<UiStore>>();

/**
 * The two replay guards (#810), the replay twin of
 * `installLiveVoiceParkResumeGuard`: the same activeTabId diff, so "left
 * the session" means exactly what it means for the park guard.
 *
 * - Leaving the tab a clip is playing in pauses it; returning never
 *   auto-resumes — replaying audio at a user who did not just ask for it
 *   is not a pause's promise.
 * - Live output speaking over the replaying tab pauses the clip in flight
 *   and marks it, so the row says WHY it stopped. The phase frame is the
 *   only audio truth omp gives us (ADR-0049); a refusal-with-reason is
 *   the honest shape of "never overlap" (AC 4).
 */
export function installLiveReplayGuards(api: StoreApi<UiStore>): () => void {
  if (replayGuardsInstalled.has(api)) return () => {};
  replayGuardsInstalled.add(api);
  return api.subscribe((state, previous) => {
    const replay = state.liveReplay;
    if (replay === null || replay.status !== "playing") return;
    // Leave: the tab the clip belongs to lost the view.
    if (state.activeTabId !== previous.activeTabId) {
      if (previous.activeTabId === replay.tabId) {
        replayAudio?.pause();
        api.setState({ liveReplay: { ...replay, status: "paused" } });
      }
      return;
    }
    // Live output took the audio back on this tab: pause and say why.
    // Only a fresh transition into speaking counts — a snapshot that
    // arrived already speaking (a frame race) is covered by play's own
    // gate, not by re-pausing a clip that never overlapped.
    if (state.activeTabId !== replay.tabId) return;
    const wasSpeaking = previous.rpc[replay.tabId]?.live?.phase === "speaking";
    const isSpeaking = state.rpc[replay.tabId]?.live?.phase === "speaking";
    if (!wasSpeaking && isSpeaking) {
      replayAudio?.pause();
      api.setState({ liveReplay: { ...replay, status: "paused", notice: "live-speaking" } });
    }
  });
}
