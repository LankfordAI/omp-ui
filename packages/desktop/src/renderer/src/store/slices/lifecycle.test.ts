// Lifecycle slice tests (moved verbatim from store.test.ts for #295).
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendState, LiveState, RemoteState } from "@omp-ui/core/types";
import {
  backendState as makeBackendState,
  rpcTabState,
  tabInfo,
} from "../../test/fixtures";

import { h } from "../../test/store-harness";

describe("console-drawer shell routing (issue #42)", () => {
  // init() latches a module-level `initialized` flag, so it can run exactly
  // once per file — no other suite calls it. The captures below must happen
  // in the same test: beforeEach's vi.clearAllMocks() wipes mock.calls.
  it("routes shell:data to the registered writer and tracks shell exit", async () => {
    h.useStore.setState({ shellExited: {} });
    await h.useStore.getState().init();
    const dataCb = h.mockBackend.onShellData.mock.calls[0]?.[0] as (
      tabId: string,
      data: Uint8Array,
    ) => void;
    const exitCb = h.mockBackend.onShellExit.mock.calls[0]?.[0] as (
      tabId: string,
      code: number,
    ) => void;
    expect(dataCb).toBeDefined();
    expect(exitCb).toBeDefined();
    // Same latch, same test: onRemoteState is registered and the initial getRemoteState()
    // seeds the store, so the settings page has a token to show before any transition.
    const remoteCb = h.mockBackend.onRemoteState.mock.calls[0]?.[0] as (
      s: RemoteState,
    ) => void;
    expect(remoteCb).toBeDefined();
    expect(h.useStore.getState().remote).toEqual(h.idleRemoteState);
    remoteCb({ ...h.idleRemoteState, status: "listening", enabled: true });
    expect(h.useStore.getState().remote.status).toBe("listening");

    const writer = vi.fn();
    const unregister = h.registerShellWriter(h.TAB, writer);
    dataCb(h.TAB, new Uint8Array([65]));
    expect(writer).toHaveBeenCalledWith(new Uint8Array([65]));
    unregister();
    dataCb(h.TAB, new Uint8Array([66]));
    expect(writer).toHaveBeenCalledTimes(1); // unregistered: dropped

    exitCb(h.TAB, 7);
    expect(h.useStore.getState().shellExited[h.TAB]).toBe(7);
    h.useStore.getState().clearShellExited(h.TAB);
    expect(h.useStore.getState().shellExited[h.TAB]).toBeUndefined();
  });
});

