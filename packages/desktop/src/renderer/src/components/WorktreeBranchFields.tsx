import { useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import { projectKey } from "../lib/project-key";
import { useStore } from "../store";

/**
 * Where an unprompted session's first prompt will run (issues #225, #227):
 * the project checkout as-is, or a fresh worktree cut on the first send.
 * `baseTouched` lives in the selection, not in the fields, because the
 * composer's popover unmounts the fields when it closes — a hand-picked base
 * must survive that round-trip (issue #227). `baseBranch` (issue #405):
 * null = the session branch is cut from `baseRef`; "" = the new-branch mode
 * was toggled on with the name not typed yet; non-empty = create that branch
 * from `baseRef` first, cut the session branch from it, and record it as
 * the base.
 */
export type WorkspaceSelection =
  | { mode: "checkout" }
  | {
      mode: "worktree";
      branch: string;
      baseRef: string | null;
      baseBranch: string | null;
      baseTouched: boolean;
    };

/**
 * Select value meaning "create a new base branch" instead of naming an
 * existing ref. Shared with the finish dialog's destination select, which
 * uses the same reveal pattern; `__new__` is a legal refname, so the option
 * list filters it out rather than risking a duplicate value.
 */
export const NEW_BRANCH_SENTINEL = "__new__";

/**
 * A minted name no human chose: the renderer-side twin of core's
 * `PLACEHOLDER_BRANCH_RE` (the renderer cannot import core runtime). The
 * auto-naming, the finish dialog's suggestion pre-fill, and the
 * base-following recomposition key on it — a user-typed branch name is
 * never touched (issues #389, #405).
 */
export const PLACEHOLDER_BRANCH_RE = /^omp-ui\/(?:[^/]+\/)*[0-9a-f]{8}$/;

/** The one composition rule — the renderer twin of core's
 * `composeWorktreeBranch`. The tail is the mint's hash, or a plan-derived
 * name once the plan has named the branch (issue #422). */
export function composeWorktreeBranch(segment: string | null, hash: string): string {
  return segment === null ? `omp-ui/${hash}` : `omp-ui/${segment}/${hash}`;
}

/**
 * Branch mint for a worktree session (issues #224, #225, #405): the
 * renderer-side twin of core's `mintWorktreeBranch`, `omp-ui/` plus an
 * optional base segment plus 8 hex from a secure random.
 */
export function mintBranchName(segment: string | null = null): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return composeWorktreeBranch(
    segment,
    Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
  );
}

/**
 * The sanitised `<base>` segment — the renderer-side twin of core's
 * `baseBranchSegment`. Keep the two in lockstep.
 */
export function baseBranchSegment(
  baseBranch: string | null,
  baseRef: string | null,
): string | null {
  const raw = (baseBranch ?? "").trim() !== "" ? baseBranch!.trim() : (baseRef ?? "").trim();
  if (raw === "") return null;
  const segments = raw
    .split("/")
    .map((s) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32))
    .filter((s) => s !== "");
  return segments.length === 0 ? null : segments.join("/").slice(0, 64);
}

/**
 * Follows the base while the name is still a mint — the renderer-side twin
 * of core's `remintForBase` (issue #405). Every surface applies it in its
 * base setters so the chip, the hint, the tooltip, and the sent payload can
 * never disagree about the branch name.
 */
export function remintForBase(branch: string, segment: string | null): string {
  if (!PLACEHOLDER_BRANCH_RE.test(branch)) return branch;
  return composeWorktreeBranch(segment, branch.slice(branch.lastIndexOf("/") + 1));
}

/**
 * The branch and base fields of a worktree session (issues #224, #225),
 * shared by the sidebar's new-worktree dialog, the composer's branch chip
 * (issue #227), and plan review (issue #313): the branch is cut from the
 * base and checked out under the app's worktrees root, so the project's own
 * working tree is never touched. The base defaults to the checkout's current
 * branch once known and follows the select until the user picks one by hand.
 * The select's trailing *new branch…* option (issue #405) creates the base
 * inside the same create operation; a surface that passes no
 * `onBaseBranchChange` renders the existing-refs select verbatim. Ids are
 * prefixed by the caller so the three surfaces can live in one document.
 */
