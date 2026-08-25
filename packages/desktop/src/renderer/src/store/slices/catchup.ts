// Staged catch-up digests (issue #273, decomposed for #295): each tab's
// last-viewed baseline, the digest staged when a resurface is due, and its
// one-shot settle.
import type { StoreApi } from "zustand";
import { buildCatchupDigest, CATCHUP_THRESHOLD_MS } from "../../lib/catchup";
import type { GetState, SetState, StoreMachinery } from "./shared";
import { findRecord } from "./view";
import type { CatchupEntry, UiStore } from "../types";

/** Monotonic re-arm counter for staged catch-up entries (issue #273). */
let catchupNonce = 0;

export interface CatchupSlice {
  lastActiveAt: Record<string, number>;
  catchup: Record<string, CatchupEntry>;
  dismissCatchup(tabId: string): void;
}

export interface CatchupRuntime {
  settleCatchup(tabId: string): void;
  armCatchup(tabId: string | null): void;
  installCatchupWatcher(api: StoreApi<UiStore>): void;
}

export function createCatchupSlice(
  set: SetState,
  get: GetState,
  m: StoreMachinery,
): CatchupSlice & CatchupRuntime {
  /**
   * Takes the one catch-up snapshot for a staged resurface (issue #273).
   * No-op unless an unsettled entry is pending — an arm-time settle must
   * survive a later re-boot of the same tab, whose ready path settles again.
   */
  const settleCatchup = (tabId: string): void => {
    const entry = get().catchup[tabId];
    if (entry === undefined || entry.settled) return;
    const digest = buildCatchupDigest({
      items: m.effectiveItems(tabId), // batch-safe: includes unflushed stream commits
      advisor: get().rpc[tabId]?.advisorStats ?? null,
      since: entry.since,
      now: Date.now(),
      live: get().rpc[tabId]?.status === "running",
      pendingPlanTitle: findRecord(get().state, tabId)?.pendingPlan?.title ?? null,
    });
    set((s) => ({ catchup: { ...s.catchup, [tabId]: { ...entry, settled: true, digest } } }));
  };

  /**
   * Records the moment `tabId` became this renderer's active tab (issue
   * #273) and stages a pending catch-up digest when its last-viewed baseline
   * is older than CATCHUP_THRESHOLD_MS. A mounted, non-booting tab settles
   * immediately; a booting tab — or a restored one whose rpc slot is not
   * created yet — settles from the boot ready path instead, where the
   * backfilled items are complete.
   */
  const armCatchup = (tabId: string | null): void => {
    const state = get();
    if (tabId === null) return;
    const tab = state.tabs.find((t) => t.tabId === tabId);
    if (tab === undefined || tab.mode !== "rpc-ui") return;
    const now = Date.now();
    let since = state.lastActiveAt[tabId];
    if (since === undefined) {
      // No in-memory history (app restart, first open in this renderer):
      // fall back to the persisted baseline, then launch time.
      const rec = findRecord(state.state, tabId);
      if (rec !== undefined) {
        since = rec.lastViewedAt ? Date.parse(rec.lastViewedAt) : Date.parse(rec.launchedAt);
      }
    }
    const due = since !== undefined && Number.isFinite(since) && now - since > CATCHUP_THRESHOLD_MS;
    set((s) => ({
      lastActiveAt: { ...s.lastActiveAt, [tabId]: now },
      ...(due
        ? { catchup: { ...s.catchup, [tabId]: { since: since as number, nonce: ++catchupNonce, settled: false, digest: null } } }
        : {}),
    }));
    const status = get().rpc[tabId]?.status;
    if (due && status !== undefined && status !== "starting") settleCatchup(tabId);
  };

  /**
   * Watches activation (issue #273): every activeTabId transition records
   * the leaving tab's last-viewed moment (its baseline is now, not its entry
   * time — a tab watched for hours then hidden for one minute must not read
   * as 15 minutes away on an immediate resurface), then arms the new tab.
   * Installs after restoreDesktopView has settled focus, and arms the
   * restored active tab immediately — a subscription alone would miss the
   * restore, which transitioned before this existed.
   */
  const installCatchupWatcher = (api: StoreApi<UiStore>): void => {
    armCatchup(api.getState().activeTabId);
    api.subscribe((state, previous) => {
      if (state.activeTabId === previous.activeTabId) return;
      const left = previous.activeTabId;
      if (left !== null && state.tabs.some((t) => t.tabId === left)) {
        set((s) => ({ lastActiveAt: { ...s.lastActiveAt, [left]: Date.now() } }));
      }
      armCatchup(state.activeTabId);
    });
  };

  return {
    lastActiveAt: {},
    catchup: {},
    settleCatchup,
    armCatchup,
    installCatchupWatcher,
    dismissCatchup(tabId) {
      set((s) => {
        if (!(tabId in s.catchup)) return s;
        const catchup = { ...s.catchup };
        delete catchup[tabId];
        return { catchup };
      });
    },
  };
}