describe("TUI handoff staging (issue #243)", () => {
  // init() is latched, so this is a no-op once the suite above has run; it
  // still registers the shell-exit listener when only these cases are run.
  beforeEach(async () => {
    await h.useStore.getState().init();
    h.useStore.setState({ consoleOpen: {}, shellExited: {}, tuiHandoff: {} });
  });

  it("stages a handoff, sends it on demand, and retires it when omp exits", () => {
    // A previous login shell's exit code must not paint its notice over the
    // omp TUI the drawer is about to spawn.
    h.useStore.setState({ shellExited: { [h.TAB]: 0 } });

    h.useStore.getState().startTuiHandoff(h.TAB, "/mcp reauth linear");
    expect(h.useStore.getState().consoleOpen[h.TAB]).toBe(true);
    expect(h.useStore.getState().shellExited[h.TAB]).toBeUndefined();
    expect(h.useStore.getState().tuiHandoff[h.TAB]).toEqual({
      line: "/mcp reauth linear",
      key: 1,
      phase: "running",
    });

    h.useStore.getState().sendTuiHandoff(h.TAB);
    expect(h.mockBackend.shellWrite).toHaveBeenCalledWith(
      h.TAB,
      "/mcp reauth linear\r",
    );

    h.shellExitCb!(h.TAB, 0);
    expect(h.useStore.getState().tuiHandoff[h.TAB]!.phase).toBe("exited");
    expect(h.useStore.getState().shellExited[h.TAB]).toBe(0);

    // Nothing is listening once omp is gone — the banner offers a restart.
    h.mockBackend.shellWrite.mockClear();
    h.useStore.getState().sendTuiHandoff(h.TAB);
    expect(h.mockBackend.shellWrite).not.toHaveBeenCalled();

    h.useStore.getState().dismissTuiHandoff(h.TAB);
    expect(h.useStore.getState().tuiHandoff[h.TAB]).toBeUndefined();
  });

  it("bumps the key so a second handoff respawns the drawer's omp", () => {
    h.useStore.getState().startTuiHandoff(h.TAB, "/mcp reauth linear");
    h.useStore.getState().startTuiHandoff(h.TAB, "/mcp reauth github");
    expect(h.useStore.getState().tuiHandoff[h.TAB]).toEqual({
      line: "/mcp reauth github",
      key: 2,
      phase: "running",
    });
  });

  it("tracks a plain shell's exit without minting a handoff", () => {
    h.shellExitCb!(h.TAB, 1);
    expect(h.useStore.getState().shellExited[h.TAB]).toBe(1);
    expect(h.useStore.getState().tuiHandoff).toEqual({});
  });

  it("drops the staged handoff with the deleted session", async () => {
    h.useStore.setState({
      state: h.stateWithRecord("sess-1", "dormant"),
      tuiHandoff: { [h.TAB]: { line: "/mcp reauth linear", key: 1, phase: "running" } },
    });
    await h.useStore.getState().deleteSession(h.TAB);
    await h.useStore.getState().confirmDeleteSession(false);
    expect(h.useStore.getState().tuiHandoff[h.TAB]).toBeUndefined();
  });

  it("drops the staged handoff when the agent is terminated", async () => {
    // killShell suppresses the drawer program's exit event, so no shell:exit
    // ever arrives to retire the handoff — terminate must do it itself.
    h.useStore.setState({
      tuiHandoff: {
        [h.TAB]: { line: "/mcp reauth linear", key: 1, phase: "running" },
      },
    });

    await h.useStore.getState().terminate(h.TAB);

    expect(h.mockBackend.terminateSession).toHaveBeenCalledWith(h.TAB);
    expect(h.useStore.getState().tuiHandoff[h.TAB]).toBeUndefined();
  });

  it("keeps the staged handoff when terminate is declined", async () => {
    h.windowStub.confirm = (msg: string): boolean => {
      h.prompts.push(msg);
      return false;
    };
    const staged = {
      line: "/mcp reauth linear",
      key: 1,
      phase: "running" as const,
    };
    h.useStore.setState({ tuiHandoff: { [h.TAB]: staged } });

    await h.useStore.getState().terminate(h.TAB);

    expect(h.mockBackend.terminateSession).not.toHaveBeenCalled();
    expect(h.useStore.getState().tuiHandoff[h.TAB]).toEqual(staged);
  });
});

