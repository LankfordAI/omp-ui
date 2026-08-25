import { useCallback, useEffect, useState } from "react";
import { branchNameFromPlanPath } from "../lib/branch-name";
import { cn } from "../lib/cn";
import { planSeedText } from "../lib/plan-seed";
import { runningSessionTitleOnCheckout, useStore } from "../store";
import { Button } from "./ui";

/**
 * The plan review's Git-branch sub-feature (issue #299): where the
 * implementation runs — the current branch, a new one created at execute
 * time, or an existing one checked out first. Switching branches moves the
 * working tree, so a checkout that a mid-turn session runs in earns a
 * confirm, and a refused checkout leaves the gate blocked.
 *
 * The hook owns the state, the prefill effects, and the checkout dance; the
 * fieldset renders it as a controlled component. The hook lives in the
 * parent (PlanReview) because the footer needs reactive values
 * (`checkingOut`, `branchInvalid`, `summary`) to disable and label the
 * execute button.
 */

export type BranchChoice = "current" | "new" | "existing";

export interface ExecutionBranch {
  isRepo: boolean;
  branchChoice: BranchChoice;
  /** Switches the choice and clears a stale error / pending confirm. */
  selectChoice: (choice: BranchChoice) => void;
  newName: string;
  onNewNameChange: (value: string) => void;
  existingName: string | null;
  selectExisting: (name: string) => void;
  branchFilter: string;
  onBranchFilterChange: (value: string) => void;
  branchError: string | null;
  confirmBusy: boolean;
  dismissConfirm: () => void;
  /** The other session's title that earns the confirm. */
  busyTitle: string | null;
  checkingOut: boolean;
  /** New-name empty, or existing unchosen, in a repo. */
  branchInvalid: boolean;
  currentBranch: string | null;
  branches: string[];
  /** The footer's "· <branch>" fragment; null off-repo. */
  summary: string | null;
  /**
   * The checkout dance. Resolves true when the caller may fire executePlan;
   * false when the gate stays blocked (confirm pending, invalid name, or a
   * refused checkout).
   */
  resolve: () => Promise<boolean>;
}

export function useExecutionBranch({
  tabId,
  projectCwd,
  planFilePath,
  planText,
  planTitle,
}: {
  tabId: string;
  projectCwd: string | undefined;
  planFilePath: string | undefined;
  planText: string | null;
  planTitle: string | null;
}): ExecutionBranch {
  const branchInfo = useStore((s) => (projectCwd ? s.branches[projectCwd] : undefined));
  const refreshBranches = useStore((s) => s.refreshBranches);
  const checkoutGitBranch = useStore((s) => s.checkoutGitBranch);
  const suggestBranchName = useStore((s) => s.suggestBranchName);
  // A session mid-turn on this checkout (other than this gate-blocked tab): a
  // plain checkout would move the working tree out from under it.
  const busyTitle = useStore((s) => runningSessionTitleOnCheckout(s, projectCwd, tabId));

  const [branchChoice, setBranchChoice] = useState<BranchChoice>("current");
  const [newName, setNewName] = useState("");
  const [existingName, setExistingName] = useState<string | null>(null);
  const [branchFilter, setBranchFilter] = useState("");
  const [branchError, setBranchError] = useState<string | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [checkingOut, setCheckingOut] = useState(false);

  const isRepo =
    projectCwd !== undefined && branchInfo !== undefined && branchInfo.repoRoot !== null;

  // Branch list on open — another client may have switched branches.
  useEffect(() => {
    if (projectCwd !== undefined && branchInfo === undefined) void refreshBranches(projectCwd);
  }, [projectCwd, branchInfo, refreshBranches]);

  // Mechanical prefill as soon as the review exists.
  useEffect(() => {
    if (planFilePath !== undefined) {
      setNewName((cur) => (cur === "" ? branchNameFromPlanPath(planFilePath) : cur));
    }
  }, [planFilePath]);

  // The model's suggestion replaces the fallback only while the field is
  // untouched (the current value still IS the fallback) — it never overwrites
  // typing. Fires only once planText has loaded; when the plan file is
  // unreadable the fallback prefill alone carries the flow.
  useEffect(() => {
    if (!isRepo || projectCwd === undefined || planFilePath === undefined || planText == null) {
      return;
    }
    const fallback = branchNameFromPlanPath(planFilePath);
    const planContext = `${planTitle ?? planFilePath}\n\n${(planSeedText(planText) ?? "").slice(0, 2000)}`;
    let live = true;
    void suggestBranchName(projectCwd, planContext).then((suggested) => {
      if (!live || suggested === null) return;
      setNewName((cur) => (cur === fallback ? suggested : cur));
    });
    return () => {
      live = false;
    };
  }, [isRepo, projectCwd, planFilePath, planText, planTitle, suggestBranchName]);

  const selectChoice = useCallback((choice: BranchChoice) => {
    setBranchChoice(choice);
    setBranchError(null);
    setConfirmBusy(false);
  }, []);

  const dismissConfirm = useCallback(() => setConfirmBusy(false), []);

  const branchInvalid =
    isRepo &&
    ((branchChoice === "new" && newName.trim() === "") ||
      (branchChoice === "existing" && existingName === null));

  const summary = isRepo
    ? branchChoice === "current"
      ? branchInfo?.current ?? "detached HEAD"
      : branchChoice === "new"
        ? newName.trim() || "new branch"
        : existingName ?? "choose a branch"
    : null;

  const resolve = useCallback(async (): Promise<boolean> => {
    if (!isRepo || branchChoice === "current") return true;
    const name = branchChoice === "new" ? newName.trim() : existingName;
    if (name === null || name === "") return false; // unreachable — the button is disabled
    if (branchChoice === "existing" && name === branchInfo?.current) return true;
    // Switching branches moves the working tree — a session mid-turn on this
    // project earns a confirm first (creating one does not move the tree).
    if (branchChoice === "existing" && busyTitle !== null && !confirmBusy) {
      setConfirmBusy(true);
      return false;
    }
    setCheckingOut(true);
    setBranchError(null);
    const err = await checkoutGitBranch(
      projectCwd!,
      name,
      branchChoice === "new" ? { create: true } : undefined,
    );
    setCheckingOut(false);
    // A refused checkout leaves the gate blocked — the agent must not execute
    // on the wrong branch. git's stderr is the message (branches.ts contract).
    if (err !== null) {
      setBranchError(err);
      setConfirmBusy(false);
      return false;
    }
    return true;
  }, [isRepo, branchChoice, newName, existingName, branchInfo, busyTitle, confirmBusy, checkoutGitBranch, projectCwd]);

  return {
    isRepo,
    branchChoice,
    selectChoice,
    newName,
    onNewNameChange: setNewName,
    existingName,
    selectExisting: setExistingName,
    branchFilter,
    onBranchFilterChange: setBranchFilter,
    branchError,
    confirmBusy,
    dismissConfirm,
    busyTitle,
    checkingOut,
    branchInvalid,
    currentBranch: branchInfo?.current ?? null,
    branches: branchInfo?.branches ?? [],
    summary,
    resolve,
  };
}

