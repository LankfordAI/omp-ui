import { useEffect, useRef, useState } from "react";
import type { MergeBackResult, MergeBackStatus, SessionSummary } from "@omp-ui/core/types";
import { releaseNoticeLevel, releaseNoticeText } from "../lib/format";
import { t } from "../lib/i18n";
import {
  findRecord,
  runningSessionTitleOnCheckout,
  useStore,
  worktreeSharers,
} from "../store";
import { PLACEHOLDER_BRANCH_RE } from "./WorktreeBranchFields";

/**
 * The Finish worktree dialog's state machine (issues #385–#389): three
 * independent decisions — where the work goes (destination: resolved base,
 * any local branch, or a new branch cut from a chosen start point), how it
 * lands (merge commit vs keep branch, with an optional rename), and whether
 * the session returns to the project checkout — run in that order against
 * main. Presentation-free, the way useMergeBack was: the dialog renders this.
 */

export type FinishOutcome = "merge" | "keep";

export type FinishStep = "creating" | "renaming" | "merging" | "syncing" | "returning";

export type FinishPhase =
  | { s: "idle" }
  /** The initial destination resolution / status read is in flight. */
  | { s: "loading" }
  | { s: "working"; step: FinishStep }
  | { s: "conflict"; files: string[]; leftIn: "project" | null }
  | { s: "error"; message: string };

