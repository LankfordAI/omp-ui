import { useEffect, useState } from "react";
import type { RemoteVsCodeTarget } from "@omp-ui/core/types";
import { backend } from "../backend";

/**
 * Open in VS Code over Remote-SSH (issue #995, ADR-0083): the member's
 * target as this computer's main sees it. `null` while the answer is
 * pending; `"failed"` when the channel itself rejected. Asks once per
 * instance while `active` holds, so a closed menu costs nothing.
 */
export function useRemoteVsCodeTarget(
  instanceId: string | null,
  active: boolean,
): RemoteVsCodeTarget | "failed" | null {
  const [answer, setAnswer] = useState<{ instanceId: string; target: RemoteVsCodeTarget | "failed" } | null>(null);
  useEffect(() => {
    if (!active || instanceId === null) return;
    let live = true;
    backend.getRemoteVsCodeTarget(instanceId).then(
      (target) => {
        if (live) setAnswer({ instanceId, target });
      },
      () => {
        if (live) setAnswer({ instanceId, target: "failed" });
      },
    );
    return () => {
      live = false;
    };
  }, [instanceId, active]);
  return active && answer !== null && answer.instanceId === instanceId ? answer.target : null;
}

/**
 * How the Open in VS Code row renders for a target: hidden when this
 * computer has no VS Code (the local open targets hide it the same way),
 * enabled when ready, otherwise disabled with the reason as its subline.
 */
export function remoteVsCodeRow(
  target: RemoteVsCodeTarget | "failed" | null,
  nickname: string,
): { show: false } | { show: true; reason: string | null } {
  if (target === null) return { show: true, reason: "checking SSH…" };
  if (target === "failed") return { show: true, reason: "could not check SSH" };
  if (target.kind === "ready") return { show: true, reason: null };
  const at = target.address ?? nickname;
  switch (target.reason) {
    case "noVsCode":
      return { show: false };
    case "noReport":
      return { show: true, reason: `${at} sent no host report` };
    case "badTarget":
      return { show: true, reason: `${at} reports an ssh host or user VS Code cannot use` };
    case "sshClosed":
      return { show: true, reason: `SSH port 22 did not answer on ${at}` };
  }
}
