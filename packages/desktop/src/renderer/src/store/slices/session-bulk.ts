// Bulk sidebar actions (issue #988): the selection bar applies one action to
// every selected row that supports it. Each call stays tab-routed per row, so
// rows owned by different instances mix freely, and every per-row failure of
// one action lands in a single error notice.
import type { SessionSummary } from "@omp-ui/core/types";
import { backend } from "../../backend";
import type { UiStore } from "../types";
import { bulkFailureNotice, failureMessage, type BulkFailure } from "./bulk-failures";
import { canSettle } from "./settle";
import { findRecord } from "./view";
import type { GetState } from "./shared";

export type BulkAction = "settle" | "snooze" | "unsnooze" | "retitle" | "delete";

/**
 * Whether one row supports one bulk action — the same gates its row menu,
 * hover actions, and Session HUD apply. Snooze and Unsnooze exist only while
 * the Snoozed section is on. Retitle needs a live native session this window
 * runs a transcript for (`session.error.retitleNotLive` otherwise). Stop
 * needs a process; Delete takes every row.
 */
export function supportsBulkAction(st: UiStore, s: SessionSummary, action: BulkAction): boolean {
  const snoozedOn = st.state?.snoozedSectionEnabled === true;
  switch (action) {
    case "settle":
      return canSettle(s, snoozedOn);
    case "snooze":
      return snoozedOn && s.snoozed !== true;
    case "unsnooze":
      return snoozedOn && s.snoozed === true;
    case "retitle":
      return (
        s.mode === "rpc-ui" &&
        s.live === "live" &&
        st.rpc[s.tabId] !== undefined &&
        st.exited[s.tabId] === undefined
      );
    case "delete":
      return true;
  }
}

export type SessionBulkSlice = Pick<UiStore, "snoozeSessions" | "unsnoozeSessions" | "retitleSessions">;

export function createSessionBulkSlice(get: GetState): SessionBulkSlice {
  /** The deduplicated rows of `tabIds` that support `action`, read fresh. */
  const targets = (tabIds: readonly string[], action: BulkAction): SessionSummary[] => {
    const s = get();
    const out: SessionSummary[] = [];
    for (const tabId of new Set(tabIds)) {
      const rec = findRecord(s.state, tabId);
      if (rec !== undefined && supportsBulkAction(s, rec, action)) out.push(rec);
    }
    return out;
  };

  /** Runs one routed call per row and reports the failures as one notice. */
  const eachRow = async (
    rows: readonly SessionSummary[],
    run: (rec: SessionSummary) => Promise<unknown>,
  ): Promise<void> => {
    const failures: BulkFailure[] = [];
    await Promise.all(
      rows.map(async (rec) => {
        try {
          await run(rec);
        } catch (err) {
          failures.push({ tabId: rec.tabId, title: rec.title, message: failureMessage(err) });
        }
      }),
    );
    const notice = bulkFailureNotice(
      failures,
      rows.map((r) => r.tabId),
    );
    if (notice !== null) get().reportError(notice);
  };

  return {
    async snoozeSessions(tabIds, untilMs) {
      // An indefinite snooze keeps the two-argument call so a host older than
      // timed snooze (#979) still accepts it — setSessionSnoozed's convention.
      await eachRow(targets(tabIds, "snooze"), (rec) =>
        untilMs === null
          ? backend.setSessionSnoozed(rec.tabId, true)
          : backend.setSessionSnoozed(rec.tabId, true, untilMs),
      );
    },

    async unsnoozeSessions(tabIds) {
      await eachRow(targets(tabIds, "unsnooze"), (rec) => backend.setSessionSnoozed(rec.tabId, false));
    },

    async retitleSessions(tabIds) {
      // Each live native row runs omp's `/rename` in its own transcript; the
      // command row there is the per-session feedback (issue #788).
      await eachRow(targets(tabIds, "retitle"), (rec) => get().regenerateSessionTitle(rec.tabId));
    },
  };
}
