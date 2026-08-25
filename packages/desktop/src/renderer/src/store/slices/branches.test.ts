import { describe, expect, it } from "vitest";
import type {
  BranchList,
  MergeBackResult,
  MergeBackStatus,
} from "@omp-ui/core/types";
import { rpcTabState } from "../../test/fixtures";
import { h } from "../../test/store-harness";

describe("branch switching (issue #35)", () => {
  it("checkoutGitBranch success refreshes the shared listing and returns null", async () => {
    const fixture: BranchList = {
      repoRoot: "/p",
      current: "feature/x",
      branches: ["main", "feature/x"],
      defaultBranch: "main",
      upstreamRef: null,
      upstreamRemote: null,
      hasUpstream: false,
      ahead: 0,
      behind: 0,
      upstreamFetchedAt: null,
      upstreamRefreshError: null,
    };
    h.mockBackend.checkoutBranch.mockResolvedValueOnce(undefined);
    h.mockBackend.listBranches.mockResolvedValueOnce(fixture);
    h.useStore.setState({ branches: {} });

    const err = await h.useStore.getState().checkoutGitBranch("/p", "feature/x");
    expect(err).toBeNull();
    expect(h.mockBackend.checkoutBranch).toHaveBeenCalledWith(
      "/p",
      "feature/x",
      undefined,
    );
    expect(h.useStore.getState().branches["/p"]).toEqual(fixture);
  });

  it("checkoutGitBranch rejection returns git's message and keeps the last listing", async () => {
    const existing: BranchList = {
      repoRoot: "/p",
      current: "main",
      branches: ["main"],
      defaultBranch: "main",
      upstreamRef: null,
      upstreamRemote: null,
      hasUpstream: false,
      ahead: 0,
      behind: 0,
      upstreamFetchedAt: null,
      upstreamRefreshError: null,
    };
    h.mockBackend.checkoutBranch.mockRejectedValueOnce(
      new Error("error: would be overwritten"),
    );
    h.useStore.setState({ branches: { "/p": existing } });

    const err = await h.useStore.getState().checkoutGitBranch("/p", "other");
    expect(err).toBe("error: would be overwritten");
    expect(h.useStore.getState().branches["/p"]).toEqual(existing);
  });

    it("refreshBranches keeps the previous snapshot until the deferred listing completes", async () => {
    const previous: BranchList = {
      repoRoot: "/p",
      current: "main",
      branches: ["main"],
      defaultBranch: "main",
      upstreamRef: "origin/main",
      upstreamRemote: "origin",
      hasUpstream: true,
      ahead: 0,
      behind: 1,
      upstreamFetchedAt: 10,
      upstreamRefreshError: null,
    };
    const refreshed: BranchList = {
      ...previous,
      branches: ["main", "feature/x"],
      behind: 0,
      upstreamFetchedAt: 20,
    };
    const listing = h.deferred<BranchList>();
    h.mockBackend.listBranches.mockReturnValueOnce(listing.promise);
    h.useStore.setState({
      branches: { "/p": previous },
      branchActivity: {},
      branchDiffRevision: {},
    });

    const refresh = h.useStore
      .getState()
      .refreshBranches("/p", { fetchUpstream: false });
    await h.flushMicrotasks();

    expect(h.mockBackend.listBranches).toHaveBeenCalledWith("/p", {
      fetchUpstream: false,
    });
    expect(h.useStore.getState().branches["/p"]).toEqual(previous);
    expect(h.useStore.getState().branchActivity["/p"]).toEqual({
      refreshing: true,
      pulling: false,
    });

    listing.resolve(refreshed);
    await refresh;

    expect(h.useStore.getState().branches["/p"]).toEqual(refreshed);
    expect(h.useStore.getState().branchActivity["/p"]).toEqual({
      refreshing: false,
      pulling: false,
    });
  });

  it("queues one network refresh behind an in-flight local-only refresh", async () => {
    const previous: BranchList = {
      repoRoot: "/p",
      current: "main",
      branches: ["main"],
      defaultBranch: "main",
      upstreamRef: "origin/main",
      upstreamRemote: "origin",
      hasUpstream: true,
      ahead: 0,
      behind: 1,
      upstreamFetchedAt: 10,
      upstreamRefreshError: null,
    };
    const localSnapshot = { ...previous, branches: ["main", "local"] };
    const networkSnapshot = {
      ...localSnapshot,
      behind: 0,
      upstreamFetchedAt: 20,
    };
    const localListing = h.deferred<BranchList>();
    h.mockBackend.listBranches
      .mockReturnValueOnce(localListing.promise)
      .mockResolvedValueOnce(networkSnapshot);
    h.useStore.setState({
      branches: { "/p": previous },
      branchActivity: {},
      branchDiffRevision: {},
    });

    const localRefresh = h.useStore
      .getState()
      .refreshBranches("/p", { fetchUpstream: false });
    const networkRefresh = h.useStore
      .getState()
      .refreshBranches("/p", { fetchUpstream: true });
    await h.flushMicrotasks();

    expect(h.mockBackend.listBranches.mock.calls).toEqual([
      ["/p", { fetchUpstream: false }],
    ]);
    expect(h.useStore.getState().branches["/p"]).toEqual(previous);

    localListing.resolve(localSnapshot);
    await Promise.all([localRefresh, networkRefresh]);

    expect(h.mockBackend.listBranches.mock.calls).toEqual([
      ["/p", { fetchUpstream: false }],
      ["/p", { fetchUpstream: true }],
    ]);
    expect(h.useStore.getState().branches["/p"]).toEqual(networkSnapshot);
    expect(h.useStore.getState().branchActivity["/p"]?.refreshing).toBe(false);
  });

  it("coalesces duplicate in-flight network refreshes", async () => {
    const snapshot: BranchList = {
      repoRoot: "/p",
      current: "main",
      branches: ["main"],
      defaultBranch: "main",
      upstreamRef: "origin/main",
      upstreamRemote: "origin",
      hasUpstream: true,
      ahead: 0,
      behind: 0,
      upstreamFetchedAt: 20,
      upstreamRefreshError: null,
    };
    const listing = h.deferred<BranchList>();
    h.mockBackend.listBranches.mockReturnValueOnce(listing.promise);
    h.useStore.setState({
      branches: {},
      branchActivity: {},
      branchDiffRevision: {},
    });

    const first = h.useStore
      .getState()
      .refreshBranches("/p", { fetchUpstream: true });
    const duplicate = h.useStore
      .getState()
      .refreshBranches("/p", { fetchUpstream: true });
    await h.flushMicrotasks();

    expect(h.mockBackend.listBranches.mock.calls).toEqual([
      ["/p", { fetchUpstream: true }],
    ]);

    listing.resolve(snapshot);
    await Promise.all([first, duplicate]);

    expect(h.mockBackend.listBranches).toHaveBeenCalledTimes(1);
    expect(h.useStore.getState().branches["/p"]).toEqual(snapshot);
    expect(h.useStore.getState().branchActivity["/p"]?.refreshing).toBe(false);
  });

  it("pullGitBranch failure preserves the snapshot and diff revision and clears activity", async () => {
    const previous: BranchList = {
      repoRoot: "/p",
      current: "main",
      branches: ["main"],
      defaultBranch: "main",
      upstreamRef: "origin/main",
      upstreamRemote: "origin",
      hasUpstream: true,
      ahead: 0,
      behind: 1,
      upstreamFetchedAt: 10,
      upstreamRefreshError: null,
    };
    h.mockBackend.pullBranch.mockRejectedValueOnce(
      new Error("network unavailable"),
    );
    h.useStore.setState({
      branches: { "/p": previous },
      branchActivity: {},
      branchDiffRevision: { "/p": 4, "/other": 9 },
    });

    const pull = h.useStore.getState().pullGitBranch("/p");
    expect(h.useStore.getState().branchActivity["/p"]).toEqual({
      refreshing: false,
      pulling: true,
    });

    await expect(pull).resolves.toBe("network unavailable");

    expect(h.mockBackend.pullBranch).toHaveBeenCalledWith("/p");
    expect(h.mockBackend.listBranches).not.toHaveBeenCalled();
    expect(h.useStore.getState().branches["/p"]).toEqual(previous);
    expect(h.useStore.getState().branchDiffRevision).toEqual({
      "/p": 4,
      "/other": 9,
    });
    expect(h.useStore.getState().branchActivity["/p"]).toEqual({
      refreshing: false,
      pulling: false,
    });
  });

  it("pullGitBranch coalesces pulls, locally refreshes, and increments only its revision once", async () => {
    const previous: BranchList = {
      repoRoot: "/p",
      current: "main",
      branches: ["main"],
      defaultBranch: "main",
      upstreamRef: "origin/main",
      upstreamRemote: "origin",
      hasUpstream: true,
      ahead: 0,
      behind: 1,
      upstreamFetchedAt: 10,
      upstreamRefreshError: null,
    };
    const pulling = h.deferred<void>();
    h.mockBackend.pullBranch.mockReturnValueOnce(pulling.promise);
    h.mockBackend.listBranches.mockRejectedValueOnce(new Error("refresh failed"));
    h.useStore.setState({
      branches: { "/p": previous },
      branchActivity: {},
      branchDiffRevision: { "/p": 4, "/other": 9 },
    });

    const first = h.useStore.getState().pullGitBranch("/p");
    const duplicate = h.useStore.getState().pullGitBranch("/p");

    expect(h.mockBackend.pullBranch.mock.calls).toEqual([["/p"]]);
    await expect(duplicate).resolves.toBeNull();

    pulling.resolve(undefined);
    await expect(first).resolves.toBeNull();

    expect(h.mockBackend.pullBranch).toHaveBeenCalledTimes(1);
    expect(h.mockBackend.listBranches.mock.calls).toEqual([
      ["/p", { fetchUpstream: false }],
    ]);
    expect(h.useStore.getState().branches["/p"]).toEqual(previous);
    expect(h.useStore.getState().branchDiffRevision).toEqual({
      "/p": 5,
      "/other": 9,
    });
    expect(h.useStore.getState().branchActivity["/p"]).toEqual({
      refreshing: false,
      pulling: false,
    });
  });
});

