import { findRecord, useStore } from "../store";

/** One live-session truth source for the capabilities viewer. */
export function useCapabilityRosterSource(tabId: string | undefined) {
  const record = useStore((state) =>
    tabId === undefined ? undefined : findRecord(state.state, tabId),
  );
  const rpc = useStore((state) =>
    tabId === undefined ? undefined : state.rpc[tabId],
  );
  return {
    record,
    busy: rpc?.status === "running",
    loadStatus: rpc?.capabilitiesLoad ?? "bridge-unavailable",
    snapshot: rpc?.capabilities ?? null,
    toolPending: rpc?.capabilitiesToolPending ?? null,
    toolFeedback: rpc?.capabilitiesToolFeedback ?? null,
    planModeOn: rpc?.plan?.enabled ?? false,
    runtimeBusy:
      rpc?.status === "running" ||
      rpc?.session.isStreaming === true ||
      (rpc?.session.queuedMessageCount ?? 0) > 0,
  } as const;
}
