import { describe, expect, it } from "vitest";
import type {
  BranchList,
  MergeBackResult,
  MergeBackStatus,
  PushResult,
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
      // The repo has an origin remote; the current branch simply has no upstream
      // configured (checkout tests never read this field).
      defaultRemote: "origin",
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
      defaultRemote: "origin",
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
      defaultRemote: "origin",
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
      // A local reload — the watcher echo's shape — must never claim upstream
      // work (issue #506): this pair is the regression pin.
      fetching: false,
      pulling: false,
      pushing: false,
    });

    listing.resolve(refreshed);
    await refresh;

    expect(h.useStore.getState().branches["/p"]).toEqual(refreshed);
    expect(h.useStore.getState().branchActivity["/p"]).toEqual({
      refreshing: false,
      fetching: false,
      pulling: false,
      pushing: false,
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
      defaultRemote: "origin",
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
    // The joining network request upgraded the running local refresh, so the
    // upstream claim is honest from the upgrade onward (issue #506).
    expect(h.useStore.getState().branchActivity["/p"]?.fetching).toBe(true);

    localListing.resolve(localSnapshot);
    await Promise.all([localRefresh, networkRefresh]);

    expect(h.mockBackend.listBranches.mock.calls).toEqual([
      ["/p", { fetchUpstream: false }],
      ["/p", { fetchUpstream: true }],
    ]);
    expect(h.useStore.getState().branches["/p"]).toEqual(networkSnapshot);
    expect(h.useStore.getState().branchActivity["/p"]?.refreshing).toBe(false);
    expect(h.useStore.getState().branchActivity["/p"]?.fetching).toBe(false);
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
      defaultRemote: "origin",
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
    // A fetchUpstream:true refresh in flight: the upstream claim is live.
    expect(h.useStore.getState().branchActivity["/p"]?.fetching).toBe(true);

    expect(h.mockBackend.listBranches.mock.calls).toEqual([
      ["/p", { fetchUpstream: true }],
    ]);

    listing.resolve(snapshot);
    await Promise.all([first, duplicate]);

    expect(h.mockBackend.listBranches).toHaveBeenCalledTimes(1);
    expect(h.useStore.getState().branches["/p"]).toEqual(snapshot);
    expect(h.useStore.getState().branchActivity["/p"]?.refreshing).toBe(false);
    expect(h.useStore.getState().branchActivity["/p"]?.fetching).toBe(false);
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
      defaultRemote: "origin",
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
      fetching: false,
      pulling: true,
      // Push is idle here; the flag exists so the two actions can refuse each other.
      pushing: false,
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
      fetching: false,
      pulling: false,
      pushing: false,
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
      defaultRemote: "origin",
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
      fetching: false,
      pulling: false,
      pushing: false,
    });
  });
});

