import * as path from "node:path";
import type { OwnedSessionRecord, SessionWorktree, WorktreeReleaseResult } from "./types";
import {
  isWithin,
  removeWorktree,
  removeWorktreeBranch,
  resolveMergeDestination,
  worktreeProjectDir,
} from "./worktree";

export interface WorktreeCheckoutDescriptor {
  projectCwd: string;
  worktree: SessionWorktree;
  /** Release asked to keep the branch (issue #386). Default false. */
  keepBranch?: boolean;
  /** Destination the caller just merged into; an extra ancestry candidate (issue #385). */
  mergedInto?: string | null;
}

export interface ReclaimCheckoutsOptions {
  worktreesRoot: string;
  /** Records that still own checkouts after the mutation which triggered reclamation. */
  survivingSessions: readonly Pick<OwnedSessionRecord, "worktree">[];
  warn?: (message: string, error?: unknown) => void;
}

export interface ReclaimedCheckout extends WorktreeCheckoutDescriptor {
  checkoutKept: WorktreeReleaseResult["checkoutKept"];
  branchOutcome: WorktreeReleaseResult["branchOutcome"];
}

/**
 * Reclaims each distinct checkout when no surviving session still owns it.
 * The explicit survivor snapshot keeps cascade cleanup independent of deletion
 * order: callers settle record removals first, then pass the records that won.
 */
export async function reclaimCheckouts(
  checkouts: readonly WorktreeCheckoutDescriptor[],
  opts: ReclaimCheckoutsOptions,
): Promise<ReclaimedCheckout[]> {
  const warn =
    opts.warn ??
    ((message: string, error?: unknown) =>
      error === undefined ? console.warn(message) : console.warn(message, error));
  const distinct = new Map<string, WorktreeCheckoutDescriptor>();
  for (const checkout of checkouts) {
    if (!distinct.has(checkout.worktree.path)) distinct.set(checkout.worktree.path, checkout);
  }

  const reclaimed: ReclaimedCheckout[] = [];
  for (const { projectCwd, worktree, keepBranch, mergedInto } of distinct.values()) {
    const result = (
      checkoutKept: ReclaimedCheckout["checkoutKept"],
      branchOutcome: ReclaimedCheckout["branchOutcome"],
    ): ReclaimedCheckout => ({ projectCwd, worktree, checkoutKept, branchOutcome });
    // Canonicality keys on the project slot directory, not the branch name
    // (issue #386): a renamed branch stays in the slot its path was minted
    // into, while a corrupt or foreign path still refuses reclaim.
    const canonical =
      isWithin(opts.worktreesRoot, worktree.path) &&
      path.dirname(path.resolve(worktree.path)) ===
        path.resolve(worktreeProjectDir(opts.worktreesRoot, projectCwd));
    if (!canonical) {
      warn(
        `[sessions] worktree path ${worktree.path} does not match its minted location — leaving it for manual removal`,
      );
      reclaimed.push(result("non-canonical", "not-attempted"));
      continue;
    }
    if (opts.survivingSessions.some((session) => session.worktree?.path === worktree.path)) {
      reclaimed.push(result("shared", "not-attempted"));
      continue;
    }
    try {
      await removeWorktree(projectCwd, worktree.path);
    } catch (error) {
      warn(`[sessions] worktree cleanup failed for ${worktree.path}:`, error);
      reclaimed.push(result("failed", "not-attempted"));
      continue;
    }
    if (keepBranch) {
      // Issue #386: the caller asked; the branch survives without a git call.
      reclaimed.push(result(null, "kept-requested"));
      continue;
    }
    try {
      const { destination } = await resolveMergeDestination(projectCwd, worktree.base);
      const candidates = [mergedInto ?? null, destination].filter(
        (candidate): candidate is string => candidate !== null,
      );
      const outcome = await removeWorktreeBranch(
        projectCwd,
        worktree.branch,
        [...new Set(candidates)],
      );
      if (outcome.kind !== "removed" && outcome.kind !== "already-gone") {
        warn(
          `[sessions] worktree branch ${worktree.branch} kept (${outcome.kind}${outcome.detail ? `: ${outcome.detail}` : ""})`,
        );
      }
      reclaimed.push(result(null, outcome.kind));
    } catch (error) {
      warn(`[sessions] worktree branch cleanup failed for ${worktree.branch}:`, error);
      reclaimed.push(result(null, "not-attempted"));
    }
  }
  return reclaimed;
}