describe("merge-back (issue #272)", () => {
  const BR = "omp-ui/abcd1234";
  const ff: MergeBackResult = { kind: "ff", destination: "main", commits: 2, files: [] };
  const merged: MergeBackResult = {
    kind: "merged",
    destination: "main",
    commits: 3,
    files: [],
  };
  const alreadyMerged: MergeBackResult = {
    kind: "already-merged",
    destination: "main",
    commits: 0,
    files: [],
  };
  const conflicts: MergeBackResult = {
    kind: "conflicts",
    destination: "main",
    commits: 1,
    files: ["src/a.ts", "src/b.ts"],
  };
  const listing: BranchList = {
    repoRoot: "/p",
    current: "main",
    branches: ["main", BR],
    defaultBranch: "main",
    upstreamRef: null,
    upstreamRemote: null,
    hasUpstream: false,
    ahead: 0,
    behind: 0,
    upstreamFetchedAt: null,
    upstreamRefreshError: null,
  };

  it("ff: calls the backend, locally refreshes the listing, and returns the result", async () => {
    h.mockBackend.mergeWorktreeBranch.mockResolvedValueOnce(ff);
    h.mockBackend.listBranches.mockResolvedValueOnce(listing);
    h.useStore.setState({ branches: {}, branchActivity: {} });

    const result = await h.useStore.getState().mergeWorktreeBranch("/p", BR, "main");

    expect(result).toEqual(ff);
    expect(h.mockBackend.mergeWorktreeBranch).toHaveBeenCalledWith("/p", BR, "main");
    expect(h.mockBackend.listBranches).toHaveBeenCalledWith("/p", {
      fetchUpstream: false,
    });
    expect(h.useStore.getState().branches["/p"]).toEqual(listing);
    expect(h.useStore.getState().branchActivity["/p"]).toEqual({
      refreshing: false,
      pulling: false,
    });
  });

  it("merged: refreshes locally without fetching upstream", async () => {
    h.mockBackend.mergeWorktreeBranch.mockResolvedValueOnce(merged);
    h.mockBackend.listBranches.mockResolvedValueOnce(listing);
    h.useStore.setState({ branches: {}, branchActivity: {} });

    const result = await h.useStore.getState().mergeWorktreeBranch("/p", BR, "main");

    expect(result).toEqual(merged);
    expect(h.mockBackend.listBranches).toHaveBeenCalledTimes(1);
    expect(h.mockBackend.listBranches).toHaveBeenCalledWith("/p", {
      fetchUpstream: false,
    });
    expect(h.useStore.getState().branches["/p"]).toEqual(listing);
  });

  it("conflicts: keeps the result, leaves the listing untouched", async () => {
    h.mockBackend.mergeWorktreeBranch.mockResolvedValueOnce(conflicts);
    h.useStore.setState({ branches: { "/p": listing }, branchActivity: {} });

    const result = await h.useStore.getState().mergeWorktreeBranch("/p", BR, "main");

    expect(result).toEqual(conflicts);
    expect(h.mockBackend.listBranches).not.toHaveBeenCalled();
    expect(h.useStore.getState().branches["/p"]).toEqual(listing);
    expect(h.useStore.getState().branchActivity["/p"]).toBeUndefined();
  });

  it("already-merged: no refresh", async () => {
    h.mockBackend.mergeWorktreeBranch.mockResolvedValueOnce(alreadyMerged);
    h.useStore.setState({ branches: {}, branchActivity: {} });

    const result = await h.useStore.getState().mergeWorktreeBranch("/p", BR, "main");

    expect(result).toEqual(alreadyMerged);
    expect(h.mockBackend.listBranches).not.toHaveBeenCalled();
  });

  it("propagates git's rejection and does not refresh", async () => {
    h.mockBackend.mergeWorktreeBranch.mockRejectedValueOnce(
      new Error("error: refusing to merge into a branch that is not checked out"),
    );
    h.useStore.setState({ branches: {}, branchActivity: {} });

    await expect(
      h.useStore.getState().mergeWorktreeBranch("/p", BR, "main"),
    ).rejects.toThrow("error: refusing to merge");
    expect(h.mockBackend.listBranches).not.toHaveBeenCalled();
  });

  it("readMergeBackStatus passes through to the backend with exact args", async () => {
    const status: MergeBackStatus = {
      destination: "main",
      reason: null,
      destinationCheckedOut: true,
      branchExists: true,
      mergeInProgress: false,
      alreadyMerged: false,
      ahead: 3,
    };
    h.mockBackend.getMergeBackStatus.mockResolvedValueOnce(status);

    await expect(
      h.useStore.getState().readMergeBackStatus("/p", BR, "main"),
    ).resolves.toBe(status);
    expect(h.mockBackend.getMergeBackStatus).toHaveBeenCalledWith("/p", BR, "main");

    const unresolvable: MergeBackStatus = {
      ...status,
      destination: null,
      reason: "base-gone",
      destinationCheckedOut: false,
    };
    h.mockBackend.getMergeBackStatus.mockResolvedValueOnce(unresolvable);

    // pre-field records pass a null base
    await expect(
      h.useStore.getState().readMergeBackStatus("/p", BR, null),
    ).resolves.toBe(unresolvable);
    expect(h.mockBackend.getMergeBackStatus).toHaveBeenLastCalledWith("/p", BR, null);
  });

  it("appendNotice appends a notice item to a live rpc tab", () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });

    h.useStore
      .getState()
      .appendNotice(h.TAB, `merged ${BR} into main — fast-forward, 2 commits`, "info");
    h.useStore
      .getState()
      .appendNotice(h.TAB, `merge of ${BR} into main stopped — 2 file(s) conflict`, "warn");

    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([
      expect.objectContaining({
        kind: "notice",
        text: `merged ${BR} into main — fast-forward, 2 commits`,
        level: "info",
      }),
      expect.objectContaining({
        kind: "notice",
        text: `merge of ${BR} into main stopped — 2 file(s) conflict`,
        level: "warn",
      }),
    ]);
  });

  it("appendNotice omits a level when none is given", () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });

    h.useStore.getState().appendNotice(h.TAB, `merged ${BR} into main`);

    const item = h.useStore.getState().rpc[h.TAB]!.items.at(-1);
    expect(item).toMatchObject({ kind: "notice", text: `merged ${BR} into main` });
    expect(item?.kind === "notice" ? item.level : undefined).toBeUndefined();
  });

  it("appendNotice no-ops for a tab without rpc state", () => {
    h.useStore.setState({ rpc: {} });

    h.useStore.getState().appendNotice("no-such-tab", "nothing to see", "warn");

    expect(h.useStore.getState().rpc).toEqual({});
  });
});
