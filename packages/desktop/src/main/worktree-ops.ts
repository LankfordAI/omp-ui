import {
  addWorktree,
  addWorktreeForBranch,
  addWorktreeFromNewBase,
  checkoutBranch,
  finalizeMintBranch,
  mintWorktreePath,
  readMergeBackStatus,
  readWorktreeDirty,
  readWorktreeLanding,
  reclaimCheckouts,
  removeWorktreeBranch,
  renameWorktreeBranch,
  resolveMergeDestination,
  syncWorktree,
  type Registry,
  type SessionWorktree,
  type WorktreeBranchRemoval,
  type WorktreeLanding,
  type SpawnRequest,
  type WorktreeCheckoutDescriptor,
  type WorktreeReleaseResult,
  type WorktreeSyncResult,
} from "@omp-ui/core";

export interface WorktreeOpsDependencies {
  registry: Registry;
  getWorktreesRoot: () => string;
}

export class WorktreeOps {
  constructor(private readonly deps: WorktreeOpsDependencies) {}

  async prepareSpawn(
    projectCwd: string,
    request: Exclude<SpawnRequest["worktree"], undefined>,
  ): Promise<{ worktree: SessionWorktree | null; minted: SessionWorktree | null }> {
    if (request === null) return { worktree: null, minted: null };
    if ("reuse" in request) return { worktree: { ...request.reuse }, minted: null };
    if ("checkout" in request) {
      const { branch } = request.checkout;
      const worktreePath = mintWorktreePath(this.deps.getWorktreesRoot(), projectCwd, branch);
      const base = await addWorktreeForBranch(projectCwd, worktreePath, branch);
      const worktree = { path: worktreePath, branch, base };
      return { worktree, minted: worktree };
    }
    const { branch, baseRef, baseBranch } = request.mint;
    const [mintBranch, mintBaseRef] = await finalizeMintBranch(
      projectCwd,
      branch,
      baseBranch,
      baseRef,
    );
    const worktreePath = mintWorktreePath(
      this.deps.getWorktreesRoot(),
      projectCwd,
      mintBranch,
    );
    const base =
      baseBranch === null
        ? await addWorktree(projectCwd, worktreePath, mintBranch, mintBaseRef)
        : await addWorktreeFromNewBase(
            projectCwd,
            worktreePath,
            mintBranch,
            baseBranch,
            mintBaseRef,
          );
    const worktree = { path: worktreePath, branch: mintBranch, base };
    return { worktree, minted: worktree };
  }

  async convert(
    tabId: string,
    projectCwd: string,
    branch: string,
    baseRef: string | null,
    baseBranch: string | null,
  ): Promise<SessionWorktree> {
    const { worktree } = await this.prepareSpawn(projectCwd, {
      mint: { branch, baseRef, baseBranch },
    });
    if (worktree === null) throw new Error("worktree conversion produced no checkout");
    this.deps.registry.updateSession(tabId, { worktree });
    return worktree;
  }

  async assertClean(projectCwd: string, worktree: SessionWorktree): Promise<void> {
    if ((await readWorktreeDirty(projectCwd, worktree.path)) === true) {
      throw new Error(
        "the worktree has uncommitted changes — commit or discard them before returning",
      );
    }
  }

  reclaim(checkouts: ReadonlyArray<WorktreeCheckoutDescriptor>) {
    return reclaimCheckouts(checkouts, {
      worktreesRoot: this.deps.getWorktreesRoot(),
      survivingSessions: this.deps.registry.sessions,
    });
  }

  async reclaimOne(
    projectCwd: string,
    worktree: SessionWorktree,
    extra?: Pick<WorktreeCheckoutDescriptor, "keepBranch" | "mergedInto">,
  ): Promise<Pick<WorktreeReleaseResult, "checkoutKept" | "branchOutcome">> {
    const [result] = await this.reclaim([{ projectCwd, worktree, ...extra }]);
    return result
      ? { checkoutKept: result.checkoutKept, branchOutcome: result.branchOutcome }
      : { checkoutKept: "failed", branchOutcome: "not-attempted" };
  }

  /**
   * The already-landed check behind omp-ui_fleet_finish (issue #978): the
   * destination resolved from the recorded base, the recorded branch in it,
   * the checkout clean, and the checkout's HEAD in it — an agent may have
   * worked on a branch of its own. Reads the HEAD reflog, so it must run
   * before the checkout is removed. A refusal is a user-facing reason.
   */
  async landedFinish(
    projectCwd: string,
    worktree: SessionWorktree,
  ): Promise<{ ok: true; destination: string; landing: WorktreeLanding } | { ok: false; reason: string }> {
    const { destination } = await resolveMergeDestination(projectCwd, worktree.base);
    if (destination === null) {
      return { ok: false, reason: `no local branch matches the worktree's base ${worktree.base ?? "(unrecorded)"}` };
    }
    const status = await readMergeBackStatus(projectCwd, worktree.branch, destination, worktree.path);
    if (!status.destinationExists) return { ok: false, reason: `the base branch ${destination} no longer exists` };
    if (status.worktreeDirty === null) return { ok: false, reason: `the worktree at ${worktree.path} cannot be read` };
    if (status.worktreeDirty) return { ok: false, reason: "the worktree has uncommitted changes" };
    if (status.branchExists && !status.alreadyMerged) {
      return {
        ok: false,
        reason: `${worktree.branch} has ${status.ahead} commit${status.ahead === 1 ? "" : "s"} ${destination} lacks; land the work first`,
      };
    }
    const landing = await readWorktreeLanding(projectCwd, worktree.path, worktree.branch, destination);
    if (!landing.headLanded) {
      return {
        ok: false,
        reason: `the worktree's checked-out ${landing.headBranch ?? "HEAD"} holds commits ${destination} lacks; land the work first`,
      };
    }
    return { ok: true, destination, landing };
  }

  /** Deletes `branch` only when it is fully in `destination` (removeWorktreeBranch's ancestry rule). */
  removeMergedBranch(projectCwd: string, branch: string, destination: string): Promise<WorktreeBranchRemoval> {
    return removeWorktreeBranch(projectCwd, branch, [destination]);
  }

  checkout(projectCwd: string, branch: string): Promise<void> {
    return checkoutBranch(projectCwd, branch);
  }

  sync(projectCwd: string, worktreePath: string, source: string): Promise<WorktreeSyncResult> {
    return syncWorktree(projectCwd, worktreePath, source);
  }

  async rename(tabId: string, worktree: SessionWorktree, newName: string): Promise<void> {
    await renameWorktreeBranch(worktree.path, worktree.branch, newName);
    this.deps.registry.updateSession(tabId, {
      worktree: { ...worktree, branch: newName },
    });
  }
}
