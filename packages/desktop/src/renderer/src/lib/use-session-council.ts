import { useEffect, useState } from "react";
import { COUNCIL_COMMAND } from "@omp-ui/core/council";
import { backendFor } from "../backend";
import { useStore } from "../store";

/**
 * Members of the council this tab's running process can launch, or null when
 * it can launch none (ADR-0088, #1155): the current switch, a live process,
 * the advertised bridge command, and the process's own captured status must
 * all agree. Settings edits after launch never make it available.
 */
export function useSessionCouncilMembers(tabId: string): number | null {
  const enabled = useStore((s) => s.state?.councilEnabled === true);
  const instanceId = useStore((s) => s.tabs.find((t) => t.tabId === tabId)?.instanceId ?? null);
  const live = useStore((s) => {
    const status = s.rpc[tabId]?.status;
    return status === "ready" || status === "running";
  });
  const bridge = useStore(
    (s) => s.rpc[tabId]?.commands.some((c) => c.name === COUNCIL_COMMAND && c.source === "extension") === true,
  );
  const key = `${tabId}\u0000${instanceId ?? ""}`;
  const [answer, setAnswer] = useState<{ key: string; members: number | null } | null>(null);
  useEffect(() => {
    if (!enabled || !live || !bridge) return;
    let current = true;
    backendFor(instanceId)
      .getSessionCouncilStatus(tabId)
      .then(
        (status) => {
          if (current) setAnswer({ key, members: status.status === "available" ? status.memberCount : null });
        },
        () => {
          if (current) setAnswer({ key, members: null });
        },
      );
    return () => {
      current = false;
    };
  }, [enabled, live, bridge, tabId, instanceId, key]);
  return enabled && live && bridge && answer?.key === key ? answer.members : null;
}
