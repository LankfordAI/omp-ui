// Settle (issue #980): the explicit "I'm done with this" action. It rides the
// tab-routed `session:settle` channel (#924's reap), so a remote session
// settles on its host, and keeps a renderer-local undo stack: undo exists only
// for settles made in this window during this run, one entry per action.
import type { SessionSummary } from "@omp-ui/core/types";
import { backend } from "../../backend";
import { t } from "../../lib/i18n";
import { randomId } from "../../lib/random-id";
import type { SettleUndoEntry, UiStore } from "../types";
import { bulkFailureNotice, failureMessage, type BulkFailure } from "./bulk-failures";
import { findRecord } from "./view";
import type { GetState, SetState } from "./shared";

/** Undo entries kept; older settles fall off and can only be resumed by hand. */
export const SETTLE_UNDO_LIMIT = 20;

export type SettleSlice = Pick<
  UiStore,
  "settleUndo" | "settleToastId" | "settleSessions" | "undoSettle" | "dismissSettleToast" | "recordAutoSettle"
>;

/**
 * Whether a session can be settled now. A live row inside a turn keeps Stop
 * instead: Settle is for finished work. `localTurn` is this renderer's own
 * turn signal (rpc status `running`), which leads the host-published latch.
 * A snoozed row can always settle — it leaves Snoozed for Settled — but only
 * while the Snoozed section is on, the only place such a row reads as parked.
 * A dormant unsnoozed row is already settled.
 */
export function canSettle(s: SessionSummary, localTurn: boolean, snoozedSectionEnabled: boolean): boolean {
  if (s.live === "live") return s.turnRunning !== true && !localTurn;
  return snoozedSectionEnabled && s.snoozed === true;
}

export function createSettleSlice(set: SetState, get: GetState): SettleSlice {
  /** Tabs with a settle in flight: a second click must not queue a second reap. */
  const inFlight = new Set<string>();

  return {
    settleUndo: [],
    settleToastId: null,

    async settleSessions(tabIds) {
      const s0 = get();
      const snoozedOn = s0.state?.snoozedSectionEnabled === true;
      const targets: SettleUndoEntry["sessions"] = [];
      for (const tabId of tabIds) {
        const rec = findRecord(s0.state, tabId);
        if (rec === undefined || inFlight.has(tabId)) continue;
        if (!canSettle(rec, s0.rpc[tabId]?.status === "running", snoozedOn)) continue;
        targets.push({
          tabId,
          title: rec.title,
          wasLive: rec.live === "live",
          snoozed: rec.snoozed === true,
          snoozedUntilMs: rec.snoozed === true ? rec.snoozedUntilMs : null,
        });
      }
      if (targets.length === 0) return;
      for (const target of targets) inFlight.add(target.tabId);
      const settled: SettleUndoEntry["sessions"] = [];
      // A bulk settle (#988) reports every failed row in one notice.
      const failures: BulkFailure[] = [];
      await Promise.all(
        targets.map(async (target) => {
          try {
            if (await backend.settleSession(target.tabId)) settled.push(target);
            else {
              failures.push({
                tabId: target.tabId,
                title: target.title,
                message: t("settle.error.skippedReason"),
                alone: t("settle.error.skipped", { title: target.title }),
              });
            }
          } catch (err) {
            failures.push({ tabId: target.tabId, title: target.title, message: failureMessage(err) });
          } finally {
            inFlight.delete(target.tabId);
          }
        }),
      );
      const notice = bulkFailureNotice(failures, targets.map((target) => target.tabId));
      if (notice !== null) get().reportError(notice);
      if (settled.length === 0) return;
      // Request order, not completion order: the toast names the first one.
      settled.sort((a, b) => targets.indexOf(a) - targets.indexOf(b));
      const entry: SettleUndoEntry = { id: randomId(), sessions: settled };
      set((s) => ({
        settleUndo: [...s.settleUndo, entry].slice(-SETTLE_UNDO_LIMIT),
        settleToastId: entry.id,
      }));
    },

    undoSettle() {
      const entry = get().settleUndo.at(-1);
      if (entry === undefined) return false;
      set((s) => ({
        settleUndo: s.settleUndo.slice(0, -1),
        settleToastId: s.settleToastId === entry.id ? null : s.settleToastId,
      }));
      void (async () => {
        for (const target of entry.sessions) {
          const s = get();
          const rec = findRecord(s.state, target.tabId);
          // Deleted since, or already resumed by hand: nothing to restore.
          if (rec === undefined || rec.live === "live") continue;
          if (target.snoozed && rec.snoozed !== true) {
            await s.setSessionSnoozed(target.tabId, true, target.snoozedUntilMs);
          }
          if (!target.wasLive) continue;
          // The normal resume path: a mounted (hidden) tab relaunches in
          // place; an unmounted one spawns its tab through openSession.
          if (s.tabs.some((tab) => tab.tabId === target.tabId)) await s.resumeDead(target.tabId);
          else await s.openSession(target.tabId);
        }
      })();
      return true;
    },

    dismissSettleToast() {
      set({ settleToastId: null });
    },

    recordAutoSettle(sessions) {
      // A merged pull request settled these on their host (issue #985). The
      // event reaches every renderer of the owning host and every joiner; each
      // keeps its own undo entry, and Undo resumes through the normal path.
      if (sessions.length === 0) return;
      const entry: SettleUndoEntry = {
        id: randomId(),
        cause: "merged",
        sessions: sessions.map((s) => ({ ...s })),
      };
      set((s) => ({
        settleUndo: [...s.settleUndo, entry].slice(-SETTLE_UNDO_LIMIT),
        settleToastId: entry.id,
      }));
    },
  };
}
