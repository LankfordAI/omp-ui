import { useEffect, useRef, useState } from "react";
import type {
  MergeBackResult,
  MergeBackStatus,
  PushResult,
  SessionSummary,
} from "@omp-ui/core/types";
import { releaseNoticeLevel, releaseNoticeText } from "../lib/format";
import { t } from "../lib/i18n";
import { projectKey } from "../lib/project-key";
import {
  findOwner,
  findRecord,
  runningSessionTitleOnCheckout,
  useStore,
  worktreeSharers,
} from "../store";
import { isMintedWorktreeBranch, worktreeBranchPrefix } from "@omp-ui/core/worktree-branch";

/**
 * The Finish worktree dialog's state machine (issues #385–#389, #414): three
 * independent decisions — where the work goes (destination: resolved base,
 * any local branch, or a new branch cut from a chosen start point), how it
 * lands (merge commit vs keep branch, with an optional rename), and whether
 * the session returns to the project checkout — run in that order against
 * main. A merged merge-back ends on the done phase: the work is landed
 * locally, and publishing or pushing it stays an explicit separate step.
 * Presentation-free, the way useMergeBack was: the dialog renders this.
 */

export type FinishOutcome = "merge" | "keep";

export type FinishStep = "creating" | "renaming" | "merging" | "syncing" | "returning";

export type FinishPhase =
  | { s: "idle" }
  /** The initial destination resolution / status read is in flight. */
  | { s: "loading" }
  | { s: "working"; step: FinishStep }
  | { s: "conflict"; files: string[]; leftIn: "project" | null }
  | { s: "error"; message: string }
  /**
   * The run landed the work locally (issue #414): the merge merged, the
   * notices fired, and the dialog stays open on the done row so publishing
   * or pushing `destination` stays the user's explicit call.
   * `destinationAhead` / `destinationUpstream` are the destination against its
   * own upstream from a status re-read taken after the merge — the snapshot
   * the dialog rendered while choosing the destination predates the landing.
   * Stored refs only, never a fetch.
   */
  | {
      s: "done";
      destination: string;
      commits: number;
      destinationAhead: number | null;
      destinationUpstream: string | null;
    };

/** The done row's push affordance (issue #414): one button, five states. */
export type FinishPushState =
  | { s: "idle" }
  /** A push of the destination is in flight. */
  | { s: "busy" }
  /** A session is mid-turn on the shared branch; the click awaits confirmation. */
  | { s: "confirm" }
  /** The push answered — `kind` names what the remote did with it. */
  | { s: "settled"; result: PushResult }
  /** The request itself failed (transport); git state never lands here. */
  | { s: "failed"; message: string };

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
  /** The done row's push affordance (issue #414); idle outside the done phase. */
  pushState: FinishPushState;
  /** The repo's push remote from the branch listing; null disables publishing. */
  defaultRemote: string | null;
  /** The repo's default branch — a pull request's base. */
  defaultBranch: string | null;
  /** The remote has no web face: `openPullRequest` said so instead of opening. */
  prUnavailable: boolean;
  /** A session mid-turn in the project checkout (this tab excluded); null when none. */
  busyTitle: string | null;
  /** The branch a return would move the project checkout onto (#431); null when
   *  the destination is where the checkout already stands. */
  checkoutTarget: string | null;
  /** True when a mid-turn session in the project checkout suppresses that switch. */
  checkoutBlockedByBusy: boolean;
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
  /** Pushes (or publishes) the done phase's destination; honouring the busy confirm. */
  pushDone(): Promise<void>;
  /** Arms the busy confirm without pushing. */
  askPushConfirm(): void;
  /** Drops the busy confirm; nothing is pushed by dropping it. */
  dismissPushConfirm(): void;
  /** Opens the host's new-pull-request page for the pushed destination. */
  openPullRequest(): Promise<void>;
  /** null disables the primary button. */
  primaryLabel: string | null;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The plural helper every landed-commit line shares. */
export const commitsText = (count: number): string =>
  t(count === 1 ? "branch.merge.oneCommit" : "branch.merge.manyCommits", { count });

