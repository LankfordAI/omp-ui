import {
  addWorktree,
  addWorktreeForBranch,
  addWorktreeFromNewBase,
  checkoutBranch,
  finalizeMintBranch,
  mintWorktreePath,
  readWorktreeDirty,
  reclaimCheckouts,
  renameWorktreeBranch,
  syncWorktree,
  type Registry,
  type SessionWorktree,
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
