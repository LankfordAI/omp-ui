// Git branch domain (decomposed for #295): per-project branch listings and
// activity, git checkout/pull, worktree merge-back, and branch naming.
//
// Every map is keyed by projectKey(instanceId, projectCwd) (issue #416): the
// same absolute path registered locally and on a joined remote instance is
// two different repositories, and each call reaches its owner's backend.
import type {
  BranchList,
  BranchListOptions,
  MergeBackResult,
  MergeBackStatus,
  MergeDestination,
} from "@omp-ui/core/types";
import { backendFor } from "../../backend";
import { projectKey } from "../../lib/project-key";
import type { GetState, SetState } from "./shared";
import type { BranchActivity } from "../types";

export interface BranchesSlice {
  branches: Record<string, BranchList>;
  branchActivity: Record<string, BranchActivity>;
  branchDiffRevision: Record<string, number>;
  refreshBranches(
    projectCwd: string,
    opts?: BranchListOptions,
    instanceId?: string | null,
  ): Promise<void>;
  checkoutGitBranch(
    projectCwd: string,
    name: string,
    opts?: { create?: boolean },
    instanceId?: string | null,
  ): Promise<string | null>;
  pullGitBranch(projectCwd: string, instanceId?: string | null): Promise<string | null>;
  resolveMergeDestination(
    projectCwd: string,
    base: string | null,
    instanceId?: string | null,
  ): Promise<MergeDestination>;
  readMergeBackStatus(
    projectCwd: string,
    branch: string,
    destination: string,
    worktreePath: string | null,
    instanceId?: string | null,
  ): Promise<MergeBackStatus>;
  createBranch(
    projectCwd: string,
    name: string,
    startPoint: string,
    instanceId?: string | null,
  ): Promise<void>;
  mergeWorktreeBranch(
    projectCwd: string,
    branch: string,
    destination: string,
    instanceId?: string | null,
  ): Promise<MergeBackResult>;
  suggestBranchName(
    projectCwd: string,
    planContext: string,
    instanceId?: string | null,
  ): Promise<string | null>;
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
    key: string,
    patch: Partial<BranchActivity>,
  ): void => {
    set((s) => {
      const current = s.branchActivity[key];
      return {
        branchActivity: {
          ...s.branchActivity,
          [key]: {
            refreshing: patch.refreshing ?? current?.refreshing ?? false,
            pulling: patch.pulling ?? current?.pulling ?? false,
          },
        },
      };
    });
  };

  const refreshBranches = async (
    projectCwd: string,
    opts?: BranchListOptions,
    instanceId: string | null = null,
  ): Promise<void> => {
    const key = projectKey(instanceId, projectCwd);
    const fetchUpstream = opts?.fetchUpstream === true;
    const active = branchRefreshes.get(key);
    if (active !== undefined) {
      if (fetchUpstream && !active.state.fetchUpstream)
        active.state.pendingNetwork = true;
      return active.promise;
    }

    patchBranchActivity(key, { refreshing: true });
    const state = { fetchUpstream, pendingNetwork: false };
    let nextOptions = opts;
    const promise = Promise.resolve().then(async () => {
      try {
        while (true) {
          try {
            const list = await backendFor(instanceId).listBranches(projectCwd, nextOptions);
            set((s) => ({ branches: { ...s.branches, [key]: list } }));
          } catch {
            // Keep the last known snapshot when listing fails.
          }

          if (!state.pendingNetwork) return;
          state.pendingNetwork = false;
          state.fetchUpstream = true;
          nextOptions = { fetchUpstream: true };
        }
      } finally {
        branchRefreshes.delete(key);
        patchBranchActivity(key, { refreshing: false });
      }
    });
    branchRefreshes.set(key, { state, promise });
    return promise;
  };

  const checkoutGitBranch = async (
    projectCwd: string,
    name: string,
    opts?: { create?: boolean },
    instanceId: string | null = null,
  ): Promise<string | null> => {
    try {
      await backendFor(instanceId).checkoutBranch(projectCwd, name, opts);
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    await get().refreshBranches(projectCwd, { fetchUpstream: false }, instanceId);
    return null;
  };

  const pullGitBranch = async (
    projectCwd: string,
    instanceId: string | null = null,
  ): Promise<string | null> => {
    const key = projectKey(instanceId, projectCwd);
    if (get().branchActivity[key]?.pulling === true) return null;

    patchBranchActivity(key, { pulling: true });
    let pulled = false;
    try {
      await backendFor(instanceId).pullBranch(projectCwd);
      pulled = true;
      await get().refreshBranches(projectCwd, { fetchUpstream: false }, instanceId);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    } finally {
      if (pulled) {
        set((s) => ({
          branchDiffRevision: {
            ...s.branchDiffRevision,
            [key]: (s.branchDiffRevision[key] ?? 0) + 1,
          },
        }));
      }
      patchBranchActivity(key, { pulling: false });
    }
  };

  const resolveMergeDestination = async (
    projectCwd: string,
    base: string | null,
    instanceId: string | null = null,
  ): Promise<MergeDestination> => {
    return backendFor(instanceId).resolveMergeDestination(projectCwd, base);
  };

  const readMergeBackStatus = async (
    projectCwd: string,
    branch: string,
    destination: string,
    worktreePath: string | null,
    instanceId: string | null = null,
  ): Promise<MergeBackStatus> => {
    return backendFor(instanceId).getMergeBackStatus(
      projectCwd,
      branch,
      destination,
      worktreePath,
    );
  };

  // Throws — git's stderr is the validation, same stance as checkoutBranch;
  // the finish dialog renders the message inline rather than via reportError.
  const createBranch = async (
    projectCwd: string,
    name: string,
    startPoint: string,
    instanceId: string | null = null,
  ): Promise<void> => {
    await backendFor(instanceId).createBranch(projectCwd, name, startPoint);
    await get().refreshBranches(projectCwd, { fetchUpstream: false }, instanceId);
  };

  const mergeWorktreeBranch = async (
    projectCwd: string,
    branch: string,
    destination: string,
    instanceId: string | null = null,
  ): Promise<MergeBackResult> => {
    const result = await backendFor(instanceId).mergeWorktreeBranch(
      projectCwd,
      branch,
      destination,
    );
    if (result.kind === "merged") {
      await get().refreshBranches(projectCwd, { fetchUpstream: false }, instanceId);
    }
    return result;
  };

  const suggestBranchName = async (
    projectCwd: string,
    planContext: string,
    instanceId: string | null = null,
  ): Promise<string | null> => {
    // Best-effort like titling: never throw into the review modal.
    return backendFor(instanceId)
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
    resolveMergeDestination,
    readMergeBackStatus,
    createBranch,
    mergeWorktreeBranch,
    suggestBranchName,
  };
}
