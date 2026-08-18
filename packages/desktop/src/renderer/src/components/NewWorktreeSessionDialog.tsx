import { useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { Button, ConfirmDialog } from "./ui";

/**
 * Branch mint for a worktree session (issue #224): the renderer-side twin of
 * core's `mintWorktreeBranch`, `omp-ui/` plus 8 hex from a secure random.
 */
function mintBranchName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return `omp-ui/${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Asks for the branch and base of a worktree session (issue #224): the branch
 * is cut from the base and checked out under the app's worktrees root, so the
 * project's own working tree is never touched. The branch name mints on open
 * and stays editable; git's own stderr is the validation, so a rejected spawn
 * renders its message inline instead of pre-checking names or refs here.
 */
export function NewWorktreeSessionDialog({ projectCwd }: { projectCwd: string }) {
  const [branch, setBranch] = useState(mintBranchName);
  // null = cut from the checkout's HEAD (the "current HEAD" option).
  const [baseRef, setBaseRef] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The base defaults to the checkout's current branch once known; a manual
  // pick must survive later refreshes of the branch list.
  const baseTouched = useRef(false);

  const info = useStore((s) => s.branches[projectCwd]);
  const refreshBranches = useStore((s) => s.refreshBranches);
  const newWorktreeSession = useStore((s) => s.newWorktreeSession);
  const closeWorktreeDialog = useStore((s) => s.closeWorktreeDialog);

  // Populate the base list once on open; the store dedupes concurrent
  // refreshes, so reopening the dialog for a warm project is cheap.
  useEffect(() => {
    void refreshBranches(projectCwd);
  }, [projectCwd, refreshBranches]);

  useEffect(() => {
    if (baseTouched.current) return;
    if (info === undefined) return;
    // Default to the checkout's current branch; when the list is empty or
    // the checkout detaches, the only base is HEAD itself — the state must
    // follow the select so a stale non-null baseRef is never submitted.
    setBaseRef(
      info.branches.length > 0 && info.current !== null
        ? info.current ?? info.defaultBranch
        : null,
    );
  }, [info]);

  // repoRoot null (not undefined — undefined means the listing hasn't
  // loaded yet, and the form then just shows the HEAD fallback) means the
  // project isn't a git repository at all.
  const notGit = info?.repoRoot === null;
  // No local branches, or a detached HEAD: nothing to cut from but the
  // checkout's HEAD itself.
  const branchNames = info?.branches ?? [];
  const headOnly = branchNames.length === 0 || info?.current === null;

  const close = (): void => {
    setError(null);
    closeWorktreeDialog();
  };

  const submit = async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await newWorktreeSession(projectCwd, { branch, baseRef });
      closeWorktreeDialog();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <ConfirmDialog
      kicker="New worktree session"
      title="Start a session in a fresh worktree?"
      tone="neutral"
      onClose={close}
      width="w-[28rem]"
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="solid" disabled={pending || notGit} onClick={() => void submit()}>
            Create session
          </Button>
        </>
      }
    >
      {notGit ? (
        <p className="text-sm leading-relaxed text-ink-dim">
          This project isn't inside a git repo, so there's nothing to worktree.
        </p>
      ) : (
        <div className="space-y-4">
          <div>
            <label htmlFor="worktree-branch" className="block text-[10px] text-ink-faint">
              Branch
            </label>
            <input
              id="worktree-branch"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
              className="mt-1.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
            />
          </div>
          <div>
            <label htmlFor="worktree-base" className="block text-[10px] text-ink-faint">
              Base
            </label>
            <select
              id="worktree-base"
              value={baseRef ?? ""}
              onChange={(event) => {
                baseTouched.current = true;
                setBaseRef(event.target.value === "" ? null : event.target.value);
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
          {error !== null && (
            <p className="text-xs leading-relaxed text-rose">{error}</p>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}