describe("deleteSession", () => {
  it("opens a warning that deleting a live session stops its agent", async () => {
    h.useStore.setState({
      state: h.stateWithRecord("sess-1", "live"),
      tabs: [
        tabInfo({
          tabId: h.TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      activeTabId: h.TAB,
      rpc: { [h.TAB]: rpcTabState() },
    });
    await h.useStore.getState().deleteSession(h.TAB);

    expect(h.mockBackend.deleteSession).not.toHaveBeenCalled();
    expect(h.useStore.getState().deleteConfirmation).toEqual({
      tabId: h.TAB,
      title: "New session",
      running: true,
      hasFiles: true,
      worktreeBranch: null,
      worktreeBase: null,
    });

    await h.useStore.getState().confirmDeleteSession(false);
    expect(h.mockBackend.deleteSession).toHaveBeenCalledWith(h.TAB);
    expect(h.useStore.getState().tabs).toEqual([]);
  });

  it("does nothing when the warning is dismissed", async () => {
    h.useStore.setState({ state: h.stateWithRecord("sess-1", "dormant") });
    await h.useStore.getState().deleteSession(h.TAB);
    h.useStore.getState().cancelDeleteSession();

    expect(h.mockBackend.deleteSession).not.toHaveBeenCalled();
    expect(h.useStore.getState().deleteConfirmation).toBeNull();
  });

  it("drops the tab, its rpc slot, and its exit code once confirmed", async () => {
    h.useStore.setState({
      state: h.stateWithRecord("sess-1", "dormant"),
      tabs: [
        tabInfo({
          tabId: h.TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
        tabInfo({
          tabId: "other",
          mode: "pty",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      activeTabId: h.TAB,
      exited: { [h.TAB]: 1 },
      rpc: { [h.TAB]: rpcTabState() },
    });

    await h.useStore.getState().deleteSession(h.TAB);
    await h.useStore.getState().confirmDeleteSession(false);

    expect(h.mockBackend.deleteSession).toHaveBeenCalledWith(h.TAB);
    const st = h.useStore.getState();
    expect(st.tabs.map((t) => t.tabId)).toEqual(["other"]);
    expect(st.rpc[h.TAB]).toBeUndefined();
    expect(st.exited[h.TAB]).toBeUndefined();
    expect(st.activeTabId).toBe("other");
  });

  it("keeps the tab and surfaces the error when the backend delete fails", async () => {
    h.mockBackend.deleteSession.mockRejectedValueOnce(new Error("EBUSY"));
    h.useStore.setState({
      state: h.stateWithRecord("sess-1", "dormant"),
      tabs: [
        tabInfo({
          tabId: h.TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      activeTabId: h.TAB,
      rpc: { [h.TAB]: rpcTabState() },
    });

    await h.useStore.getState().deleteSession(h.TAB);
    await h.useStore.getState().confirmDeleteSession(false);

    const st = h.useStore.getState();
    expect(st.tabs.map((t) => t.tabId)).toEqual([h.TAB]);
    expect(st.rpc[h.TAB]).toBeDefined();
    expect(h.alerts[0]).toBe("EBUSY");
  });

  it("marks a record whose files are gone without a file-erasure warning", async () => {
    h.useStore.setState({ state: h.stateWithRecord("sess-1", "missing") });
    await h.useStore.getState().deleteSession(h.TAB);

    expect(h.useStore.getState().deleteConfirmation?.hasFiles).toBe(false);
  });

  it("records the worktree branch and base on the confirmation", async () => {
    const state = h.stateWithRecord("sess-1", "live");
    state.projects[0]!.sessions[0]!.worktree = {
      path: "/wt",
      branch: "omp-ui/abcd1234",
      base: "main",
    };
    h.useStore.setState({
      state,
      tabs: [
        tabInfo({
          tabId: h.TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      activeTabId: h.TAB,
      rpc: { [h.TAB]: rpcTabState() },
    });
    await h.useStore.getState().deleteSession(h.TAB);

    expect(h.useStore.getState().deleteConfirmation).toEqual({
      tabId: h.TAB,
      title: "New session",
      running: true,
      hasFiles: true,
      worktreeBranch: "omp-ui/abcd1234",
      worktreeBase: "main",
    });
  });

  it("records a null base on a pre-field worktree record", async () => {
    const state = h.stateWithRecord("sess-1", "dormant");
    state.projects[0]!.sessions[0]!.worktree = {
      path: "/wt",
      branch: "omp-ui/abcd1234",
      base: null,
    };
    h.useStore.setState({ state });
    await h.useStore.getState().deleteSession(h.TAB);

    expect(h.useStore.getState().deleteConfirmation).toMatchObject({
      worktreeBranch: "omp-ui/abcd1234",
      worktreeBase: null,
    });
  });

  it("persists the opt-out only when deletion is confirmed", async () => {
    h.useStore.setState({ state: h.stateWithRecord("sess-1", "dormant") });
    await h.useStore.getState().deleteSession(h.TAB);
    h.useStore.getState().cancelDeleteSession();
    expect(h.mockBackend.setSkipDeleteConfirmation).not.toHaveBeenCalled();

    await h.useStore.getState().deleteSession(h.TAB);
    await h.useStore.getState().confirmDeleteSession(true);
    expect(h.mockBackend.setSkipDeleteConfirmation).toHaveBeenCalledWith(true);
  });

  it("deletes immediately after warnings have been disabled", async () => {
    const state = h.stateWithRecord("sess-1", "dormant");
    state.skipDeleteConfirmation = true;
    h.useStore.setState({ state });

    await h.useStore.getState().deleteSession(h.TAB);

    expect(h.useStore.getState().deleteConfirmation).toBeNull();
    expect(h.mockBackend.deleteSession).toHaveBeenCalledWith(h.TAB);
  });
});

describe("convertSessionToWorktree (issue #225)", () => {
  it("converts via the backend channel and rethrows failures", async () => {
    await h.useStore
      .getState()
      .convertSessionToWorktree(h.TAB, { branch: "omp-ui/abcd1234", baseRef: "main" });
    expect(h.mockBackend.convertToWorktree).toHaveBeenCalledWith(h.TAB, "omp-ui/abcd1234", "main");

    h.mockBackend.convertToWorktree.mockRejectedValueOnce(new Error("branch already exists"));
    await expect(
      h.useStore
        .getState()
        .convertSessionToWorktree(h.TAB, { branch: "omp-ui/abcd1234", baseRef: null }),
    ).rejects.toThrow("branch already exists");
  });
});

describe("focusedTabByProject tracks every tab-activation path (issue #99)", () => {
  const projectState = (
    sessions: BackendState["projects"][0]["sessions"],
  ): BackendState =>
    makeBackendState({
      projects: [
        {
          project: {
            path: "/p",
            name: "p",
            addedAt: "t",
            lastModel: null,
            lastThinkingLevel: null,
            lastAdvisor: null,
            lastAdvisorModel: null,
            defaultModel: null,
            defaultAdvisorModel: null,
          },
          sessions,
        },
      ],
    });
  const rec = (tabId: string, live: LiveState = "live") => ({
    tabId,
    sessionId: `sid-${tabId}`,
    lineageDir: `omp-ui--p--${tabId}`,
    projectCwd: "/p",
    launchedAt: "t",
    mode: "rpc-ui" as const,
    worktree: null,
    planImplementationSource: null,
    agentMode: "build" as const,
    compactionMethod: null,
    model: null,
    thinkingLevel: null,
    lastViewedAt: null,
    advisor: false,
    advisorModel: null,
    cachedTitle: null,
    cachedModified: null,
    title: "New session",
    status: null,
    live,
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
  });

  it("newSession records the spawned tab as the project's focus", async () => {
    h.backendState = projectState([rec(h.TAB)]);
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh" });
    h.useStore.setState({
      state: h.backendState,
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });

    await h.useStore.getState().newSession("/p");

    const st = h.useStore.getState();
    expect(st.focusedTabByProject["/p"]).toBe("fresh");
    expect(st.activeTabId).toBe("fresh");
  });

  it("openSession on a dormant record resumes and records focus", async () => {
    h.backendState = projectState([rec(h.TAB, "dormant")]);
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: h.TAB });
    h.useStore.setState({ state: h.backendState });

    await h.useStore.getState().openSession(h.TAB);

    const st = h.useStore.getState();
    expect(st.focusedTabByProject["/p"]).toBe(h.TAB);
    expect(st.activeTabId).toBe(h.TAB);
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectCwd: "/p",
        mode: "rpc-ui",
        advisor: false,
        resumeTabId: h.TAB,
      }),
    );
  });

  it("openSession on an existing tab unhides and records focus without reseeding", async () => {
    h.backendState = projectState([rec(h.TAB)]);
    h.useStore.setState({
      state: h.backendState,
      tabs: [
        tabInfo({ tabId: h.TAB, mode: "rpc-ui", projectCwd: "/p", hidden: true }),
      ],
    });

    await h.useStore.getState().openSession(h.TAB);

    const st = h.useStore.getState();
    expect(st.focusedTabByProject["/p"]).toBe(h.TAB);
    expect(st.activeTabId).toBe(h.TAB);
    expect(st.tabs.find((t) => t.tabId === h.TAB)?.hidden).toBe(false);
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
  });

  it("focusTab records the focused tab's project", () => {
    h.useStore.setState({
      tabs: [
        tabInfo({ tabId: h.TAB, mode: "rpc-ui", projectCwd: "/p", hidden: true }),
      ],
    });

    h.useStore.getState().focusTab(h.TAB);

    const st = h.useStore.getState();
    expect(st.focusedTabByProject["/p"]).toBe(h.TAB);
    expect(st.activeTabId).toBe(h.TAB);
  });

  it("resumeDead behind a dormant record records focus", async () => {
    h.backendState = projectState([rec(h.TAB, "dormant")]);
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: h.TAB });
    h.useStore.setState({
      state: h.backendState,
      tabs: [
        tabInfo({ tabId: h.TAB, mode: "rpc-ui", projectCwd: "/p", hidden: true }),
      ],
    });

    await h.useStore.getState().resumeDead(h.TAB);

    const st = h.useStore.getState();
    expect(st.focusedTabByProject["/p"]).toBe(h.TAB);
    expect(st.activeTabId).toBe(h.TAB);
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeTabId: h.TAB,
        projectCwd: "/p",
        mode: "rpc-ui",
      }),
    );
  });

  it("resumeDead behind a hibernated tab wakes it and clears the flag", async () => {
    h.backendState = projectState([rec(h.TAB, "dormant")]);
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: h.TAB });
    h.useStore.setState({
      state: h.backendState,
      tabs: [
        tabInfo({ tabId: h.TAB, mode: "rpc-ui", projectCwd: "/p", hidden: true }),
      ],
      exited: { [h.TAB]: 0 },
      hibernated: { [h.TAB]: true },
    });

    await h.useStore.getState().resumeDead(h.TAB);

    const st = h.useStore.getState();
    expect(st.exited[h.TAB]).toBeUndefined();
    expect(st.hibernated[h.TAB]).toBeUndefined();
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ resumeTabId: h.TAB, projectCwd: "/p", mode: "rpc-ui" }),
    );
  });
});