export interface FinishController {
  /** The worktree session; undefined once the record vanished — the dialog closes itself then. */
  record: SessionSummary | undefined;
  /** Local branches from the store, minus the worktree's own. */
  branches: string[];
  /** resolveMergeDestination(base).destination — the initial suggestion. */
  suggestedDestination: string | null;
  /** The selected destination; null while resolving. */
  destination: string | null;
  /** Non-null while "new branch…" is selected. */
  newBranch: { name: string; from: string } | null;
  outcome: FinishOutcome;
  /** Keep-branch rename field; equal to the record's branch means no rename. */
  rename: string;
  returnSession: boolean;
  /** Status for the effective destination (newBranch.from while newBranch is set). */
  status: MergeBackStatus | null;
  phase: FinishPhase;
  /** A session mid-turn in the project checkout (this tab excluded); null when none. */
  busyTitle: string | null;
  ownRunning: boolean;
  sharers: number;
  setDestination(name: string): void;
  chooseNewBranch(): void;
  setNewBranch(patch: Partial<{ name: string; from: string }>): void;
  setOutcome(outcome: FinishOutcome): void;
  setRename(name: string): void;
  setReturnSession(value: boolean): void;
  sync(): Promise<void>;
  run(): Promise<void>;
  /** null disables the primary button. */
  primaryLabel: string | null;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const commitsText = (count: number): string =>
  t(count === 1 ? "branch.merge.oneCommit" : "branch.merge.manyCommits", { count });

export function useFinishWorktree(tabId: string): FinishController {
  const record = useStore((s) => findRecord(s.state, tabId));
  const projectCwd = record?.projectCwd;
  const branchNames = useStore((s) => {
    const info = projectCwd === undefined ? undefined : s.branches[projectCwd];
    return info === undefined ? null : info.branches;
  });
  const busyTitle = useStore((s) =>
    projectCwd === undefined ? null : runningSessionTitleOnCheckout(s, projectCwd, tabId),
  );
  const ownRunning = useStore((s) => s.rpc[tabId]?.status === "running");
  const sharers = useStore((s) =>
    record?.worktree == null ? 0 : worktreeSharers(s.state, tabId, record.worktree.path).length,
  );

  const refreshBranches = useStore((s) => s.refreshBranches);
  const resolveMergeDestination = useStore((s) => s.resolveMergeDestination);
  const readMergeBackStatus = useStore((s) => s.readMergeBackStatus);
  const createBranch = useStore((s) => s.createBranch);
  const mergeWorktreeBranch = useStore((s) => s.mergeWorktreeBranch);
  const releaseWorktreeSession = useStore((s) => s.releaseWorktreeSession);
  const syncWorktreeSession = useStore((s) => s.syncWorktreeSession);
  const renameWorktreeSessionBranch = useStore((s) => s.renameWorktreeSessionBranch);
  const suggestBranchName = useStore((s) => s.suggestBranchName);
  const appendNotice = useStore((s) => s.appendNotice);
  const closeFinishWorktree = useStore((s) => s.closeFinishWorktree);

  const [suggestedDestination, setSuggestedDestination] = useState<string | null>(null);
  const [destination, setDestinationState] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState<{ name: string; from: string } | null>(null);
  const [outcome, setOutcome] = useState<FinishOutcome>("merge");
  const [rename, setRename] = useState(record?.worktree?.branch ?? "");
  const [renameTyped, setRenameTyped] = useState(false);
  const [returnSession, setReturnSession] = useState(true);
  const [status, setStatus] = useState<MergeBackStatus | null>(null);
  const [phase, setPhase] = useState<FinishPhase>({ s: "loading" });

  // Stale-reply guards: one counter for the destination resolution chain,
  // one for the status reads, so a slow reply can never overwrite a newer one.
  const resolveSeq = useRef(0);
  const statusSeq = useRef(0);
  const worktreeBranch = record?.worktree?.branch ?? null;

  // Initialisation, in order: branch listing (local refs only), destination
  // suggestion from the recorded base, then the fallback chain
  // suggested ?? default branch ?? first branch that is not the session's.
  useEffect(() => {
    if (projectCwd === undefined || worktreeBranch === null) return;
    const seq = ++resolveSeq.current;
    void (async () => {
      await refreshBranches(projectCwd, { fetchUpstream: false }).catch(() => {});
      if (seq !== resolveSeq.current) return;
      const resolved = await resolveMergeDestination(projectCwd, record?.worktree?.base ?? null);
      if (seq !== resolveSeq.current) return;
      setSuggestedDestination(resolved.destination);
      const names = useStore.getState().branches[projectCwd]?.branches ?? [];
      if (seq !== resolveSeq.current) return;
      const fallback =
        resolved.destination ??
        useStore.getState().branches[projectCwd]?.defaultBranch ??
        names.find((name) => name !== worktreeBranch) ??
        null;
      setDestinationState((prev) => prev ?? fallback);
    })();
    // `record` is read through its scalar projections on purpose: re-running
    // on object identity would re-resolve on every broadcast.
  }, [projectCwd, worktreeBranch]);

  // Pre-fill the rename field from the model for placeholder branches, until
  // the user types (issue #389 mirrors this on the first prompt; the dialog
  // covers sessions that were named before that hook existed).
  useEffect(() => {
    if (projectCwd === undefined || worktreeBranch === null) return;
    if (!PLACEHOLDER_BRANCH_RE.test(worktreeBranch)) return;
    void (async () => {
      const name = await suggestBranchName(projectCwd, record?.title ?? "");
      if (name === null || renameTyped) return;
      setRename(name);
    })();
  }, [projectCwd, worktreeBranch]);

  // The effective destination: the merge target is the new branch itself,
  // but its feasibility reads against the start point — merging into a fresh
  // branch at X is byte-identical to merging into X. The STATUS key must
  // change when the MODE changes too: entering "new branch…" whose start
  // point equals the old destination leaves the effective name (and the
  // merge payload — a create step is prepended) different while `effectiveDestination`
  // would not move, so keying the fetch on it alone strands the busy phase.
  const effectiveDestination = newBranch !== null ? newBranch.from : destination;
  const statusKey = newBranch === null ? `at:${destination ?? ""}` : `new:${newBranch.from}`;

  const fetchStatus = (): void => {
    if (projectCwd === undefined || worktreeBranch === null || effectiveDestination === null)
      return;
    const seq = ++statusSeq.current;
    readMergeBackStatus(
      projectCwd,
      worktreeBranch,
      effectiveDestination,
      record?.worktree?.path ?? null,
    )
      .then((next) => {
        if (seq !== statusSeq.current) return;
        setStatus(next);
        setPhase((prev) => (prev.s === "loading" ? { s: "idle" } : prev));
        // A dirty checkout cannot be returned (issue #388): both UI and main
        // refuse, so the checkbox follows the status, not the other way round.
        if (next.worktreeDirty === true) setReturnSession(false);
      })
      .catch((error: unknown) => {
        if (seq !== statusSeq.current) return;
        setStatus(null);
        setPhase({ s: "error", message: errorMessage(error) });
      });
  };

  useEffect(() => {
    fetchStatus();
    // `fetchStatus` closes over the current record; the key changes whenever
    // anything it reads changes (mode flips included).
  }, [projectCwd, worktreeBranch, statusKey]);

  const setDestination = (name: string): void => {
    setNewBranch(null);
    setDestinationState(name);
    setPhase({ s: "loading" });
  };

  const chooseNewBranch = (): void => {
    setNewBranch({
      name: "",
      from: suggestedDestination ?? branchNames?.find((name) => name !== worktreeBranch) ?? "",
    });
    setPhase({ s: "loading" });
  };

  const run = async (): Promise<void> => {
    if (record === undefined || record.worktree === null || status === null) return;
    if (phase.s === "working" || phase.s === "loading") return;
    const cwd = record.projectCwd;
    let branch = record.worktree.branch;
    let target = effectiveDestination;
    if (target === null) return;

    // 1. A chosen new branch is cut before anything merges into it (issue #385).
    if (outcome === "merge" && newBranch !== null) {
      const name = newBranch.name.trim();
      if (name === "") return;
      setPhase({ s: "working", step: "creating" });
      try {
        await createBranch(cwd, name, newBranch.from);
      } catch (error) {
        setPhase({ s: "error", message: errorMessage(error) });
        return;
      }
      target = name;
    }

    // 2. Rename before any merge, so the merge commit subject names the final
    // branch (issue #386). A slice-reported failure just returns to idle.
    const renameTo = rename.trim();
    if (outcome === "keep" && renameTo !== "" && renameTo !== branch) {
      setPhase({ s: "working", step: "renaming" });
      const renamed = await renameWorktreeSessionBranch(tabId, renameTo);
      if (!renamed) {
        setPhase({ s: "idle" });
        return;
      }
      branch = renameTo;
    }

    // 3. The merge proper, unless the work is already in (or kept).
    let mergedCommits: number | null = null;
    if (outcome === "merge" && !status.alreadyMerged) {
      setPhase({ s: "working", step: "merging" });
      let result: MergeBackResult;
      try {
        result = await mergeWorktreeBranch(cwd, branch, target);
      } catch (error) {
        setPhase({ s: "error", message: errorMessage(error) });
        return;
      }
      if (result.kind === "conflicts") {
        setPhase({ s: "conflict", files: result.files, leftIn: result.conflictsLeftIn });
        appendNotice(
          tabId,
          result.conflictsLeftIn === "project"
            ? t("notice.merge.conflictProject", {
                count: result.files.length,
                destination: target,
                cwd,
              })
            : t("notice.merge.conflictAborted", {
                count: result.files.length,
                destination: target,
              }),
          "warn",
        );
        fetchStatus();
        return;
      }
      mergedCommits = result.kind === "merged" ? result.commits : null;
      if (!returnSession && result.kind === "merged") {
        // Staying in the worktree: the release notice that would carry this
        // never comes, so name the landing here.
        appendNotice(
          tabId,
          t("notice.merge.landed", {
            commits: commitsText(result.commits),
            branch,
            destination: target,
          }),
          "info",
        );
      }
    }

    // 4. The session decision. releaseWorktreeSession guards the relaunch
    // prep and reports its own failures (null).
    if (returnSession) {
      setPhase({ s: "working", step: "returning" });
      const release = await releaseWorktreeSession(tabId, {
        keepBranch: outcome === "keep",
        mergedInto: outcome === "merge" ? target : null,
      });
      if (release === null) {
        setPhase({ s: "idle" });
        fetchStatus();
        return;
      }
      appendNotice(
        tabId,
        releaseNoticeText(
          release,
          outcome === "merge" ? mergedCommits : null,
          outcome === "keep",
        ),
        releaseNoticeLevel(release),
      );
    }
    closeFinishWorktree();
  };

  const sync = async (): Promise<void> => {
    if (record === undefined || record.worktree == null || effectiveDestination === null) return;
    setPhase({ s: "working", step: "syncing" });
    const result = await syncWorktreeSession(tabId, effectiveDestination);
    if (result === null) {
      setPhase({ s: "idle" });
      return;
    }
    if (result.kind === "conflicts") {
      appendNotice(
        tabId,
        t("notice.merge.syncConflicts", {
          count: result.files.length,
          source: result.source,
          path: record.worktree.path,
        }),
        "warn",
      );
      // The dialog has done its job; the work moves to the checkout, where
      // the session owning the change resolves it (issue #387).
      closeFinishWorktree();
      return;
    }
    fetchStatus();
    setPhase({ s: "idle" });
  };

  // The merge radio's blockers are destination-checkout-specific: a scratch
  // merge is immune to a mid-merge or busy PROJECT checkout, and the new
  // branch never lives in any checkout before the merge.
  const mergeBlocked =
    newBranch === null &&
    status !== null &&
    (status.destinationCheckout === "other" ||
      (status.destinationCheckout === "project" && status.mergeInProgress));

  const renaming = rename.trim() !== "" && rename.trim() !== (worktreeBranch ?? "");

  let primaryLabel: string | null;
  if (destination === null || status === null || !status.branchExists) primaryLabel = null;
  else if (outcome === "merge") {
    if (mergeBlocked) primaryLabel = null;
    else if (newBranch !== null && newBranch.name.trim() === "") primaryLabel = null;
    else if (returnSession)
      primaryLabel = t(
        status.alreadyMerged ? "finish.primary.return" : "finish.primary.mergeReturn",
      );
    else primaryLabel = status.alreadyMerged ? null : t("finish.primary.merge");
  } else {
    if (returnSession)
      primaryLabel = t(renaming ? "finish.primary.renameReturn" : "finish.primary.returnKeep");
    else primaryLabel = renaming ? t("finish.primary.rename") : null;
  }

  return {
    record,
    branches: (branchNames ?? []).filter((name) => name !== worktreeBranch),
    suggestedDestination,
    destination,
    newBranch,
    outcome,
    rename,
    returnSession,
    status,
    phase,
    busyTitle,
    ownRunning,
    sharers,
    setDestination,
    chooseNewBranch,
    setNewBranch: (patch) =>
      setNewBranch((prev) => (prev === null ? prev : { ...prev, ...patch })),
    setOutcome,
    setRename: (name) => {
      setRenameTyped(true);
      setRename(name);
    },
    setReturnSession,
    sync,
    run,
    primaryLabel,
  };
}
