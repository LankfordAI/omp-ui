import type { OwnedSessionRecord, SessionWorktree, WorktreeReleaseResult } from "./types";
import {
  isWithin,
  mintWorktreePath,
  removeWorktree,
  removeWorktreeBranch,
} from "./worktree";

export interface WorktreeCheckoutDescriptor {
  projectCwd: string;
  worktree: SessionWorktree;
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
  for (const { projectCwd, worktree } of distinct.values()) {
    const result = (
      checkoutKept: ReclaimedCheckout["checkoutKept"],
      branchOutcome: ReclaimedCheckout["branchOutcome"],
    ): ReclaimedCheckout => ({ projectCwd, worktree, checkoutKept, branchOutcome });
    const canonical =
      worktree.path === mintWorktreePath(opts.worktreesRoot, projectCwd, worktree.branch) &&
      isWithin(opts.worktreesRoot, worktree.path);
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
    try {
      const outcome = await removeWorktreeBranch(projectCwd, worktree.branch, worktree.base);
      if (outcome.kind !== "removed") {
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