describe("hiding or deleting a project's remembered focus moves or drops it (issue #99)", () => {
  const rec = (tabId: string) => ({
    tabId,
    sessionId: `sid-${tabId}`,
    lineageDir: `omp-ui--p--${tabId}`,
    projectCwd: "/p",
    launchedAt: "t",
    mode: "rpc-ui" as const,
    worktree: null,
    planImplementationSource: null,
    agentMode: "build" as const,
    compactionMethod: null,
    model: null,
    thinkingLevel: null,
    lastViewedAt: null,
    advisor: false,
    advisorModel: null,
    cachedTitle: null,
    cachedModified: null,
    title: "New session",
    status: null,
    live: "live" as const,
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
  });
  const twoSessionState = (): BackendState =>
    makeBackendState({
      skipDeleteConfirmation: true,
      projects: [
        {
          project: {
            path: "/p",
            name: "p",
            addedAt: "t",
            lastModel: null,
            lastThinkingLevel: null,
            lastAdvisor: null,
            lastAdvisorModel: null,
            defaultModel: null,
            defaultAdvisorModel: null,
          },
          sessions: [rec(h.TAB), rec("other")],
        },
      ],
    });

  it("hideTab moves the project's focus to its last non-hidden tab", () => {
    h.useStore.setState({
      state: twoSessionState(),
      tabs: [
        tabInfo({
          tabId: h.TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
        tabInfo({
          tabId: "other",
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      activeTabId: h.TAB,
      focusedTabByProject: { "/p": h.TAB },
    });

    h.useStore.getState().hideTab(h.TAB);

    const st = h.useStore.getState();
    // Per-project focus moves to the surviving tab of the same project…
    expect(st.focusedTabByProject["/p"]).toBe("other");
    // …and the global fallback also lands on the last non-hidden tab overall.
    expect(st.activeTabId).toBe("other");
  });

  it("hideTab drops the project entry when the hidden tab was its only one", () => {
    h.useStore.setState({
      state: {
        ...twoSessionState(),
        projects: [{ ...twoSessionState().projects[0]!, sessions: [rec(h.TAB)] }],
      },
      tabs: [
        tabInfo({
          tabId: h.TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      activeTabId: h.TAB,
      focusedTabByProject: { "/p": h.TAB },
    });

    h.useStore.getState().hideTab(h.TAB);

    expect(h.useStore.getState().focusedTabByProject).toEqual({});
  });

  it("deleting the focused tab moves focus to the surviving sibling", async () => {
    h.useStore.setState({
      state: twoSessionState(),
      tabs: [
        tabInfo({
          tabId: h.TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
        tabInfo({
          tabId: "other",
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      activeTabId: h.TAB,
      focusedTabByProject: { "/p": h.TAB },
    });

    await h.useStore.getState().deleteSession(h.TAB);

    expect(h.mockBackend.deleteSession).toHaveBeenCalledWith(h.TAB);
    expect(h.useStore.getState().focusedTabByProject["/p"]).toBe("other");
  });

  it("deleting the last tab of a project drops its focus entry", async () => {
    h.useStore.setState({
      state: {
        ...twoSessionState(),
        projects: [{ ...twoSessionState().projects[0]!, sessions: [rec(h.TAB)] }],
      },
      tabs: [
        tabInfo({
          tabId: h.TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      activeTabId: h.TAB,
      focusedTabByProject: { "/p": h.TAB },
    });

    await h.useStore.getState().deleteSession(h.TAB);

    expect(h.useStore.getState().focusedTabByProject).toEqual({});
  });
});
