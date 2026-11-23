import { useCallback, type ReactNode } from "react";
import { findOwner, useStore } from "../store";
import { RoutineFocusContext } from "./MarkdownRoutineContext";

/**
 * Opens the Routines view focused on one routine (ADR-0100 amendment, #1306).
 * Mounted at the app root (local host) and overridden per RpcTab so review
 * links clicked inside a remote tab open Routines on that tab's owning host.
 */
export function RoutineFocusProvider({ tabId, children }: { tabId?: string; children: ReactNode }) {
  const focusRoutine = useStore((s) => s.focusRoutine);
  const instanceId = useStore((s) => (tabId === undefined ? null : (findOwner(s.state, tabId)?.instanceId ?? null)));
  const focus = useCallback((id: string) => focusRoutine(id, instanceId), [focusRoutine, instanceId]);
  return <RoutineFocusContext.Provider value={focus}>{children}</RoutineFocusContext.Provider>;
}
