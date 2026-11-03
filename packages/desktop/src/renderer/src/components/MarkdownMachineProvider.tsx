import type { ReactNode } from "react";
import { findInstance, findOwner, useStore } from "../store";
import { TabMachineContext } from "./MarkdownMachineContext";

/**
 * Scopes the transcript to its owning machine (issue #1023). Mirrors
 * MarkdownVaultProvider: the whole tab shares its owner, keyed on tabId at
 * one mount site.
 */
export function MarkdownMachineProvider({ tabId, children }: { tabId: string; children: ReactNode }) {
  const machine = useStore((s) => {
    const owner = findOwner(s.state, tabId);
    if (owner === undefined || owner.instanceId === null) return null;
    // The id outlives the instance row when it vanishes mid-render; naming
    // the raw id is still more honest than pretending the URL resolves here.
    return findInstance(s.state, owner.instanceId)?.nickname ?? owner.instanceId;
  });
  return <TabMachineContext.Provider value={machine}>{children}</TabMachineContext.Provider>;
}
