// Live voice recordings (#809): the list/load verbs the strip and (later,
// #810) the playback controls call. Recording identity is assembled from
// state the store already has — the owned session's id from the capability
// frame and the connectionId `startLiveVoice` minted — and resolved against
// disk by the confined main-process reader (ADR-0049). Nothing here invents
// an id: a session that never materialized, or a tab that never started live
// voice, answers `unavailable` without dispatching.
import { formatLiveAudioRef, type LiveAudioEntry, type LiveAudioLoad, type LiveTurn } from "@omp-ui/core/live-voice";
import { backend } from "../../backend";
import type { UiStore } from "../types";
import type { GetState } from "./shared";

export type LiveAudioSlice = Pick<UiStore, "listLiveRecordings" | "loadLiveRecording">;

export function createLiveAudioSlice(get: GetState): LiveAudioSlice {
  const listLiveRecordings = async (tabId: string): Promise<LiveAudioEntry[]> =>
    backend.listLiveAudio(tabId);

  const loadLiveRecording = async (
    tabId: string,
    turn: LiveTurn,
  ): Promise<LiveAudioLoad> => {
    const tab = get().rpc[tabId];
    const sessionId = tab?.session.sessionId ?? null;
    const connectionId = tab?.live?.connectionId ?? null;
    // No session, no connection: there is no honest reference to build, and
    // dispatching a fabricated one would be a lie — not an unavailable.
    if (sessionId === null || connectionId === null) return { status: "unavailable" };
    return backend.readLiveAudio(
      tabId,
      formatLiveAudioRef({ sessionId, connectionId, role: turn.role, turn: turn.turn }),
    );
  };

  return { listLiveRecordings, loadLiveRecording };
}