describe("merge-back (issue #272)", () => {
  const BR = "omp-ui/abcd1234";
  const merged: MergeBackResult = {
    kind: "merged",
    destination: "main",
    commits: 3,
    files: [],
    conflictsLeftIn: null,
  };
  const alreadyMerged: MergeBackResult = {
    kind: "already-merged",
    destination: "main",
    commits: 0,
    files: [],
    conflictsLeftIn: null,
  };
  const conflicts: MergeBackResult = {
    kind: "conflicts",
    destination: "main",
    commits: 1,
    files: ["src/a.ts", "src/b.ts"],
    conflictsLeftIn: "project",
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
    // Merge-back is local-only; the repo still has its origin remote.
    defaultRemote: "origin",
  };

  it("merged: calls the backend, locally refreshes the listing, and returns the result", async () => {
    h.mockBackend.mergeWorktreeBranch.mockResolvedValueOnce(merged);
    h.mockBackend.listBranches.mockResolvedValueOnce(listing);
    h.useStore.setState({ branches: {}, branchActivity: {} });

    const result = await h.useStore.getState().mergeWorktreeBranch("/p", BR, "main");

    expect(result).toEqual(merged);
    expect(h.mockBackend.mergeWorktreeBranch).toHaveBeenCalledWith("/p", BR, "main");
    expect(h.mockBackend.listBranches).toHaveBeenCalledTimes(1);
    expect(h.mockBackend.listBranches).toHaveBeenCalledWith("/p", {
      fetchUpstream: false,
    });
    expect(h.useStore.getState().branches["/p"]).toEqual(listing);
    expect(h.useStore.getState().branchActivity["/p"]).toEqual({
      refreshing: false,
      fetching: false,
      pulling: false,
      pushing: false,
    });
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

  it("readMergeBackStatus passes destination and worktree path through to the backend", async () => {
    const status: MergeBackStatus = {
      destination: "main",
      destinationExists: true,
      destinationCheckout: "project",
      branchExists: true,
      mergeInProgress: false,
      alreadyMerged: false,
      ahead: 3,
      behind: 1,
      worktreeDirty: false,
      // The destination's own push facts ride the same snapshot (#414).
      destinationUpstream: "origin/main",
      destinationAhead: 1,
      preview: { kind: "clean" },
    };
    h.mockBackend.getMergeBackStatus.mockResolvedValueOnce(status);

    await expect(
      h.useStore.getState().readMergeBackStatus("/p", BR, "main", "/wt"),
    ).resolves.toBe(status);
    expect(h.mockBackend.getMergeBackStatus).toHaveBeenCalledWith("/p", BR, "main", "/wt");

    // Without a checkout path main cannot probe the worktree's dirtiness and
    // answers null; the destination still echoes back verbatim.
    const untracked: MergeBackStatus = {
      ...status,
      destination: "feature/x",
      destinationCheckout: "none",
      worktreeDirty: null,
    };
    h.mockBackend.getMergeBackStatus.mockResolvedValueOnce(untracked);

    await expect(
      h.useStore.getState().readMergeBackStatus("/p", BR, "feature/x", null),
    ).resolves.toBe(untracked);
    expect(h.mockBackend.getMergeBackStatus).toHaveBeenLastCalledWith(
      "/p",
      BR,
      "feature/x",
      null,
    );
  });

  it("createBranch creates through the backend, then locally refreshes the listing", async () => {
    h.mockBackend.createBranch.mockResolvedValueOnce(undefined);
    h.mockBackend.listBranches.mockResolvedValueOnce(listing);
    h.useStore.setState({ branches: {}, branchActivity: {} });

    await h.useStore.getState().createBranch("/p", "feat/new", BR);

    expect(h.mockBackend.createBranch).toHaveBeenCalledWith("/p", "feat/new", BR);
    expect(h.mockBackend.listBranches).toHaveBeenCalledTimes(1);
    expect(h.mockBackend.listBranches).toHaveBeenCalledWith("/p", {
      fetchUpstream: false,
    });
    expect(h.useStore.getState().branches["/p"]).toEqual(listing);
    // The refresh has to follow the create, or the listing it fetches is the
    // one without the new branch.
    expect(h.mockBackend.createBranch.mock.invocationCallOrder[0]).toBeLessThan(
      h.mockBackend.listBranches.mock.invocationCallOrder[0],
    );
  });

  it("createBranch propagates git's rejection and refreshes nothing", async () => {
    // The slice throws on purpose — the finish dialog renders git's message
    // inline instead of reporting it as an error notice.
    h.mockBackend.createBranch.mockRejectedValueOnce(
      new Error("fatal: a branch named 'feat/new' already exists"),
    );
    h.useStore.setState({ branches: {}, branchActivity: {} });

    await expect(
      h.useStore.getState().createBranch("/p", "feat/new", BR),
    ).rejects.toThrow("a branch named 'feat/new' already exists");
    expect(h.mockBackend.listBranches).not.toHaveBeenCalled();
    expect(h.useStore.getState().branches).toEqual({});
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

describe("push and publish (issue #414)", () => {
  const HEAD = "feature/x";
  const pushed: PushResult = {
    kind: "pushed",
    remote: "origin",
    upstreamRef: `origin/${HEAD}`,
    commits: 2,
  };
  const upToDate: PushResult = {
    kind: "up-to-date",
    remote: "origin",
    upstreamRef: `origin/${HEAD}`,
  };
  const rejected: PushResult = {
    kind: "rejected",
    remote: "origin",
    detail: "! [rejected] feature/x -> feature/x (non-fast-forward)",
  };
  const noRemote: PushResult = { kind: "failed", detail: "fatal: no remote configured" };
  // feature/x tracks origin and is two commits ahead: the state every push
  // below starts from. defaultRemote is the listing's push target.
  const tracked: BranchList = {
    repoRoot: "/p",
    current: HEAD,
    branches: ["main", HEAD],
    defaultBranch: "main",
    upstreamRef: `origin/${HEAD}`,
    upstreamRemote: "origin",
    hasUpstream: true,
    ahead: 2,
    behind: 0,
    upstreamFetchedAt: 10,
    upstreamRefreshError: null,
    defaultRemote: "origin",
  };
  const pushedListing: BranchList = { ...tracked, ahead: 0, upstreamFetchedAt: 20 };
  const behindUpstream: BranchList = { ...tracked, ahead: 0, behind: 1 };
  const pulledListing: BranchList = { ...behindUpstream, behind: 0, upstreamFetchedAt: 20 };

  it("leaves another repository's activity alone while one repo's flags move", async () => {
    // Branch activity is keyed per project (issue #416): a push in one repo
    // must not blank a second repo's flags, and a pull parked there must not
    // be forgotten — both chips read their own key only.
    const inFlight = h.deferred<PushResult>();
    h.mockBackend.pushBranch.mockReturnValueOnce(inFlight.promise);
    h.mockBackend.listBranches.mockResolvedValueOnce(pushedListing);
    h.useStore.setState({
      branches: { "/p": tracked, "/other": tracked },
      branchActivity: { "/other": { refreshing: false, fetching: false, pulling: true, pushing: false } },
    });

    const push = h.useStore.getState().pushGitBranch("/p", HEAD);
    expect(h.useStore.getState().branchActivity["/other"]).toEqual({
      refreshing: false,
      fetching: false,
      pulling: true,
      pushing: false,
    });
    expect(h.useStore.getState().branchActivity["/p"]).toEqual({
      refreshing: false,
      fetching: false,
      pulling: false,
      pushing: true,
    });

    inFlight.resolve(pushed);
    expect(await push).toEqual(pushed);
    expect(h.useStore.getState().branchActivity["/other"].pulling).toBe(true);
    expect(h.useStore.getState().branchActivity["/p"].pushing).toBe(false);
  });

  it("pushGitBranch flags the whole push, refreshes locally once it lands, and returns the result", async () => {
    const inFlight = h.deferred<PushResult>();
    h.mockBackend.pushBranch.mockReturnValueOnce(inFlight.promise);
    h.mockBackend.listBranches.mockResolvedValueOnce(pushedListing);
    h.useStore.setState({ branches: { "/p": tracked }, branchActivity: {} });

    const push = h.useStore.getState().pushGitBranch("/p", HEAD);
    expect(h.mockBackend.pushBranch).toHaveBeenCalledWith("/p", HEAD);
    expect(h.useStore.getState().branchActivity["/p"]).toEqual({
      refreshing: false,
      fetching: false,
      pulling: false,
      pushing: true,
    });

    inFlight.resolve(pushed);
    expect(await push).toEqual(pushed);

    // The push advanced the remote-tracking ref, so the follow-up listing can
    // read the zero-ahead state off local refs: no fetch, same stance as pull.
    expect(h.mockBackend.listBranches.mock.calls).toEqual([
      ["/p", { fetchUpstream: false }],
    ]);
    expect(h.useStore.getState().branches["/p"]).toEqual(pushedListing);
    expect(h.useStore.getState().branchActivity["/p"]).toEqual({
      refreshing: false,
      fetching: false,
      pulling: false,
      pushing: false,
    });
  });

  it("pushGitBranch publishes an upstreamless branch onto the listing's defaultRemote", async () => {
    // Load-bearing fixture value: this clone's only remote is `upstream` and
    // there is no origin, so neither the result the store hands back nor the
    // listing it refreshes may name a hardcoded "origin".
    const published: PushResult = {
      kind: "published",
      remote: "upstream",
      upstreamRef: `upstream/${HEAD}`,
      commits: 1,
    };
    const untracked: BranchList = {
      ...tracked,
      upstreamRef: null,
      upstreamRemote: null,
      hasUpstream: false,
      ahead: 1,
      upstreamFetchedAt: null,
      defaultRemote: "upstream",
    };
    const publishedListing: BranchList = {
      ...untracked,
      upstreamRef: `upstream/${HEAD}`,
      upstreamRemote: "upstream",
      hasUpstream: true,
      ahead: 0,
      upstreamFetchedAt: 20,
    };
    h.mockBackend.pushBranch.mockResolvedValueOnce(published);
    h.mockBackend.listBranches.mockResolvedValueOnce(publishedListing);
    h.useStore.setState({ branches: { "/p": untracked }, branchActivity: {} });

    expect(await h.useStore.getState().pushGitBranch("/p", HEAD)).toEqual(published);
    expect(h.mockBackend.listBranches.mock.calls).toEqual([
      ["/p", { fetchUpstream: false }],
    ]);
    expect(h.useStore.getState().branches["/p"]).toEqual(publishedListing);
    expect(h.useStore.getState().branchActivity["/p"]).toEqual({
      refreshing: false,
      fetching: false,
      pulling: false,
      pushing: false,
    });
  });

  it("up-to-date, rejected and failed results resolve unchanged and refresh nothing", async () => {
    // None of these advanced a ref, so a refresh would be a network round trip
    // that rewrites the listing the dialog is still rendering.
    const cases: Array<{ result: PushResult; listing: BranchList }> = [
      { result: upToDate, listing: tracked },
      { result: rejected, listing: tracked },
      // Load-bearing fixture value: a repo with no remote at all, which is
      // what this git answer means.
      { result: noRemote, listing: { ...tracked, defaultRemote: null } },
    ];

    for (const { result, listing } of cases) {
      h.mockBackend.pushBranch.mockResolvedValueOnce(result);
      h.useStore.setState({ branches: { "/p": listing }, branchActivity: {} });

      expect(await h.useStore.getState().pushGitBranch("/p", HEAD)).toEqual(result);
      expect(h.mockBackend.listBranches).not.toHaveBeenCalled();
      expect(h.useStore.getState().branches["/p"]).toEqual(listing);
      expect(h.useStore.getState().branchActivity["/p"]).toEqual({
        refreshing: false,
        fetching: false,
        pulling: false,
        pushing: false,
      });
    }
  });

  it("coalesces concurrent pushes of one branch onto a single git call", async () => {
    const inFlight = h.deferred<PushResult>();
    h.mockBackend.pushBranch.mockReturnValueOnce(inFlight.promise);
    h.mockBackend.listBranches.mockResolvedValueOnce(pushedListing);
    h.useStore.setState({ branches: { "/p": tracked }, branchActivity: {} });

    const first = h.useStore.getState().pushGitBranch("/p", HEAD);
    const duplicate = h.useStore.getState().pushGitBranch("/p", HEAD);
    await h.flushMicrotasks();
    expect(h.mockBackend.pushBranch.mock.calls).toEqual([["/p", HEAD]]);

    inFlight.resolve(pushed);
    const [a, b] = await Promise.all([first, duplicate]);
    // Both callers get the structured result; neither got a second git push.
    expect([a, b]).toEqual([pushed, pushed]);
    // One push did the work for both callers, so it refreshed exactly once.
    expect(h.mockBackend.listBranches.mock.calls).toEqual([
      ["/p", { fetchUpstream: false }],
    ]);
    expect(h.useStore.getState().branchActivity["/p"]).toEqual({
      refreshing: false,
      fetching: false,
      pulling: false,
      pushing: false,
    });
  });

  it("pushes two branches of one repository side by side", async () => {
    // The in-flight key carries the branch: two branches of the same repo are
    // two different pushes, so a second must not join (or queue behind) the
    // first — the finish dialog pushes a branch the checkout may not hold.
    const xa = h.deferred<PushResult>();
    const yb = h.deferred<PushResult>();
    h.mockBackend.pushBranch
      .mockReturnValueOnce(xa.promise)
      .mockReturnValueOnce(yb.promise);
    h.useStore.setState({ branches: { "/p": tracked }, branchActivity: {} });

    const first = h.useStore.getState().pushGitBranch("/p", HEAD);
    const second = h.useStore.getState().pushGitBranch("/p", "feature/y");
    expect(h.mockBackend.pushBranch.mock.calls).toEqual([
      ["/p", HEAD],
      ["/p", "feature/y"],
    ]);

    yb.resolve(upToDate);
    expect(await second).toEqual(upToDate);
    expect(h.mockBackend.listBranches).not.toHaveBeenCalled();

    h.mockBackend.listBranches.mockResolvedValueOnce(pushedListing);
    xa.resolve(pushed);
    expect(await first).toEqual(pushed);
    expect(h.useStore.getState().branches["/p"]).toEqual(pushedListing);
  });

  it("pushGitBranch hands the caller a transport throw and clears pushing", async () => {
    const failure = new Error("ssh: connection reset by peer");
    h.mockBackend.pushBranch.mockRejectedValueOnce(failure);
    h.useStore.setState({ branches: { "/p": tracked }, branchActivity: {} });

    const push = h.useStore.getState().pushGitBranch("/p", HEAD);
    expect(h.useStore.getState().branchActivity["/p"]?.pushing).toBe(true);

    // Git state is an answer; a dead channel is not. The awaiting caller must
    // see the rejection — the slice may not launder it into a PushResult.
    await expect(push).rejects.toBe(failure);
    expect(h.useStore.getState().branches["/p"]).toEqual(tracked);
    expect(h.mockBackend.listBranches).not.toHaveBeenCalled();
    expect(h.useStore.getState().branchActivity["/p"]).toEqual({
      refreshing: false,
      fetching: false,
      pulling: false,
      pushing: false,
    });

    // The throw must drop the in-flight entry, or feature/x could never be
    // pushed again for the life of the renderer.
    h.mockBackend.pushBranch.mockResolvedValueOnce(pushed);
    h.mockBackend.listBranches.mockResolvedValueOnce(pushedListing);
    expect(await h.useStore.getState().pushGitBranch("/p", HEAD)).toEqual(pushed);
    expect(h.mockBackend.pushBranch).toHaveBeenCalledTimes(2);
  });

  it("pushGitBranch refuses while a pull runs and never reaches git", async () => {
    const pulling = h.deferred<void>();
    h.mockBackend.pullBranch.mockReturnValueOnce(pulling.promise);
    h.mockBackend.listBranches.mockResolvedValueOnce(pulledListing);
    h.useStore.setState({ branches: { "/p": behindUpstream }, branchActivity: {} });

    const pull = h.useStore.getState().pullGitBranch("/p");
    const result = await h.useStore.getState().pushGitBranch("/p", HEAD);

    expect(result).toEqual({ kind: "failed", detail: expect.stringContaining("pull") });
    expect(h.mockBackend.pushBranch).not.toHaveBeenCalled();
    expect(h.useStore.getState().branchActivity["/p"]).toEqual({
      refreshing: false,
      fetching: false,
      pulling: true,
      pushing: false,
    });

    pulling.resolve(undefined);
    await pull;
  });

  it("pullGitBranch refuses while a push runs and touches neither git nor the diff revision", async () => {
    const inFlight = h.deferred<PushResult>();
    h.mockBackend.pushBranch.mockReturnValueOnce(inFlight.promise);
    h.mockBackend.listBranches.mockResolvedValueOnce(pushedListing);
    h.useStore.setState({
      branches: { "/p": tracked },
      branchActivity: {},
      branchDiffRevision: { "/p": 3 },
    });

    const push = h.useStore.getState().pushGitBranch("/p", HEAD);
    expect(await h.useStore.getState().pullGitBranch("/p")).toBeNull();
    expect(h.mockBackend.pullBranch).not.toHaveBeenCalled();
    // The refusal leaves the flags alone: the push still owns this repository.
    expect(h.useStore.getState().branchActivity["/p"]).toEqual({
      refreshing: false,
      fetching: false,
      pulling: false,
      pushing: true,
    });
    // A pull that never ran must not bump the diff revision and refetch diffs.
    expect(h.useStore.getState().branchDiffRevision).toEqual({ "/p": 3 });

    inFlight.resolve(pushed);
    expect(await push).toEqual(pushed);
  });

  it("getPullRequestUrl forwards the pair and echoes the channel's null", async () => {
    const url = "https://github.com/omp-ui/omp-ui/compare/main...feature/x";
    h.mockBackend.pullRequestUrl.mockResolvedValueOnce(url);

    expect(await h.useStore.getState().getPullRequestUrl("/p", "main", HEAD)).toBe(url);
    expect(h.mockBackend.pullRequestUrl).toHaveBeenCalledWith("/p", "main", HEAD);

    // A remote with no web face answers null; the store must not invent a URL
    // for the dialog's "open PR" row.
    expect(await h.useStore.getState().getPullRequestUrl("/p", "main", HEAD)).toBeNull();
    expect(h.mockBackend.pullRequestUrl.mock.calls).toEqual([
      ["/p", "main", HEAD],
      ["/p", "main", HEAD],
    ]);
  });
});