export function WorktreeBranchFields({
  projectCwd,
  instanceId = null,
  branch,
  onBranchChange,
  baseRef,
  onBaseRefChange,
  idPrefix,
  baseTouched,
  onBaseTouchedChange,
  showBase,
  baseBranch,
  onBaseBranchChange,
}: {
  projectCwd: string;
  /** The remote instance owning the checkout (issue #416); null for this host. */
  instanceId?: string | null;
  branch: string;
  onBranchChange: (value: string) => void;
  /** null = cut from the checkout's HEAD (the "current HEAD" option). */
  baseRef: string | null;
  onBaseRefChange: (value: string | null) => void;
  idPrefix: string;
  /**
   * The manual-base latch, controlled (issue #227): the composer's popover
   * unmounts the fields on close, so the latch is lifted state there.
   * undefined = uncontrolled, the internal latch the sidebar dialog uses.
   */
  baseTouched?: boolean;
  onBaseTouchedChange?: (touched: boolean) => void;
  /** false renders the branch field only — nothing is cut from a base. */
  showBase?: boolean;
  /**
   * The new base branch to create (issue #405): null = cut from `baseRef`;
   * "" = *new branch…* toggled on, name not typed yet; non-empty = create
   * that branch from `baseRef` and cut the session branch from it.
   */
  baseBranch?: string | null;
  onBaseBranchChange?: (value: string | null) => void;
}) {
  const t = useT();
  // The base defaults to the checkout's current branch once known; a manual
  // pick must survive later refreshes of the branch list.
  // The manual-base latch. Uncontrolled (the sidebar dialog) it lives here;
  // controlled (the composer's popover) it is lifted state, because the
  // popover unmounts these fields when it closes.
  const [internalTouched, setInternalTouched] = useState(false);
  const touched = baseTouched === undefined ? internalTouched : baseTouched;
  const markTouched = (): void => {
    if (touched) return;
    setInternalTouched(true);
    onBaseTouchedChange?.(true);
  };

  const info = useStore((s) => s.branches[projectKey(instanceId, projectCwd)]);
  const refreshBranches = useStore((s) => s.refreshBranches);

  // Populate the base list once on mount; the store dedupes concurrent
  // refreshes, so a warm project is cheap.
  useEffect(() => {
    void refreshBranches(projectCwd, undefined, instanceId);
  }, [projectCwd, instanceId, refreshBranches]);

  useEffect(() => {
    if (touched) return;
    if (info === undefined) return;
    // Default to the checkout's current branch; when the list is empty or
    // the checkout detaches, the only base is HEAD itself — the state must
    // follow the select so a stale non-null baseRef is never submitted.
    const next =
      info.branches.length > 0 && info.current !== null
        ? (info.current ?? info.defaultBranch)
        : null;
    if (next !== baseRef) onBaseRefChange(next);
  }, [info, baseRef, onBaseRefChange, touched]);

  // No local branches, or a detached HEAD: nothing to cut from but the
  // checkout's HEAD itself.
  const branchNames = info?.branches ?? [];
  const headOnly = branchNames.length === 0 || info?.current === null;
  const creatingBase = (baseBranch ?? null) !== null;
  // The sentinel lives only in the top select's value space; `__new__` is a
  // legal refname, so the option rows never carry it.
  const baseOptions = branchNames.filter((name) => name !== NEW_BRANCH_SENTINEL);
  const optionRows = headOnly ? (
    <option value="">{t("worktree.field.currentHead")}</option>
  ) : (
    baseOptions.map((name) => (
      <option key={name} value={name}>
        {name}
      </option>
    ))
  );

  // A prefill must land selected: the reveal autofocus puts the caret at the
  // end, and typing would otherwise append to the suggestion. Only the reveal
  // transition runs this (dep on the boolean), so it never disturbs a selection
  // mid-typing; surfaces that reveal an empty field select nothing.
  useEffect(() => {
    if (!creatingBase) return;
    const el = document.activeElement as HTMLInputElement | null;
    if (el?.id === `${idPrefix}-new-base` && el.value !== "") el.select();
  }, [creatingBase, idPrefix]);

  return (
    <>
      <div>
        <label htmlFor={`${idPrefix}-branch`} className="block text-[10px] text-ink-faint">
          {t("worktree.field.branch")}
        </label>
        <input
          id={`${idPrefix}-branch`}
          value={branch}
          onChange={(event) => onBranchChange(event.target.value)}
          className="mt-1.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
        />
      </div>
      {showBase !== false && (
        <div>
          <label htmlFor={`${idPrefix}-base`} className="block text-[10px] text-ink-faint">
            {t("worktree.field.base")}
          </label>
          <select
            id={`${idPrefix}-base`}
            value={creatingBase ? NEW_BRANCH_SENTINEL : (baseRef ?? "")}
            onChange={(event) => {
              const value = event.target.value;
              // Lift the latch before any change: the default-base effect
              // must not rewrite baseRef under the new *cut from* select.
              markTouched();
              if (value === NEW_BRANCH_SENTINEL) {
                // baseRef keeps its value and becomes the new base's start.
                onBaseBranchChange?.("");
                return;
              }
              onBaseBranchChange?.(null);
              onBaseRefChange(value === "" ? null : value);
            }}
            className="mt-1.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-line-strong"
          >
            {optionRows}
            {onBaseBranchChange !== undefined && (
              <option value={NEW_BRANCH_SENTINEL}>{t("worktree.field.newBaseOption")}</option>
            )}
          </select>
          {creatingBase && (
            <div className="mt-1.5 space-y-2">
              <div>
                <label htmlFor={`${idPrefix}-new-base`} className="block text-[10px] text-ink-faint">
                  {t("worktree.field.newBaseName")}
                </label>
                <input
                  id={`${idPrefix}-new-base`}
                  autoFocus
                  spellCheck={false}
                  value={baseBranch ?? ""}
                  onChange={(event) => onBaseBranchChange?.(event.target.value)}
                  className="mt-1.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink outline-none placeholder:text-ink-faint focus:border-line-strong"
                />
              </div>
              <div>
                <label htmlFor={`${idPrefix}-new-base-from`} className="block text-[10px] text-ink-faint">
                  {t("worktree.field.newBaseFrom")}
                </label>
                <select
                  id={`${idPrefix}-new-base-from`}
                  value={baseRef ?? ""}
                  onChange={(event) => {
                    markTouched();
                    onBaseRefChange(event.target.value === "" ? null : event.target.value);
                  }}
                  className="mt-1.5 w-full rounded-md border border-line bg-void px-2 py-1.5 font-mono text-[11px] text-ink outline-none focus:border-line-strong"
                >
                  {optionRows}
                </select>
                <p className="mt-1 text-[10px] leading-snug text-ink-faint">
                  {t("worktree.field.newBaseHint", {
                    name: (baseBranch ?? "").trim() || "…",
                    from: baseRef ?? t("worktree.field.currentHead"),
                  })}
                </p>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  );
}