export function ExecutionBranchSetup({
  branch,
  onExecute,
}: {
  branch: ExecutionBranch;
  onExecute: () => void;
}) {
  return (
    <fieldset className="mt-5 border-t border-line pt-4">
      <legend className="text-[11px] font-medium text-ink">Git branch</legend>
      <div className="mt-2 grid grid-cols-3 rounded-lg border border-line bg-void/40 p-1">
        {(
          [
            { id: "current", label: "current branch", shortLabel: "current" },
            { id: "new", label: "new branch", shortLabel: "new" },
            { id: "existing", label: "existing branch", shortLabel: "switch" },
          ] as const
        ).map((option) => {
          const active = branch.branchChoice === option.id;
          return (
            <button
              key={option.id}
              type="button"
              aria-label={option.label}
              aria-pressed={active}
              onClick={() => branch.selectChoice(option.id)}
              className={cn(
                "rounded-md px-2 py-1.5 text-[10px] font-medium transition-colors",
                active ? "bg-overlay text-ink edge-lit" : "text-ink-faint hover:text-ink-mid",
              )}
            >
              {option.shortLabel}
            </button>
          );
        })}
      </div>

      <div className="mt-2.5 rounded-lg border border-line bg-raised/70 p-3">
        {branch.branchChoice === "current" && (
          <div>
            <span className="block text-[10px] text-ink-faint">Implement on</span>
            <span className="mt-1 block truncate font-mono text-xs text-ink" title={branch.currentBranch ?? "detached HEAD"}>
              {branch.currentBranch ?? "detached HEAD"}
            </span>
            <p className="mt-1.5 text-[10px] leading-relaxed text-ink-faint">No checkout. Existing working-tree changes stay in place.</p>
          </div>
        )}

        {branch.branchChoice === "new" && (
          <div>
            <label htmlFor="plan-new-branch" className="block text-[10px] text-ink-faint">Create and switch to</label>
            <input
              id="plan-new-branch"
              value={branch.newName}
              placeholder="new-branch-name"
              aria-label="new branch name"
              onChange={(e) => branch.onNewNameChange(e.target.value)}
              className="mt-1.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
            />
            <p className="mt-1.5 text-[10px] leading-relaxed text-ink-faint">Uncommitted work carries into the new branch.</p>
          </div>
        )}

        {branch.branchChoice === "existing" && (
          <div>
            <input
              value={branch.branchFilter}
              placeholder="filter branches…"
              aria-label="filter branches"
              onChange={(e) => branch.onBranchFilterChange(e.target.value)}
              className="w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
            />
            <div className="mt-1.5 flex max-h-36 flex-col overflow-y-auto">
              {branch.branches
                .filter((b) => b.toLowerCase().includes(branch.branchFilter.toLowerCase()))
                .map((b) => (
                  <button
                    key={b}
                    type="button"
                    disabled={b === branch.currentBranch}
                    onClick={() => branch.selectExisting(b)}
                    className={cn(
                      "flex items-center gap-2 rounded px-1.5 py-1 text-left font-mono text-[11px] hover:bg-hover",
                      "disabled:pointer-events-none",
                      b === branch.currentBranch ? "text-iris" : "text-ink-mid",
                      b === branch.existingName && "bg-hover text-ink",
                    )}
                  >
                    <span className={cn("size-1 rounded-full", b === branch.existingName ? "bg-ink-mid" : "bg-line-strong")} />
                    <span className="truncate">{b}</span>
                    {b === branch.currentBranch && <span className="ml-auto font-sans text-[9px] text-ink-faint">current</span>}
                  </button>
                ))}
            </div>
          </div>
        )}
      </div>

      {branch.confirmBusy && (
        <div className="mt-2 rounded-lg border border-copper-dim/50 bg-copper-wash px-3 py-2.5">
          <p className="text-[11px] leading-snug text-copper">
            “{branch.busyTitle}” is mid-turn. Switching changes its working tree.
          </p>
          <div className="mt-2 flex gap-1.5">
            <Button size="xs" tone="copper" onClick={onExecute}>
              switch anyway
            </Button>
            <Button size="xs" variant="ghost" onClick={branch.dismissConfirm}>
              cancel
            </Button>
          </div>
        </div>
      )}

      {branch.branchError !== null && <p className="mt-2 text-[11px] leading-snug text-rose">{branch.branchError}</p>}
    </fieldset>
  );
}
