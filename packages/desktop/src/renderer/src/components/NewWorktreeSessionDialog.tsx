import { useState } from "react";
import { useStore } from "../store";
import { Button, ConfirmDialog } from "./ui";
import { mintBranchName, WorktreeBranchFields } from "./WorktreeBranchFields";

/**
 * Asks for the branch and base of a worktree session (issue #224): the branch
 * is cut from the base and checked out under the app's worktrees root, so the
 * project's own working tree is never touched. The branch name mints on open
 * and stays editable; git's own stderr is the validation, so a rejected spawn
 * renders its message inline instead of pre-checking names or refs here. The
 * fields themselves are shared with the composer's workspace selector
 * (issue #225) — see WorktreeBranchFields.
 */
export function NewWorktreeSessionDialog({ projectCwd }: { projectCwd: string }) {
  const [branch, setBranch] = useState(mintBranchName);
  // null = cut from the checkout's HEAD (the "current HEAD" option).
  const [baseRef, setBaseRef] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const info = useStore((s) => s.branches[projectCwd]);
  const newWorktreeSession = useStore((s) => s.newWorktreeSession);
  const closeWorktreeDialog = useStore((s) => s.closeWorktreeDialog);

  // repoRoot null (not undefined — undefined means the listing hasn't
  // loaded yet, and the form then just shows the HEAD fallback) means the
  // project isn't a git repository at all.
  const notGit = info?.repoRoot === null;

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
          <WorktreeBranchFields
            projectCwd={projectCwd}
            branch={branch}
            onBranchChange={setBranch}
            baseRef={baseRef}
            onBaseRefChange={setBaseRef}
            idPrefix="worktree"
          />
          {error !== null && (
            <p className="text-xs leading-relaxed text-rose">{error}</p>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}
