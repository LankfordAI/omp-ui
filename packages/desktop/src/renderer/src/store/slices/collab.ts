// Live session sharing for terminal tabs (issue #686). omp's `/collab` hosts
// a room from inside the TUI; the main process watches omp's own local
// registry and mirrors per-tab state here. The renderer never sees a room
// key: links are opaque URLs fetched on demand and held only while the
// dialog is open — a generation change (host rotation on /new, /resume,
// branch) re-fetches them. rpc-ui tabs have no collab surface (the command
// lives in omp's TUI, not the RPC protocol), which the UI shows as
// "unavailable" rather than silence.
import type { UiStore } from "../types";
import type { GetState, SetState } from "./shared";
import { hasSeenSharePrivacy, markSharePrivacySeen } from "../../lib/share-privacy";
import { backend } from "../../backend";

export type CollabSlice = Pick<
  UiStore,
  | "collab"
  | "shareLiveTab"
  | "shareLiveConfirmTab"
  | "openShareLive"
  | "confirmShareLivePrivacy"
  | "cancelShareLivePrivacy"
  | "closeShareLive"
  | "startCollab"
  | "stopCollab"
  | "collabLink"
  | "applyCollabState"
>;

export function createCollabSlice(set: SetState, get: GetState): CollabSlice {
  return {
    collab: {},
    shareLiveTab: null,
    shareLiveConfirmTab: null,

    openShareLive(tabId) {
      set({ shareLiveTab: tabId });
    },

    confirmShareLivePrivacy() {
      markSharePrivacySeen();
      const pending = get().shareLiveConfirmTab;
      set({ shareLiveConfirmTab: null });
      if (pending !== null) void get().startCollab(pending.tabId, pending.access);
    },

    cancelShareLivePrivacy() {
      set({ shareLiveConfirmTab: null });
    },

    closeShareLive() {
      set({ shareLiveTab: null });
    },

    async startCollab(tabId, access) {
      // First live share per install rides the privacy dialog — same flag as
      // the snapshot /share (#679): the trust facts differ, the contract
      // (omp publishes, the link is secret material) does not.
      if (!hasSeenSharePrivacy()) {
        // The dialog's Start button re-fires through confirmShareLivePrivacy.
        set({ shareLiveConfirmTab: { tabId, access }, shareLiveTab: null });
        return;
      }
      try {
        await backend.collabShare(tabId, access);
      } catch (err) {
        get().reportError(err);
        return;
      }
      // Optimistic chip: the poll's broadcast replaces (or corrects) it. The
      // registry lags a poll tick behind the keystroke, and a dialog that
      // stays "not sharing" through that gap reads as a failure.
      set((s) => ({
        collab: {
          ...s.collab,
          [tabId]: {
            kind: "sharing",
            state: {
              status: access,
              generation: 0,
              participants: 0,
              relayConnected: true,
              inputRequired: false,
            },
          },
        },
      }));
    },

    async stopCollab(tabId) {
      try {
        await backend.collabStop(tabId);
      } catch (err) {
        get().reportError(err);
      }
    },

    async collabLink(tabId, view) {
      try {
        return await backend.collabLink(tabId, view);
      } catch (err) {
        get().reportError(err);
        throw err;
      }
    },

    applyCollabState(tabId, state) {
      // The registry says hosted or not; whether the tab can host at all is
      // a tab-mode fact the dialog reads directly.
      set((s) => ({
        collab: {
          ...s.collab,
          [tabId]: state === null ? { kind: "off" } : { kind: "sharing", state },
        },
      }));
    },
  };
}
