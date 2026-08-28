// Git branch domain (decomposed for #295): per-project branch listings and
// activity, git checkout/pull, worktree merge-back, and branch naming.
import type {
  BranchList,
  BranchListOptions,
  MergeBackResult,
  MergeBackStatus,
} from "@omp-ui/core/types";
import { backend } from "../../backend";
import type { GetState, SetState } from "./shared";
import type { BranchActivity } from "../types";

export interface BranchesSlice {
  branches: Record<string, BranchList>;
  branchActivity: Record<string, BranchActivity>;
  branchDiffRevision: Record<string, number>;
  refreshBranches(projectCwd: string, opts?: BranchListOptions): Promise<void>;
  checkoutGitBranch(
    projectCwd: string,
    name: string,
    opts?: { create?: boolean },
  ): Promise<string | null>;
  pullGitBranch(projectCwd: string): Promise<string | null>;
  readMergeBackStatus(
    projectCwd: string,
    branch: string,
    base: string | null,
  ): Promise<MergeBackStatus>;
  mergeWorktreeBranch(
    projectCwd: string,
    branch: string,
    destination: string,
  ): Promise<MergeBackResult>;
  suggestBranchName(projectCwd: string, planContext: string): Promise<string | null>;
}

interface BranchRefreshRuntime {
  state: {
    fetchUpstream: boolean;
    pendingNetwork: boolean;
  };
  promise: Promise<void>;
}

const branchRefreshes = new Map<string, BranchRefreshRuntime>();

export function createBranchesSlice(set: SetState, get: GetState): BranchesSlice {
  const patchBranchActivity = (
    projectCwd: string,
    patch: Partial<BranchActivity>,
  ): void => {
    set((s) => {
      const current = s.branchActivity[projectCwd];
      return {
        branchActivity: {
          ...s.branchActivity,
          [projectCwd]: {
            refreshing: patch.refreshing ?? current?.refreshing ?? false,
            pulling: patch.pulling ?? current?.pulling ?? false,
          },
        },
      };
    });
  };

  const refreshBranches = async (projectCwd: string, opts?: BranchListOptions): Promise<void> => {
    const fetchUpstream = opts?.fetchUpstream === true;
    const active = branchRefreshes.get(projectCwd);
    if (active !== undefined) {
      if (fetchUpstream && !active.state.fetchUpstream)
        active.state.pendingNetwork = true;
      return active.promise;
    }

    patchBranchActivity(projectCwd, { refreshing: true });
    const state = { fetchUpstream, pendingNetwork: false };
    let nextOptions = opts;
    const promise = Promise.resolve().then(async () => {
      try {
        while (true) {
          try {
            const list = await backend.listBranches(projectCwd, nextOptions);
            set((s) => ({ branches: { ...s.branches, [projectCwd]: list } }));
          } catch {
            // Keep the last known snapshot when listing fails.
          }

          if (!state.pendingNetwork) return;
          state.pendingNetwork = false;
          state.fetchUpstream = true;
          nextOptions = { fetchUpstream: true };
        }
      } finally {
        branchRefreshes.delete(projectCwd);
        patchBranchActivity(projectCwd, { refreshing: false });
      }
    });
    branchRefreshes.set(projectCwd, { state, promise });
    return promise;
  };

  const checkoutGitBranch = async (
    projectCwd: string,
    name: string,
    opts?: { create?: boolean },
  ): Promise<string | null> => {
    try {
      await backend.checkoutBranch(projectCwd, name, opts);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    await get().refreshBranches(projectCwd, { fetchUpstream: false });
    return null;
  };

  const pullGitBranch = async (projectCwd: string): Promise<string | null> => {
    if (get().branchActivity[projectCwd]?.pulling === true) return null;

    patchBranchActivity(projectCwd, { pulling: true });
    let pulled = false;
    try {
      await backend.pullBranch(projectCwd);
      pulled = true;
      await get().refreshBranches(projectCwd, { fetchUpstream: false });
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      if (pulled) {
        set((s) => ({
          branchDiffRevision: {
            ...s.branchDiffRevision,
            [projectCwd]: (s.branchDiffRevision[projectCwd] ?? 0) + 1,
          },
        }));
      }
      patchBranchActivity(projectCwd, { pulling: false });
    }
  };

  const readMergeBackStatus = async (
    projectCwd: string,
    branch: string,
    base: string | null,
  ): Promise<MergeBackStatus> => {
    return backend.getMergeBackStatus(projectCwd, branch, base);
  };

  const mergeWorktreeBranch = async (
    projectCwd: string,
    branch: string,
    destination: string,
  ): Promise<MergeBackResult> => {
    const result = await backend.mergeWorktreeBranch(projectCwd, branch, destination);
    if (result.kind === "merged") {
      await get().refreshBranches(projectCwd, { fetchUpstream: false });
    }
    return result;
  };

  const suggestBranchName = async (
    projectCwd: string,
    planContext: string,
  ): Promise<string | null> => {
    // Best-effort like titling: never throw into the review modal.
    return backend
      .suggestBranchName(projectCwd, planContext)
      .catch(() => null);
  };

  return {
    branches: {},
    branchActivity: {},
    branchDiffRevision: {},
    refreshBranches,
    checkoutGitBranch,
    pullGitBranch,
    readMergeBackStatus,
    mergeWorktreeBranch,
    suggestBranchName,
  };
}
