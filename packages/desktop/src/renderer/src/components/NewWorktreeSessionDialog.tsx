import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import { projectKey } from "../lib/project-key";
import { useStore } from "../store";
import { Button, ChoiceCapsule, ConfirmDialog } from "./ui";
import { worktreeBranchPrefix } from "@omp-ui/core/worktree-branch";
import { mintBranchName, WorktreeBranchFields } from "./WorktreeBranchFields";

/**
 * Asks for the branch and base of a worktree session (issue #224): the branch
 * is cut from the base and checked out under the app's worktrees root, so the
 * project's own working tree is never touched. The branch name mints on open
 * and stays editable; git's own stderr is the validation, so a rejected spawn
 * renders its message inline instead of pre-checking names or refs here. The
 * fields themselves are shared with the composer's workspace selector
 * (issue #225) — see WorktreeBranchFields.
 *
 * The dialog also starts a session on an EXISTING local branch (issue #390):
 * the source segment switches from a minted branch to any other local branch,
 * checked out in its own worktree with the repo's default branch recorded as
 * the cut point. The composer's branch-chip section keeps minting; converting
 * an existing session never picks branches.
 */
export function NewWorktreeSessionDialog({
  projectCwd,
  instanceId,
}: {
  projectCwd: string;
  /** The remote instance owning the project (issue #416); null for this host. */
  instanceId: string | null;
}) {
  const [branch, setBranch] = useState(() => mintBranchName(worktreeBranchPrefix(projectCwd)));
  const t = useT();
  // null = cut from the checkout's HEAD (the "current HEAD" option).
  const [baseRef, setBaseRef] = useState<string | null>(null);
  // Issue #405: null = cut from baseRef; ""/name = create that base branch
  // from baseRef first. WorktreeBranchFields owns recomposing the minted
  // branch when the base changes (issue #438), so these are plain setters.
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  const [source, setSource] = useState<"new" | "existing">("new");
  const [existingBranch, setExistingBranch] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const info = useStore((s) => s.branches[projectKey(instanceId, projectCwd)]);
  const newWorktreeSession = useStore((s) => s.newWorktreeSession);
  const closeWorktreeDialog = useStore((s) => s.closeWorktreeDialog);
  const refreshBranches = useStore((s) => s.refreshBranches);

  // repoRoot null (not undefined — undefined means the listing hasn't
  // loaded yet, and the form then just shows the HEAD fallback) means the
  // project isn't a git repository at all.
  const notGit = info?.repoRoot === null;
  // The checkout's own branch cannot be worked in twice: git would refuse
  // the second checkout, so the candidate list drops it.
  const otherBranches = (info?.branches ?? []).filter((name) => name !== info?.current);

  // The existing list is opened rarely; refresh it when the segment is
  // picked so a branch created outside omp-ui shows up (local refs only).
  useEffect(() => {
    if (source === "existing") void refreshBranches(projectCwd, { fetchUpstream: false }, instanceId);
  }, [source, projectCwd, instanceId, refreshBranches]);

  useEffect(() => {
    if (existingBranch === "" && otherBranches.length > 0) setExistingBranch(otherBranches[0]);
  }, [otherBranches.length]);

  const close = (): void => {
    setError(null);
    closeWorktreeDialog();
  };

  const submit = async (): Promise<void> => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await newWorktreeSession(
        projectCwd,
        source === "new"
          ? { mint: { branch, baseRef, baseBranch } }
          : { checkout: { branch: existingBranch } },
        instanceId,
      );
      closeWorktreeDialog();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(false);
    }
  };

  const noOtherBranches = source === "existing" && otherBranches.length === 0;

  return (
    <ConfirmDialog
      kicker={t("dialog.worktree.kicker")}
      title={t("dialog.worktree.title")}
      tone="neutral"
      onClose={close}
      width="w-[28rem]"
      actions={
        <>
          <Button variant="ghost" onClick={close}>
            {t("common.dialog.cancel")}
          </Button>
          <Button variant="solid" disabled={pending || notGit || info === undefined || noOtherBranches || (source === "new" && baseBranch !== null && baseBranch.trim() === "")} onClick={() => void submit()}>
            {t("dialog.worktree.create")}
          </Button>
        </>
      }
    >
      {notGit ? (
        <p className="text-sm leading-relaxed text-ink-dim">
          {t("dialog.worktree.notGit")}
        </p>
      ) : (
        <div className="space-y-4">
          <ChoiceCapsule
            label={t("dialog.worktree.sourceLabel")}
            value={source}
            onChange={setSource}
            options={[
              { value: "new", label: t("dialog.worktree.sourceNew") },
              {
                value: "existing",
                label: t("dialog.worktree.sourceExisting"),
                disabled: otherBranches.length === 0,
                title: otherBranches.length === 0 ? t("dialog.worktree.noOtherBranches") : undefined,
              },
            ]}
          />
          {source === "new" ? (
            <WorktreeBranchFields
              projectCwd={projectCwd}
              instanceId={instanceId}
              branch={branch}
              onBranchChange={setBranch}
              baseRef={baseRef}
              onBaseRefChange={setBaseRef}
              baseBranch={baseBranch}
              onBaseBranchChange={setBaseBranch}
              idPrefix="worktree"
            />
          ) : (
            <div>
              <label htmlFor="worktree-existing" className="block text-[10px] text-ink-faint">
                {t("dialog.worktree.existingBranch")}
              </label>
              <select
                id="worktree-existing"
                value={existingBranch}
                onChange={(event) => setExistingBranch(event.target.value)}
                className="mt-1.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-line-strong"
              >
                {otherBranches.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <p className="mt-1.5 text-[10px] leading-snug text-ink-faint">
                {t("dialog.worktree.existingHint")}
              </p>
            </div>
          )}
          {error !== null && (
            <p className="text-xs leading-relaxed text-rose">{error}</p>
          )}
        </div>
      )}
    </ConfirmDialog>
  );
}