export function useFinishWorktree(tabId: string): FinishController {
  const record = useStore((s) => findRecord(s.state, tabId));
  // The session's owning instance (issue #416): every git step runs there.
  const instanceId = useStore((s) => findOwner(s.state, tabId)?.instanceId ?? null);
  const projectCwd = record?.projectCwd;
  const branchKey = projectCwd === undefined ? undefined : projectKey(instanceId, projectCwd);
  const branchInfo = useStore((s) => {
    const info = branchKey === undefined ? undefined : s.branches[branchKey];
    return info ?? null;
  });
  const branchNames = branchInfo?.branches ?? null;
  // The repo's push remote and default branch (issue #414): what publishing
  // the landed destination would push to, and what a pull request compares it
  // against. Both come from the listing the dialog already refreshed.
  const defaultRemote = branchInfo?.defaultRemote ?? null;
  const defaultBranch = branchInfo?.defaultBranch ?? null;
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
  const pushGitBranch = useStore((s) => s.pushGitBranch);
  const getPullRequestUrl = useStore((s) => s.getPullRequestUrl);

  const [suggestedDestination, setSuggestedDestination] = useState<string | null>(null);
  const [destination, setDestinationState] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState<{ name: string; from: string } | null>(null);
  /** True once the user edited the destination name; prefill never sets it. */
  const [newBranchNameTyped, setNewBranchNameTyped] = useState(false);
  const [outcome, setOutcome] = useState<FinishOutcome>("merge");
  const [rename, setRename] = useState(record?.worktree?.branch ?? "");
  const [renameTyped, setRenameTyped] = useState(false);
  /** The model's branch-name suggestion for this session; null until it answers. */
  const [nameSuggestion, setNameSuggestion] = useState<string | null>(null);
  const [returnSession, setReturnSession] = useState(true);
  const [status, setStatus] = useState<MergeBackStatus | null>(null);
  const [phase, setPhase] = useState<FinishPhase>({ s: "loading" });
  const [pushState, setPushState] = useState<FinishPushState>({ s: "idle" });
  const [prUnavailable, setPrUnavailable] = useState(false);

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
      await refreshBranches(projectCwd, { fetchUpstream: false }, instanceId).catch(() => {});
      if (seq !== resolveSeq.current) return;
      const resolved = await resolveMergeDestination(projectCwd, record?.worktree?.base ?? null, instanceId);
      if (seq !== resolveSeq.current) return;
      setSuggestedDestination(resolved.destination);
      const names = useStore.getState().branches[projectKey(instanceId, projectCwd)]?.branches ?? [];
      if (seq !== resolveSeq.current) return;
      const fallback =
        resolved.destination ??
        useStore.getState().branches[projectKey(instanceId, projectCwd)]?.defaultBranch ??
        names.find((name) => name !== worktreeBranch) ??
        null;
      setDestinationState((prev) => prev ?? fallback);
    })();
    // `record` is read through its scalar projections on purpose: re-running
    // on object identity would re-resolve on every broadcast.
  }, [projectCwd, worktreeBranch]);

  // One model call per dialog open (issue #428 moves generation here, off the
  // session branch): the answer seeds the destination new branch's name and,
  // below, the keep-branch rename field. `live` keeps a resolved answer from
  // landing after the dialog unmounted.
  useEffect(() => {
    if (projectCwd === undefined || worktreeBranch === null) return;
    let live = true;
    void (async () => {
      const name = await suggestBranchName(projectCwd, record?.title ?? "", instanceId);
      // An empty string would never pass the prefill gates below — treat it
      // as no suggestion so the late-arrival effect cannot spin.
      if (live) setNameSuggestion(name === null || name === "" ? null : name);
    })();
    return () => {
      live = false;
    };
  }, [projectCwd, worktreeBranch]);

  // Pre-fill the rename field from the model for placeholder branches, until
  // the user types — the current gate verbatim, now a live condition rather
  // than an early return in the async call (issue #389's dialog half).
  useEffect(() => {
    if (nameSuggestion === null || renameTyped) return;
    if (worktreeBranch === null || projectCwd === undefined) return;
    if (!isMintedWorktreeBranch(worktreeBranch, worktreeBranchPrefix(projectCwd))) return;
    setRename(nameSuggestion);
  }, [nameSuggestion, renameTyped, worktreeBranch, projectCwd]);

  // A suggestion that resolves after "new branch…" was revealed lands in the
  // destination name field while it is still untouched (issue #428).
  useEffect(() => {
    if (newBranch === null || newBranchNameTyped || newBranch.name !== "") return;
    if (nameSuggestion === null) return;
    setNewBranch((prev) => (prev === null ? prev : { ...prev, name: nameSuggestion }));
  }, [newBranch, newBranchNameTyped, nameSuggestion]);

  // The effective destination: the merge target is the new branch itself,
  // but its feasibility reads against the start point — merging into a fresh
  // branch at X is byte-identical to merging into X. The STATUS key must
  // change when the MODE changes too: entering "new branch…" whose start
  // point equals the old destination leaves the effective name (and the
  // merge payload — a create step is prepended) different while `effectiveDestination`
  // would not move, so keying the fetch on it alone strands the busy phase.
  const effectiveDestination = newBranch !== null ? newBranch.from : destination;
  const statusKey = newBranch === null ? `at:${destination ?? ""}` : `new:${newBranch.from}`;

  // The branch the return would move the project checkout onto (#431). A new
  // destination branch is held nowhere by construction — git branch created it
  // without a checkout — and an existing destination checked out nowhere is the
  // same case: the merge ran in a scratch worktree, so the project checkout is
  // not on it. A destination the project checkout holds needs nothing; one held
  // by another worktree never reaches this point. Note the status cannot answer
  // this in new-branch mode: its destinationCheckout describes the start point,
  // not the branch the dialog just created.
  const switchCandidate = newBranch !== null ? newBranch.name.trim() : destination;
  const checkoutTarget =
    returnSession &&
    outcome === "merge" &&
    switchCandidate !== null &&
    switchCandidate !== "" &&
    switchCandidate !== worktreeBranch &&
    (newBranch !== null || status?.destinationCheckout === "none")
      ? switchCandidate
      : null;
  // The project busy guard: switching moves a mid-turn session's files.
  const checkoutBlockedByBusy = checkoutTarget !== null && busyTitle !== null;

  const fetchStatus = (): void => {
    if (projectCwd === undefined || worktreeBranch === null || effectiveDestination === null)
      return;
    const seq = ++statusSeq.current;
    readMergeBackStatus(
      projectCwd,
      worktreeBranch,
      effectiveDestination,
      record?.worktree?.path ?? null,
      instanceId,
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
      name: nameSuggestion ?? "",
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
        await createBranch(cwd, name, newBranch.from, instanceId);
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

    // 3. The merge proper, unless the work is already in (or kept). The
    // result survives the run: the done phase says what landed (issue #414).
    let mergedCommits: number | null = null;
    let mergeResult: MergeBackResult | null = null;
    /** Status re-read after the merge landed; its push facts postdate it. */
    let landed: MergeBackStatus | null = null;
    if (outcome === "merge" && !status.alreadyMerged) {
      setPhase({ s: "working", step: "merging" });
      let result: MergeBackResult;
      try {
        result = await mergeWorktreeBranch(cwd, branch, target, instanceId);
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
      mergeResult = result;
      mergedCommits = result.kind === "merged" ? result.commits : null;
      if (result.kind === "merged") {
        // The dialog's last status was read while the destination still lacked
        // these commits, so its destinationAhead describes the BEFORE state —
        // usually 0, which would leave the done row with nothing to offer.
        // Re-read now, while the worktree path still exists: local refs only,
        // this read never fetches (issue #414).
        landed = await readMergeBackStatus(
          cwd,
          branch,
          target,
          record.worktree?.path ?? null,
          instanceId,
        ).catch(() => null);
      }
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
      const switchTo = checkoutBlockedByBusy ? null : checkoutTarget;
      const release = await releaseWorktreeSession(tabId, {
        keepBranch: outcome === "keep",
        mergedInto: outcome === "merge" ? target : null,
        checkoutOnReturn: switchTo,
      });
      if (release === null) {
        setPhase({ s: "idle" });
        fetchStatus();
        return;
      }
      appendNotice(
        tabId,
        releaseNoticeText(release, outcome === "merge" ? mergedCommits : null, outcome === "keep"),
        releaseNoticeLevel(release),
      );
      // Withheld on purpose, so say so: the finish is not silently half-done.
      if (checkoutTarget !== null && switchTo === null) {
        appendNotice(
          tabId,
          t("notice.finish.switchSkippedBusy", { title: busyTitle ?? "", destination: checkoutTarget }),
          "warn",
        );
      }
    }
    // 5. Landed, but not shared (issue #414): a merge that moved commits
    // stops on the done row, where publishing or pushing `destination` is one
    // deliberate click rather than a side effect of finishing. Every other
    // outcome — keep, rename-only, already-merged — closes as it always did.
    if (mergeResult !== null && mergeResult.kind === "merged") {
      setPushState({ s: "idle" });
      setPrUnavailable(false);
      setPhase({
        s: "done",
        destination: target,
        commits: mergeResult.commits,
        destinationAhead: (landed ?? status).destinationAhead,
        destinationUpstream: (landed ?? status).destinationUpstream,
      });
      return;
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

  // The done row's push (issue #414). The branch is shared state, so a
  // session mid-turn on this checkout — another tab in the project, or this
  // one still streaming — earns the same confirm the branch chip's push row
  // earns; the second call from inside that confirm pushes. `pushGitBranch`
  // refuses while a pull runs on the same repo, and the slice refreshes the
  // listing after a push that moved a ref.
  const pushDone = async (): Promise<void> => {
    if (phase.s !== "done" || projectCwd === undefined) return;
    if (pushState.s === "busy") return;
    if (pushState.s !== "confirm" && (busyTitle !== null || ownRunning)) {
      setPushState({ s: "confirm" });
      return;
    }
    setPushState({ s: "busy" });
    try {
      const result = await pushGitBranch(projectCwd, phase.destination, instanceId);
      setPushState({ s: "settled", result });
    } catch (error) {
      // Only a transport failure throws here; git's refusals arrive as kinds.
      setPushState({ s: "failed", message: errorMessage(error) });
    }
  };

  const askPushConfirm = (): void => {
    if (phase.s !== "done" || pushState.s === "busy") return;
    setPushState({ s: "confirm" });
  };

  const dismissPushConfirm = (): void => {
    if (pushState.s !== "confirm") return;
    setPushState({ s: "idle" });
  };

  // The pull-request page is built by main from the remote's web face; a null
  // answer is an in-place line, never a half-built URL (issue #414). The one
  // way this fails outright — a transport error — reads the same, because the
  // user's next move is identical either way.
  const openPullRequest = async (): Promise<void> => {
    if (phase.s !== "done" || projectCwd === undefined) return;
    // A detached HEAD has no default branch to compare against; that is the
    // same dead end as a remote with no web face, and it says so the same way.
    if (defaultBranch === null) {
      setPrUnavailable(true);
      return;
    }
    try {
      const url = await getPullRequestUrl(
        projectCwd,
        defaultBranch,
        phase.destination,
        instanceId,
      );
      if (url === null) {
        setPrUnavailable(true);
        return;
      }
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      setPrUnavailable(true);
    }
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
    pushState,
    defaultRemote,
    defaultBranch,
    prUnavailable,
    busyTitle,
    checkoutTarget,
    checkoutBlockedByBusy,
    ownRunning,
    sharers,
    setDestination,
    chooseNewBranch,
    setNewBranch: (patch) => {
      // A patch carrying `name` is the input typing (the `from` select writes
      // no name key); latch so no prefill ever displaces it (issue #428).
      if (patch.name !== undefined) setNewBranchNameTyped(true);
      setNewBranch((prev) => (prev === null ? prev : { ...prev, ...patch }));
    },
    setOutcome,
    setRename: (name) => {
      setRenameTyped(true);
      setRename(name);
    },
    setReturnSession,
    sync,
    run,
    pushDone,
    askPushConfirm,
    dismissPushConfirm,
    openPullRequest,
    primaryLabel,
  };
}
