import { useEffect, useRef } from "react";
import { useStore } from "../store";

/**
 * Branch mint for a worktree session (issues #224, #225): the renderer-side
 * twin of core's `mintWorktreeBranch`, `omp-ui/` plus 8 hex from a secure
 * random.
 */
export function mintBranchName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `omp-ui/${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The branch and base fields of a worktree session (issues #224, #225),
 * shared by the sidebar's new-worktree dialog and the composer's workspace
 * selector: the branch is cut from the base and checked out under the app's
 * worktrees root, so the project's own working tree is never touched. The
 * base defaults to the checkout's current branch once known and follows the
 * select until the user picks one by hand. Ids are prefixed by the caller so
 * both surfaces can live in one document.
 */
export function WorktreeBranchFields({
  projectCwd,
  branch,
  onBranchChange,
  baseRef,
  onBaseRefChange,
  idPrefix,
}: {
  projectCwd: string;
  branch: string;
  onBranchChange: (value: string) => void;
  /** null = cut from the checkout's HEAD (the "current HEAD" option). */
  baseRef: string | null;
  onBaseRefChange: (value: string | null) => void;
  idPrefix: string;
}) {
  // The base defaults to the checkout's current branch once known; a manual
  // pick must survive later refreshes of the branch list.
  const baseTouched = useRef(false);

  const info = useStore((s) => s.branches[projectCwd]);
  const refreshBranches = useStore((s) => s.refreshBranches);

  // Populate the base list once on mount; the store dedupes concurrent
  // refreshes, so a warm project is cheap.
  useEffect(() => {
    void refreshBranches(projectCwd);
  }, [projectCwd, refreshBranches]);

  useEffect(() => {
    if (baseTouched.current) return;
    if (info === undefined) return;
    // Default to the checkout's current branch; when the list is empty or
    // the checkout detaches, the only base is HEAD itself — the state must
    // follow the select so a stale non-null baseRef is never submitted.
    const next =
      info.branches.length > 0 && info.current !== null
        ? (info.current ?? info.defaultBranch)
        : null;
    if (next !== baseRef) onBaseRefChange(next);
  }, [info, baseRef, onBaseRefChange]);

  // No local branches, or a detached HEAD: nothing to cut from but the
  // checkout's HEAD itself.
  const branchNames = info?.branches ?? [];
  const headOnly = branchNames.length === 0 || info?.current === null;

  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-branch`} className="block text-[10px] text-ink-faint">
          Branch
        </label>
        <input
          id={`${idPrefix}-branch`}
          value={branch}
          onChange={(event) => onBranchChange(event.target.value)}
          className="mt-1.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
        />
      </div>
      <div>
        <label htmlFor={`${idPrefix}-base`} className="block text-[10px] text-ink-faint">
          Base
        </label>
        <select
          id={`${idPrefix}-base`}
          value={baseRef ?? ""}
          onChange={(event) => {
            baseTouched.current = true;
            onBaseRefChange(event.target.value === "" ? null : event.target.value);
          }}
          className="mt-1.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-line-strong"
        >
          {headOnly ? (
            <option value="">current HEAD</option>
          ) : (
            branchNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))
          )}
        </select>
      </div>
    </>
  );
}
