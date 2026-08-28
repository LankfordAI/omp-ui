import { useState } from "react";
import type { MergeBackStatus } from "@omp-ui/core/types";
import { releaseNoticeLevel, releaseNoticeText } from "../lib/format";
import { runningSessionTitleOnCheckout, useStore, worktreeSharers } from "../store";

export interface MergeBackTarget {
  tabId: string;
  branch: string;
  base: string;
  projectCwd: string;
  worktreePath: string | null;
}

export type MergeBackPhase =
  | { s: "idle" }
  | { s: "merging" }
  | { s: "conflict"; files: string[] }
  | { s: "returning" }
  | { s: "error"; message: string };

export type MergeBackConfirm = null | "merge" | "return";

export interface MergeBackController {
  target: MergeBackTarget | null;
  status: MergeBackStatus | null;
  phase: MergeBackPhase;
  confirm: MergeBackConfirm;
  busyTitle: string | null;
  sharers: number;
  fetchStatus(): void;
  reset(): void;
  requestMerge(): void;
  requestReturn(): void;
  cancelConfirm(): void;
  runMerge(): Promise<void>;
  runReturn(): Promise<void>;
  openConsole(): void;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The shared, presentation-free merge-and-release state machine. */
export function useMergeBack(target: MergeBackTarget | null): MergeBackController {
  const [status, setStatus] = useState<MergeBackStatus | null>(null);
  const [phase, setPhase] = useState<MergeBackPhase>({ s: "idle" });
  const [confirm, setConfirm] = useState<MergeBackConfirm>(null);

  const readMergeBackStatus = useStore((s) => s.readMergeBackStatus);
  const mergeWorktreeBranch = useStore((s) => s.mergeWorktreeBranch);
  const appendNotice = useStore((s) => s.appendNotice);
  const releaseWorktreeSession = useStore((s) => s.releaseWorktreeSession);
  const toggleConsole = useStore((s) => s.toggleConsole);
  const consoleIsOpen = useStore((s) =>
    target === null ? false : s.consoleOpen[target.tabId] === true,
  );
  const busyTitle = useStore((s) =>
    target === null
      ? null
      : runningSessionTitleOnCheckout(s, target.projectCwd, target.tabId),
  );
  const sharers = useStore((s) =>
    target?.worktreePath == null
      ? 0
      : worktreeSharers(s.state, target.tabId, target.worktreePath).length,
  );

  /**
   * Feasibility read; a rejection keeps the status null and becomes the
   * controller's error phase. Re-fetched after every merge attempt.
   */
  const fetchStatus = (): void => {
    if (target === null) return;
    readMergeBackStatus(target.projectCwd, target.branch, target.base)
      .then(setStatus)
      .catch((error: unknown) => {
        setStatus(null);
        setPhase({ s: "error", message: errorMessage(error) });
      });
  };

  const reset = (): void => {
    setStatus(null);
    setPhase({ s: "idle" });
    setConfirm(null);
  };

  /** Hands the session back to the project checkout and names the outcome. */
  const runRelease = async (commits: number | null): Promise<boolean> => {
    if (target === null) return false;
    const release = await releaseWorktreeSession(target.tabId);
    if (release === null) return false;
    appendNotice(
      target.tabId,
      releaseNoticeText(release, commits),
      releaseNoticeLevel(release),
    );
    return true;
  };

  const runMerge = async (): Promise<void> => {
    const destination = status?.destination;
    if (target === null || destination === null || destination === undefined) return;
    setPhase({ s: "merging" });
    let released = false;
    try {
      const result = await mergeWorktreeBranch(target.projectCwd, target.branch, destination);
      setConfirm(null);
      if (result.kind === "conflicts") {
        setPhase({ s: "conflict", files: result.files });
        const more = result.files.length > 5 ? `, and ${result.files.length - 5} more` : "";
        appendNotice(
          target.tabId,
          `merge of ${target.branch} into ${destination} stopped — ${result.files.length} file(s) conflict: ${result.files
            .slice(0, 5)
            .join(", ")}${more}. Resolve in ${target.projectCwd} (git merge --continue) or abort (git merge --abort).`,
          "warn",
        );
      } else {
        setPhase({ s: "returning" });
        released = await runRelease(result.kind === "already-merged" ? null : result.commits);
        if (!released) setPhase({ s: "idle" });
      }
    } catch (error: unknown) {
      setConfirm(null);
      setPhase({ s: "error", message: errorMessage(error) });
    } finally {
      // A released session's worktree UI is about to unmount; failures remain
      // retryable and refresh the settled git state.
      if (!released) fetchStatus();
    }
  };

  const runReturn = async (): Promise<void> => {
    setConfirm(null);
    setPhase({ s: "returning" });
    if (!(await runRelease(null))) {
      setPhase({ s: "idle" });
      fetchStatus();
    }
  };

  const openConsole = (): void => {
    if (target !== null && !consoleIsOpen) toggleConsole(target.tabId);
  };

  return {
    target,
    status,
    phase,
    confirm,
    busyTitle,
    sharers,
    fetchStatus,
    reset,
    requestMerge: () => setConfirm("merge"),
    requestReturn: () => setConfirm("return"),
    cancelConfirm: () => setConfirm(null),
    runMerge,
    runReturn,
    openConsole,
  };
}
