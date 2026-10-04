// Lifecycle slice tests (moved verbatim from store.test.ts for #295).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PLAN_STATUS_KEY } from "@omp-ui/core/plan";
import type {
  BackendState,
  LiveState,
  PlanHandoffDescendant,
  RemoteState,
  WorktreeReleaseResult,
  WorktreeSyncResult,
  SessionSummary,
} from "@omp-ui/core/types";
import {
  backendState as makeBackendState,
  remoteInstance,
  rpcTabState,
  tabInfo,
} from "../../test/fixtures";

import { h } from "../../test/store-harness";
import type { LifecycleSlice } from "./lifecycle";
import type { RpcTabState, UiStore } from "../types";
import { worktreeMergeResolutionState } from "../../lib/worktree-merge-resolution";

describe("running-input keyword process boundaries (issue #726)", () => {
  const lifecycle = () => h.useStore.getState() as UiStore & LifecycleSlice;

  beforeEach(() => {
    h.useStore.setState({
      rpc: { [h.TAB]: rpcTabState({ status: "ready", subagentControlError: "old process error" }) },
    });
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_start" });
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "message_start",
      message: { role: "custom", customType: "ultrathink-notice", display: false, content: "hidden" },
    });
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "message_start", message: { role: "user", content: "ordinary" },
    });
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "message_start",
      message: { role: "custom", customType: "workflow-notice", display: false, content: "hidden" },
    });
    expect(h.useStore.getState().rpc[h.TAB]!.activeTurnKeywords).toEqual(["ultrathink"]);
  });

  it.each([false, true])("exit clears the effect without tool or stall changes (hibernated=%s)", (hibernated) => {
    const items = h.useStore.getState().rpc[h.TAB]!.items;
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBeUndefined();
    lifecycle().teardownProcess(h.TAB, 0, hibernated);
    const state = h.useStore.getState();
    expect(state.rpc[h.TAB]!.activeTurnKeywords).toEqual([]);
    expect(state.rpc[h.TAB]!.items).toBe(items);
    // Keyword-only cleanup must not resurrect fields disposeTabRuntime retired.
    expect(state.rpc[h.TAB]!.subagentControlError).toBeNull();
    expect(state.exited[h.TAB]).toBe(0);
    expect(state.hibernated[h.TAB]).toBe(hibernated ? true : undefined);
    state.handleRpcFrame(h.TAB, {
      type: "message_start", message: { role: "user", content: "ordinary successor input" },
    });
    expect(h.useStore.getState().rpc[h.TAB]!.activeTurnKeywords).toEqual([]);
  });

  it("preparing a relaunch clears active and staged input immediately", () => {
    lifecycle().prepareRpcRelaunch(h.TAB);
    expect(h.useStore.getState().rpc[h.TAB]!.status).toBe("starting");
    expect(h.useStore.getState().rpc[h.TAB]!.activeTurnKeywords).toEqual([]);
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "message_start", message: { role: "user", content: "ordinary successor input" },
    });
    expect(h.useStore.getState().rpc[h.TAB]!.activeTurnKeywords).toEqual([]);
  });
});

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
    // ever arrives to retire the handoff — an accepted terminate must.
    h.useStore.setState({
      state: h.stateWithRecord("sess-1", "live"),
      tuiHandoff: {
        [h.TAB]: { line: "/mcp reauth linear", key: 1, phase: "running" },
      },
    });

    await h.useStore.getState().terminate(h.TAB);
    const confirmation = h.useStore.getState().lifecycleConfirmation!;
    // Before approval: neither the backend nor the handoff is touched.
    expect(h.mockBackend.terminateSession).not.toHaveBeenCalled();
    expect(h.useStore.getState().tuiHandoff[h.TAB]).toBeDefined();

    await h.useStore.getState().confirmLifecycleAction(confirmation.id);
    expect(h.mockBackend.terminateSession).toHaveBeenCalledWith(h.TAB);
    expect(h.useStore.getState().tuiHandoff[h.TAB]).toBeUndefined();
    expect(h.useStore.getState().lifecycleConfirmation).toBeNull();
  });

  it("keeps the staged handoff when terminate is cancelled", async () => {
    const staged = {
      line: "/mcp reauth linear",
      key: 1,
      phase: "running" as const,
    };
    h.useStore.setState({
      state: h.stateWithRecord("sess-1", "live"),
      tuiHandoff: { [h.TAB]: staged },
    });

    await h.useStore.getState().terminate(h.TAB);
    const confirmation = h.useStore.getState().lifecycleConfirmation!;
    h.useStore.getState().cancelLifecycleAction(confirmation.id);

    expect(h.mockBackend.terminateSession).not.toHaveBeenCalled();
    expect(h.useStore.getState().tuiHandoff[h.TAB]).toEqual(staged);
    expect(h.useStore.getState().lifecycleConfirmation).toBeNull();
  });

  it("reports a failed stop without retiring the handoff", async () => {
    // A rejection is not the stop the user accepted: the banner must stay
    // over the still-live PTY, and the reason must reach an error notice.
    const staged = {
      line: "/mcp reauth linear",
      key: 1,
      phase: "running" as const,
    };
    h.mockBackend.terminateSession.mockRejectedValueOnce(new Error("kill failed"));
    h.useStore.setState({
      state: h.stateWithRecord("sess-1", "live"),
      tuiHandoff: { [h.TAB]: staged },
    });

    await h.useStore.getState().terminate(h.TAB);
    const confirmation = h.useStore.getState().lifecycleConfirmation!;
    await h.useStore.getState().confirmLifecycleAction(confirmation.id);

    expect(h.errorMessages()).toEqual(["kill failed"]);
    expect(h.useStore.getState().tuiHandoff[h.TAB]).toEqual(staged);
    expect(h.useStore.getState().lifecycleConfirmation).toBeNull();
  });
});

describe("lifecycle confirmation acceptance (issue #373)", () => {
  const staged = {
    line: "/mcp reauth linear",
    key: 1,
    phase: "running" as const,
  };

  it("dispatches once no matter how often the accepted button fires", async () => {
    const stop = h.deferred<void>();
    h.mockBackend.terminateSession.mockReturnValueOnce(stop.promise);
    h.useStore.setState({
      state: h.stateWithRecord("sess-1", "live"),
      tuiHandoff: { [h.TAB]: staged },
    });
    await h.useStore.getState().terminate(h.TAB);
    const id = h.useStore.getState().lifecycleConfirmation!.id;

    const first = h.useStore.getState().confirmLifecycleAction(id);
    // The dialog disables both buttons while busy; a stale activation must
    // still find the busy flag and dispatch nothing.
    await h.useStore.getState().confirmLifecycleAction(id);
    expect(h.mockBackend.terminateSession).toHaveBeenCalledTimes(1);
    expect(h.useStore.getState().lifecycleConfirmation).toMatchObject({
      id,
      busy: true,
    });
    stop.resolve(undefined);
    await first;
    expect(h.useStore.getState().lifecycleConfirmation).toBeNull();
  });

  it("re-checks liveness at acceptance and dismisses a vanished target", async () => {
    h.useStore.setState({
      state: h.stateWithRecord("sess-1", "live"),
      tuiHandoff: { [h.TAB]: staged },
    });
    await h.useStore.getState().terminate(h.TAB);
    const id = h.useStore.getState().lifecycleConfirmation!.id;
    // The process died on its own while the dialog was open.
    h.useStore.setState({ state: h.stateWithRecord("sess-1", "dormant") });

    await h.useStore.getState().confirmLifecycleAction(id);
    expect(h.mockBackend.terminateSession).not.toHaveBeenCalled();
    expect(h.useStore.getState().tuiHandoff[h.TAB]).toEqual(staged);
    expect(h.useStore.getState().lifecycleConfirmation).toBeNull();
  });

  it("does nothing when a non-live session is asked to stop", async () => {
    h.useStore.setState({ state: h.stateWithRecord("sess-1", "dormant") });
    await h.useStore.getState().terminate(h.TAB);
    expect(h.useStore.getState().lifecycleConfirmation).toBeNull();
    await h.useStore.getState().confirmLifecycleAction("stale-id");
    expect(h.mockBackend.terminateSession).not.toHaveBeenCalled();
  });

  it("never queues behind a pending confirmation or a visible delete warning", async () => {
    h.useStore.setState({
      state: h.stateWithRecord("sess-1", "live"),
      deleteConfirmation: {
        tabId: h.TAB,
        title: "New session",
        running: true,
        hasFiles: true,
        worktreeBranch: null,
        worktreeBase: null,
        worktreePath: null,
        cascade: [],
      },
    });
    await h.useStore.getState().terminate(h.TAB);
    expect(h.useStore.getState().lifecycleConfirmation).toBeNull();

    h.useStore.setState({ deleteConfirmation: null });
    await h.useStore.getState().terminate(h.TAB);
    const first = h.useStore.getState().lifecycleConfirmation!;
    // A repeated request while one is pending is a no-op, not a second row.
    await h.useStore.getState().terminate(h.TAB);
    expect(h.useStore.getState().lifecycleConfirmation).toBe(first);
  });

  it("ignores cancel and confirm aimed at a superseded id", async () => {
    h.useStore.setState({ state: h.stateWithRecord("sess-1", "live") });
    await h.useStore.getState().terminate(h.TAB);
    const stale = h.useStore.getState().lifecycleConfirmation!.id;
    h.useStore.setState({ lifecycleConfirmation: null });
    await h.useStore.getState().terminate(h.TAB);
    const current = h.useStore.getState().lifecycleConfirmation!;

    h.useStore.getState().cancelLifecycleAction(stale);
    expect(h.useStore.getState().lifecycleConfirmation).toBe(current);
    await h.useStore.getState().confirmLifecycleAction(stale);
    expect(h.mockBackend.terminateSession).not.toHaveBeenCalled();
  });
});

describe("switchMode confirmation (issue #373)", () => {
  it("a live switch stages the decision and reaches the backend only on acceptance", async () => {
    h.useStore.setState({ state: h.stateWithRecord("sess-1", "live") });
    await h.useStore.getState().switchMode(h.TAB, "pty");
    expect(h.mockBackend.switchMode).not.toHaveBeenCalled();
    const confirmation = h.useStore.getState().lifecycleConfirmation!;
    expect(confirmation).toMatchObject({
      kind: "switch-mode",
      tabId: h.TAB,
      title: "New session",
      fromMode: "rpc-ui",
      mode: "pty",
    });

    await h.useStore.getState().confirmLifecycleAction(confirmation.id);
    expect(h.mockBackend.switchMode).toHaveBeenCalledWith(h.TAB, "pty");
    expect(h.useStore.getState().lifecycleConfirmation).toBeNull();
  });

  it("a dormant switch proceeds immediately without a confirmation", async () => {
    h.useStore.setState({ state: h.stateWithRecord("sess-1", "dormant") });
    await h.useStore.getState().switchMode(h.TAB, "pty");
    expect(h.useStore.getState().lifecycleConfirmation).toBeNull();
    expect(h.mockBackend.switchMode).toHaveBeenCalledWith(h.TAB, "pty");
  });

  it("an already-selected mode does nothing and asks nothing", async () => {
    h.useStore.setState({ state: h.stateWithRecord("sess-1", "live") });
    await h.useStore.getState().switchMode(h.TAB, "rpc-ui");
    expect(h.useStore.getState().lifecycleConfirmation).toBeNull();
    expect(h.mockBackend.switchMode).not.toHaveBeenCalled();
  });

  it("dismisses a confirmed switch whose mode moved on meanwhile", async () => {
    h.useStore.setState({ state: h.stateWithRecord("sess-1", "live") });
    await h.useStore.getState().switchMode(h.TAB, "pty");
    const id = h.useStore.getState().lifecycleConfirmation!.id;
    const moved = h.stateWithRecord("sess-1", "live");
    moved.projects[0]!.sessions[0]!.mode = "pty";
    h.useStore.setState({ state: moved });

    await h.useStore.getState().confirmLifecycleAction(id);
    expect(h.mockBackend.switchMode).not.toHaveBeenCalled();
    expect(h.useStore.getState().lifecycleConfirmation).toBeNull();
  });

  it("a target that died mid-prompt still switches, with no restart prepared", async () => {
    h.useStore.setState({
      state: h.stateWithRecord("sess-1", "live"),
      rpc: { [h.TAB]: rpcTabState({ status: "running" }) },
    });
    await h.useStore.getState().switchMode(h.TAB, "pty");
    const id = h.useStore.getState().lifecycleConfirmation!.id;
    h.useStore.setState({ state: h.stateWithRecord("sess-1", "dormant") });

    await h.useStore.getState().confirmLifecycleAction(id);
    expect(h.mockBackend.switchMode).toHaveBeenCalledWith(h.TAB, "pty");
    // prepareRpcRelaunch would have flipped the tab to "starting"; a dormant
    // switch must leave the transcript view exactly as it was.
    expect(h.useStore.getState().rpc[h.TAB]!.status).toBe("running");
  });
});

describe("removeProject confirmation (issue #373)", () => {
  it("removes only on acceptance, keeping backend semantics authoritative", async () => {
    h.useStore.setState({ state: h.stateWithRecord("sess-1", "dormant") });
    await h.useStore.getState().removeProject("/p");
    expect(h.mockBackend.removeProject).not.toHaveBeenCalled();
    const confirmation = h.useStore.getState().lifecycleConfirmation!;
    expect(confirmation).toMatchObject({
      kind: "remove-project",
      projectPath: "/p",
    });
    // No optimistic pruning: the store keeps the pre-removal state object
    // until the authoritative stateChanged broadcast replaces it.
    const before = h.useStore.getState().state;
    await h.useStore.getState().confirmLifecycleAction(confirmation.id);
    expect(h.mockBackend.removeProject).toHaveBeenCalledWith("/p");
    expect(h.useStore.getState().state).toBe(before);
  });

  it("stages nothing for an unregistered path", async () => {
    h.useStore.setState({ state: makeBackendState() });
    await h.useStore.getState().removeProject("/gone");
    expect(h.useStore.getState().lifecycleConfirmation).toBeNull();
  });

  it("dismisses a confirmed removal whose project vanished meanwhile", async () => {
    h.useStore.setState({ state: h.stateWithRecord("sess-1", "dormant") });
    await h.useStore.getState().removeProject("/p");
    const id = h.useStore.getState().lifecycleConfirmation!.id;
    h.useStore.setState({ state: makeBackendState() });

    await h.useStore.getState().confirmLifecycleAction(id);
    expect(h.mockBackend.removeProject).not.toHaveBeenCalled();
    expect(h.useStore.getState().lifecycleConfirmation).toBeNull();
  });
});

describe("remote instance project and session actions (issue #416)", () => {
  const INSTANCE = "inst-a";
  const REMOTE_TAB = "remote-1";
  /** One remote instance whose only project is /p with one dormant session. */
  const remoteState = (status: "joined" | "unreachable" = "joined"): BackendState => {
    const local = h.stateWithRecord("sess-1", "dormant");
    const group = local.projects[0]!;
    return makeBackendState({
      remoteInstances: [
        remoteInstance({
          id: INSTANCE,
          nickname: "box-a",
          status,
          projects: [
            { ...group, sessions: [{ ...group.sessions[0]!, tabId: REMOTE_TAB }] },
          ],
        }),
      ],
    });
  };

  it("routes project mutations to the owning instance through the proxy channels", async () => {
    h.useStore.setState({ state: remoteState() });
    await h.useStore.getState().addProject("/q", INSTANCE);
    await h.useStore.getState().moveProject("/p", null, INSTANCE);
    await h.useStore.getState().setProjectDefaultModel("/p", "m", INSTANCE);
    expect(h.mockBackend.addProject).not.toHaveBeenCalled();
    expect(h.mockBackend.moveProject).not.toHaveBeenCalled();
    expect(h.mockBackend.setProjectDefaultModel).not.toHaveBeenCalled();
    expect(h.mockBackend.remoteInstanceRequest.mock.calls).toEqual([
      [INSTANCE, "project:add", ["/q"]],
      [INSTANCE, "project:move", ["/p", null]],
      [INSTANCE, "project:setDefaultModel", ["/p", "m"]],
    ]);
  });

  it("confirms removing a remote project against that instance's registry, not the local one", async () => {
    h.useStore.setState({ state: remoteState() });
    // /p is registered on the remote only: the local removal has nothing to confirm.
    await h.useStore.getState().removeProject("/p");
    expect(h.useStore.getState().lifecycleConfirmation).toBeNull();

    await h.useStore.getState().removeProject("/p", INSTANCE);
    const confirmation = h.useStore.getState().lifecycleConfirmation!;
    expect(confirmation).toMatchObject({
      kind: "remove-project",
      projectPath: "/p",
      instanceId: INSTANCE,
    });
    await h.useStore.getState().confirmLifecycleAction(confirmation.id);
    expect(h.mockBackend.removeProject).not.toHaveBeenCalled();
    expect(h.mockBackend.remoteInstanceRequest).toHaveBeenCalledWith(
      INSTANCE,
      "project:remove",
      ["/p"],
    );
  });

  it("removes a remote instance only on acceptance and only while it still exists", async () => {
    h.useStore.setState({ state: remoteState() });
    h.useStore.getState().confirmRemoveRemoteInstance(INSTANCE, "box-a");
    const confirmation = h.useStore.getState().lifecycleConfirmation!;
    expect(confirmation).toMatchObject({
      kind: "remove-remote-instance",
      instanceId: INSTANCE,
      nickname: "box-a",
    });
    expect(h.mockBackend.removeRemoteInstance).not.toHaveBeenCalled();
    await h.useStore.getState().confirmLifecycleAction(confirmation.id);
    expect(h.mockBackend.removeRemoteInstance).toHaveBeenCalledWith(INSTANCE);

    // Already gone (removed from another window): stages nothing.
    h.useStore.setState({ state: makeBackendState() });
    h.useStore.getState().confirmRemoveRemoteInstance(INSTANCE, "box-a");
    expect(h.useStore.getState().lifecycleConfirmation).toBeNull();
  });

  it("opens a remote session as a tab owned by its instance, focused under the composite key", async () => {
    h.useStore.setState({ state: remoteState() });
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: REMOTE_TAB });
    await h.useStore.getState().openSession(REMOTE_TAB);
    // The resume is tab-scoped: the local backend routes it by resumeTabId.
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "resume",
      resumeTabId: REMOTE_TAB,
      cols: 80,
      rows: 24,
    });
    const st = h.useStore.getState();
    expect(st.tabs).toEqual([
      tabInfo({ tabId: REMOTE_TAB, mode: "rpc-ui", projectCwd: "/p", instanceId: INSTANCE }),
    ]);
    expect(st.focusedTabByProject).toEqual({ [`${INSTANCE}::/p`]: REMOTE_TAB });
  });

  it("refuses to resume a session whose instance is not joined and says which one", async () => {
    h.useStore.setState({ state: remoteState("unreachable") });
    await h.useStore.getState().openSession(REMOTE_TAB);
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
    expect(h.useStore.getState().tabs).toEqual([]);
    expect(h.errorMessages()).toEqual([expect.stringContaining("box-a")]);
  });

  it("spawns a new remote session with that project's own advisor memory", async () => {
    const state = remoteState();
    state.remoteInstances[0]!.projects[0]!.project.lastAdvisor = true;
    state.remoteInstances[0]!.projects[0]!.project.lastAdvisorModel = "remote/advisor";
    h.useStore.setState({ state });
    h.mockBackend.remoteInstanceRequest.mockImplementation(async (_id, channel) =>
      channel === "session:spawn" ? { tabId: "fresh" } : { enabled: false, model: null },
    );
    await h.useStore.getState().newSession("/p", "rpc-ui", INSTANCE);
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
    expect(h.mockBackend.remoteInstanceRequest).toHaveBeenCalledWith(
      INSTANCE,
      "advisor:defaults",
      ["/p"],
    );
    expect(h.mockBackend.remoteInstanceRequest).toHaveBeenCalledWith(
      INSTANCE,
      "session:spawn",
      [expect.objectContaining({ projectCwd: "/p", advisor: true, advisorModel: "remote/advisor" })],
    );
    expect(h.useStore.getState().tabs).toEqual([
      tabInfo({ tabId: "fresh", mode: "rpc-ui", projectCwd: "/p", instanceId: INSTANCE }),
    ]);
    expect(h.useStore.getState().advisorDefaults).toEqual({
      [`${INSTANCE}::/p`]: { enabled: false, model: null },
    });
  });
  it("routes favorite toggles to the owning instance through the proxy channel", async () => {
    h.useStore.setState({ state: remoteState() });
    await h.useStore.getState().toggleFavorite("anthropic/claude", INSTANCE);
    expect(h.mockBackend.toggleFavorite).not.toHaveBeenCalled();
    expect(h.mockBackend.remoteInstanceRequest.mock.calls).toEqual([
      [INSTANCE, "favorites:toggle", ["anthropic/claude"]],
    ]);
  });

  it("reports a rejected remote favorite toggle without falling back to the local backend", async () => {
    h.useStore.setState({ state: remoteState() });
    h.mockBackend.remoteInstanceRequest.mockRejectedValueOnce(
      new Error("favorites channel down"),
    );
    await h.useStore.getState().toggleFavorite("openai/gpt", INSTANCE);
    // The remote call was attempted and the rejection surfaced as a notice...
    expect(h.mockBackend.remoteInstanceRequest.mock.calls).toEqual([
      [INSTANCE, "favorites:toggle", ["openai/gpt"]],
    ]);
    expect(h.errorMessages()).toEqual([
      expect.stringContaining("favorites channel down"),
    ]);
    // ...but the local registry was never mutated as a fallback.
    expect(h.mockBackend.toggleFavorite).not.toHaveBeenCalled();
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
      worktreePath: null,
      cascade: [],
    });

    await h.useStore.getState().confirmDeleteSession(false);
    expect(h.mockBackend.deleteSession).toHaveBeenCalledWith(h.TAB, false);
    expect(h.mockBackend.deleteSession).toHaveBeenCalledWith(h.TAB, false);
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

    expect(h.mockBackend.deleteSession).toHaveBeenCalledWith(h.TAB, false);
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
    expect(h.errorMessages()).toEqual(["EBUSY"]);
  });

  it("marks a record whose files are gone without a file-erasure warning", async () => {
    h.useStore.setState({ state: h.stateWithRecord("sess-1", "missing") });
    await h.useStore.getState().deleteSession(h.TAB);

    expect(h.useStore.getState().deleteConfirmation?.hasFiles).toBe(false);
  });

  it("records the worktree branch, base, and path on the confirmation", async () => {
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
      worktreePath: "/wt",
      cascade: [],
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
    expect(h.mockBackend.deleteSession).toHaveBeenCalledWith(h.TAB, false);
  });

  it("always fetches the authoritative preview, even on the fast path", async () => {
    const state = h.stateWithRecord("sess-1", "dormant");
    state.skipDeleteConfirmation = true;
    h.useStore.setState({ state });

    await h.useStore.getState().deleteSession(h.TAB);

    expect(h.mockBackend.deleteSessionPreview).toHaveBeenCalledWith(h.TAB);
    expect(h.mockBackend.deleteSession).toHaveBeenCalledWith(h.TAB, false);
    expect(h.useStore.getState().deleteConfirmation).toBeNull();
  });

  it("erases the whole closure unasked when the skip flag is set", async () => {
    h.mockBackend.deleteSessionPreview.mockResolvedValueOnce({
      descendants: [
        { tabId: "child-1", title: "Impl one", running: false, worktree: false },
        { tabId: "child-2", title: "Impl two", running: true, worktree: false },
      ],
    });
    h.mockBackend.deleteSession.mockResolvedValueOnce({
      deleted: [h.TAB, "child-1", "child-2"],
      failed: [],
    });
    const state = h.stateWithRecord("sess-1", "live");
    state.skipDeleteConfirmation = true;
    h.useStore.setState({ state });

    await h.useStore.getState().deleteSession(h.TAB);

    expect(h.useStore.getState().deleteConfirmation).toBeNull();
    expect(h.mockBackend.deleteSession).toHaveBeenCalledWith(h.TAB, true);
  });

  it("stages the cascade confirmation when a descendant may run in a worktree", async () => {
    const state = h.stateWithRecord("sess-1", "live");
    state.skipDeleteConfirmation = true;
    h.useStore.setState({ state });

    h.mockBackend.deleteSessionPreview.mockResolvedValueOnce({
      descendants: [{ tabId: "child-1", title: "Impl one", running: false, worktree: true }],
    });
    await h.useStore.getState().deleteSession(h.TAB);
    expect(h.useStore.getState().deleteConfirmation?.cascade).toHaveLength(1);
    h.useStore.getState().cancelDeleteSession();

    // A remote instance on an older build omits the flag: unknown is not "no worktree".
    h.mockBackend.deleteSessionPreview.mockResolvedValueOnce({
      descendants: [{ tabId: "child-1", title: "Impl one", running: false } as PlanHandoffDescendant],
    });
    await h.useStore.getState().deleteSession(h.TAB);
    expect(h.useStore.getState().deleteConfirmation?.cascade).toHaveLength(1);

    expect(h.mockBackend.deleteSession).not.toHaveBeenCalled();
  });

  it("carries both the worktree fields and the cascade on the confirmation", async () => {
    h.mockBackend.deleteSessionPreview.mockResolvedValueOnce({
      descendants: [{ tabId: "child-1", title: "Impl one", running: false, worktree: false }],
    });
    const state = h.stateWithRecord("sess-1", "live");
    state.projects[0]!.sessions[0]!.worktree = {
      path: "/wt",
      branch: "omp-ui/abcd1234",
      base: "main",
    };
    h.useStore.setState({ state });

    await h.useStore.getState().deleteSession(h.TAB);

    expect(h.useStore.getState().deleteConfirmation).toMatchObject({
      worktreeBranch: "omp-ui/abcd1234",
      worktreeBase: "main",
      worktreePath: "/wt",
      cascade: [{ tabId: "child-1", title: "Impl one", running: false, worktree: false }],
    });
  });

  it("erases the root and every staged descendant on confirm", async () => {
    h.mockBackend.deleteSessionPreview.mockResolvedValueOnce({
      descendants: [{ tabId: "child-1", title: "Impl one", running: false, worktree: false }],
    });
    h.mockBackend.deleteSession.mockResolvedValueOnce({
      deleted: [h.TAB, "child-1"],
      failed: [],
    });
    h.useStore.setState({
      state: h.stateWithRecord("sess-1", "dormant"),
      tabs: [
        tabInfo({ tabId: h.TAB, mode: "rpc-ui", projectCwd: "/p", hidden: false }),
        tabInfo({ tabId: "child-1", mode: "rpc-ui", projectCwd: "/p", hidden: false }),
        tabInfo({ tabId: "other", mode: "pty", projectCwd: "/p", hidden: false }),
      ],
      activeTabId: h.TAB,
      exited: { [h.TAB]: 1, "child-1": 2 },
      rpc: { [h.TAB]: rpcTabState(), "child-1": rpcTabState() },
    });

    await h.useStore.getState().deleteSession(h.TAB);
    await h.useStore.getState().confirmDeleteSession(false);

    expect(h.mockBackend.deleteSession).toHaveBeenCalledWith(h.TAB, true);
    const st = h.useStore.getState();
    expect(st.tabs.map((t) => t.tabId)).toEqual(["other"]);
    expect(st.rpc[h.TAB]).toBeUndefined();
    expect(st.rpc["child-1"]).toBeUndefined();
    expect(st.exited[h.TAB]).toBeUndefined();
    expect(st.exited["child-1"]).toBeUndefined();
    expect(st.activeTabId).toBe("other");
  });

  it("removes successful cascade members and leaves failed tabs mounted", async () => {
    h.mockBackend.deleteSessionPreview.mockResolvedValueOnce({
      descendants: [{ tabId: "child-1", title: "Impl one", running: false, worktree: false }],
    });
    h.mockBackend.deleteSession.mockResolvedValueOnce({
      deleted: [h.TAB],
      failed: [{ tabId: "child-1", message: "EBUSY: transcript is busy" }],
    });
    h.useStore.setState({
      state: h.stateWithRecord("sess-1", "dormant"),
      tabs: [
        tabInfo({ tabId: h.TAB, mode: "rpc-ui", projectCwd: "/p", hidden: false }),
        tabInfo({ tabId: "child-1", mode: "rpc-ui", projectCwd: "/p", hidden: false }),
      ],
      activeTabId: h.TAB,
      exited: { [h.TAB]: 1, "child-1": 2 },
      rpc: { [h.TAB]: rpcTabState(), "child-1": rpcTabState() },
    });

    await h.useStore.getState().deleteSession(h.TAB);
    await h.useStore.getState().confirmDeleteSession(false);

    const state = h.useStore.getState();
    expect(state.tabs.map((tab) => tab.tabId)).toEqual(["child-1"]);
    expect(state.rpc[h.TAB]).toBeUndefined();
    expect(state.rpc["child-1"]).toBeDefined();
    expect(state.exited[h.TAB]).toBeUndefined();
    expect(state.exited["child-1"]).toBe(2);
    // The localized summary carries the backend's tabId: message list verbatim.
    expect(h.errorMessages()).toHaveLength(1);
    expect(h.errorMessages()[0]).toContain("child-1: EBUSY: transcript is busy");
  });

  it("surfaces a preview failure and stages nothing", async () => {
    h.mockBackend.deleteSessionPreview.mockRejectedValueOnce(new Error("boom"));
    h.useStore.setState({ state: h.stateWithRecord("sess-1", "dormant") });

    await h.useStore.getState().deleteSession(h.TAB);

    expect(h.useStore.getState().deleteConfirmation).toBeNull();
    expect(h.errorMessages()).toEqual(["boom"]);
    expect(h.mockBackend.deleteSession).not.toHaveBeenCalled();
  });
});

describe("releaseWorktreeSession (issue #334)", () => {
  const release = {
    worktreePath: "/wt/deadbeef",
    branch: "omp-ui/deadbeef",
    projectCwd: "/p",
    checkoutKept: null,
    branchOutcome: "removed",
    checkoutSwitch: { kind: "none" },
  } as const;

  /** A live rpc-ui worktree session and one sibling tab, as the chips see it. */
  const seed = (): void => {
    h.useStore.setState({
      state: h.stateWithRecord("sess-1", "live"),
      tabs: [
        tabInfo({ tabId: h.TAB, mode: "rpc-ui", projectCwd: "/p", hidden: false }),
        tabInfo({ tabId: "tab-2", mode: "rpc-ui", projectCwd: "/p", hidden: false }),
      ],
      activeTabId: h.TAB,
      rpc: { [h.TAB]: rpcTabState() },
    });
  };

  it("releases through the backend, forwards its branch options, and keeps the tab", async () => {
    const opts = { keepBranch: false, mergedInto: "main" } as const;
    h.mockBackend.releaseWorktree.mockResolvedValueOnce(release);
    seed();

    const result = await h.useStore.getState().releaseWorktreeSession(h.TAB, opts);

    expect(result).toEqual(release);
    // The caller's decision reaches main verbatim: keepBranch false plus the
    // destination just merged into, or main would delete an unmerged branch.
    expect(h.mockBackend.releaseWorktree).toHaveBeenCalledWith(h.TAB, opts);
    // The session survives: no delete, no cascade preview, no tab teardown.
    expect(h.mockBackend.deleteSession).not.toHaveBeenCalled();
    expect(h.mockBackend.deleteSessionPreview).not.toHaveBeenCalled();
    const st = h.useStore.getState();
    expect(st.tabs.map((t) => t.tabId)).toEqual([h.TAB, "tab-2"]);
    expect(st.rpc[h.TAB]).toBeDefined();
    expect(st.activeTabId).toBe(h.TAB);
  });

  it("refreshes the cached listing when the return switched the checkout (#431)", async () => {
    h.mockBackend.releaseWorktree.mockResolvedValueOnce({
      ...release,
      checkoutSwitch: { kind: "switched", branch: "release/next" },
    });
    seed();

    await h.useStore.getState().releaseWorktreeSession(h.TAB, {
      keepBranch: false,
      mergedInto: "release/next",
      checkoutOnReturn: "release/next",
    });

    // The project checkout's branch moved, so the listing the branch chip
    // renders is stale: the same local-refs refresh a branch switch does.
    expect(h.mockBackend.listBranches).toHaveBeenCalledWith("/p", { fetchUpstream: false });
  });

  it("leaves the listing alone when the return moved no branch", async () => {
    h.mockBackend.releaseWorktree.mockResolvedValueOnce(release);
    seed();

    const result = await h.useStore.getState().releaseWorktreeSession(h.TAB, {
      keepBranch: false,
      mergedInto: "main",
    });

    expect(result!.checkoutSwitch).toEqual({ kind: "none" });
    expect(h.mockBackend.listBranches).not.toHaveBeenCalled();
  });

  it("normalizes a checkoutSwitch an older remote instance never sent (#416)", async () => {
    // An older server answers with the result shape it knows, so the key is
    // simply absent. The notice path reads it plainly — the seam fills it in.
    h.mockBackend.releaseWorktree.mockResolvedValueOnce({
      worktreePath: "/wt/deadbeef",
      branch: "omp-ui/deadbeef",
      projectCwd: "/p",
      checkoutKept: null,
      branchOutcome: "removed",
    } as unknown as WorktreeReleaseResult);
    seed();

    const result = await h.useStore.getState().releaseWorktreeSession(h.TAB, {
      keepBranch: false,
      mergedInto: "main",
    });

    expect(result!.checkoutSwitch).toEqual({ kind: "none" });
    expect(h.mockBackend.listBranches).not.toHaveBeenCalled();
  });

  it("reports and resolves to null when main rejects, leaving the tab intact", async () => {
    h.mockBackend.releaseWorktree.mockRejectedValueOnce(
      new Error("the worktree has uncommitted changes — commit or discard them before returning"),
    );
    seed();

    const result = await h.useStore.getState().releaseWorktreeSession(h.TAB, {
      keepBranch: false,
      mergedInto: "main",
    });

    expect(result).toBeNull();
    expect(h.errorMessages()).toEqual([
      "the worktree has uncommitted changes — commit or discard them before returning",
    ]);
    const st = h.useStore.getState();
    expect(st.tabs.map((t) => t.tabId)).toEqual([h.TAB, "tab-2"]);
    expect(st.rpc[h.TAB]).toBeDefined();
  });
});

describe("syncWorktreeSession (issue #387)", () => {
  const synced: WorktreeSyncResult = { kind: "merged", source: "main", files: [] };

  it("syncs through the backend and hands the caller the result", async () => {
    h.mockBackend.syncWorktree.mockResolvedValueOnce(synced);

    const result = await h.useStore.getState().syncWorktreeSession(h.TAB, "main");

    expect(result).toEqual(synced);
    expect(h.mockBackend.syncWorktree).toHaveBeenCalledWith(h.TAB, "main");
    expect(h.errorMessages()).toEqual([]);
  });

  it("reports and resolves to null when main rejects the sync", async () => {
    h.mockBackend.syncWorktree.mockRejectedValueOnce(
      new Error("commit or discard the worktree's changes before syncing"),
    );

    const result = await h.useStore.getState().syncWorktreeSession(h.TAB, "main");

    expect(result).toBeNull();
    expect(h.errorMessages()).toEqual([
      "commit or discard the worktree's changes before syncing",
    ]);
  });
});

describe("renameWorktreeSessionBranch (issue #389)", () => {
  it("renames through the backend and reports success", async () => {
    const ok = await h.useStore
      .getState()
      .renameWorktreeSessionBranch(h.TAB, "feat/renamed");

    expect(ok).toBe(true);
    expect(h.mockBackend.renameWorktreeBranch).toHaveBeenCalledWith(
      h.TAB,
      "feat/renamed",
    );
    expect(h.errorMessages()).toEqual([]);
  });

  it("reports and resolves to false when the target name is taken", async () => {
    h.mockBackend.renameWorktreeBranch.mockRejectedValueOnce(
      new Error("fatal: a branch named 'feat/renamed' already exists"),
    );

    const ok = await h.useStore
      .getState()
      .renameWorktreeSessionBranch(h.TAB, "feat/renamed");

    expect(ok).toBe(false);
    expect(h.errorMessages()).toEqual([
      "fatal: a branch named 'feat/renamed' already exists",
    ]);
  });
});

describe("convertSessionToWorktree (issue #225)", () => {
  it("converts via the backend channel and rethrows failures", async () => {
    await h.useStore
      .getState()
      .convertSessionToWorktree(h.TAB, { branch: "omp-ui/abcd1234", baseRef: "main", baseBranch: null });
    expect(h.mockBackend.convertToWorktree).toHaveBeenCalledWith(h.TAB, "omp-ui/abcd1234", "main", null);

    h.mockBackend.convertToWorktree.mockRejectedValueOnce(new Error("branch already exists"));
    await expect(
      h.useStore
        .getState()
        .convertSessionToWorktree(h.TAB, { branch: "omp-ui/abcd1234", baseRef: null, baseBranch: null }),
    ).rejects.toThrow("branch already exists");
  });
});

describe("newWorktreeSession (issue #225, #390)", () => {
  /** A registered project, no mounted tabs, and a spawn that always lands. */
  const seed = (): void => {
    h.backendState = h.stateWithRecord("sess-1");
    h.useStore.setState({
      state: h.backendState,
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });
    h.mockBackend.spawnSession.mockResolvedValue({ tabId: "wt-1" });
  };

  it("mints a branch off its base and mounts the spawned tab", async () => {
    seed();

    await h.useStore.getState().newWorktreeSession("/p", {
      mint: { branch: "omp-ui/deadbeef", baseRef: "main", baseBranch: null },
    });

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: null,
      cols: 80,
      rows: 24,
      worktree: { mint: { branch: "omp-ui/deadbeef", baseRef: "main", baseBranch: null } },
    });
    const st = h.useStore.getState();
    expect(st.tabs.map((t) => t.tabId)).toEqual(["wt-1"]);
    expect(st.activeTabId).toBe("wt-1");
  });

  it("checks out an existing branch instead of minting one", async () => {
    seed();

    await h.useStore.getState().newWorktreeSession("/p", {
      checkout: { branch: "feat/existing" },
    });

    // The discriminated spec reaches main verbatim; a checkout must never
    // carry a mint (main would create a second branch of that name).
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        worktree: { checkout: { branch: "feat/existing" } },
      }),
    );
  });
});

describe("newSession fetches the project's upstream listing (issue #708)", () => {
  /** A registered project and a spawn that lands with a fresh tab. */
  const seed = (): void => {
    h.backendState = h.stateWithRecord("sess-1");
    h.useStore.setState({
      state: h.backendState,
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });
    h.mockBackend.spawnSession.mockResolvedValue({ tabId: "fresh" });
  };

  it("fires one network refresh after a successful spawn", async () => {
    seed();

    await h.useStore.getState().newSession("/p");
    await h.flushMicrotasks();

    expect(h.mockBackend.listBranches).toHaveBeenCalledTimes(1);
    expect(h.mockBackend.listBranches).toHaveBeenCalledWith("/p", { fetchUpstream: true });
  });

  it("fetches nothing when the spawn fails", async () => {
    seed();
    h.mockBackend.spawnSession.mockRejectedValueOnce(new Error("pty spawn failed"));

    await h.useStore.getState().newSession("/p");
    await h.flushMicrotasks();

    expect(h.mockBackend.listBranches).not.toHaveBeenCalled();
  });

  it("lands the tab without waiting for the listing", async () => {
    seed();
    const listing = h.deferred<never>();
    h.mockBackend.listBranches.mockReturnValue(listing.promise);

    await h.useStore.getState().newSession("/p");

    // The refresh is fire-and-forget after the set: a slow remote must never
    // delay the tab landing, so the tab is present while the fetch is pending.
    const st = h.useStore.getState();
    expect(st.tabs.map((t) => t.tabId)).toEqual(["fresh"]);
    expect(st.activeTabId).toBe("fresh");
    expect(h.mockBackend.listBranches).toHaveBeenCalledWith("/p", { fetchUpstream: true });
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
            browserClock: false,
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
    planImplementationSource: null, experiment: null,
    agentMode: "build" as const,
    compactionMethod: null,
    approvalMode: null,
    serviceTier: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null, subagentModels: null,
 proposedPlans: [],
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
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: null,
      cols: 80,
      rows: 24,
      worktree: null,
    });
  });

  it("openSession on a dormant record resumes and records focus", async () => {
    h.backendState = projectState([rec(h.TAB, "dormant")]);
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: h.TAB });
    h.useStore.setState({ state: h.backendState });

    await h.useStore.getState().openSession(h.TAB);

    const st = h.useStore.getState();
    expect(st.focusedTabByProject["/p"]).toBe(h.TAB);
    expect(st.activeTabId).toBe(h.TAB);
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "resume",
      resumeTabId: h.TAB,
      cols: 80,
      rows: 24,
    });
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
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "resume",
      resumeTabId: h.TAB,
      cols: 80,
      rows: 24,
    });
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
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "resume",
      resumeTabId: h.TAB,
      cols: 80,
      rows: 24,
    });
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
    planImplementationSource: null, experiment: null,
    agentMode: "build" as const,
    compactionMethod: null,
    approvalMode: null,
    serviceTier: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null, subagentModels: null,
 proposedPlans: [],
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
            browserClock: false,
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

    expect(h.mockBackend.deleteSession).toHaveBeenCalledWith(h.TAB, false);
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

describe("spawnGitResolution (issue #675)", () => {
  const FRESH = "resolve-1";
  const diverged = {
    kind: "diverged" as const,
    branch: "main",
    upstream: "origin/main",
    cwd: "/p",
  };

  /** Registered local project "/p"; the spawn lands on FRESH. */
  function seedSpawn(): void {
    h.backendState = h.stateWithRecord("sess-1", "dormant");
    h.useStore.setState({
      state: h.backendState,
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });
    h.mockBackend.spawnSession.mockResolvedValue({ tabId: FRESH });
  }

  /** Answers every command sent so far, returning the prompt messages. */
  function answerSent(): string[] {
    const prompts: string[] = [];
    for (const { tabId, cmd } of h.sent.splice(0)) {
      h.respond(tabId, cmd, {});
      if (cmd.type === "prompt") prompts.push(String(cmd.message));
    }
    return prompts;
  }

  it("spawns in the project checkout and seeds the playbook once the boot reports ready", async () => {
    seedSpawn();
    const launch = h.useStore.getState().spawnGitResolution("/p", diverged);
    await h.flushMicrotasks();

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: null,
      cols: 80,
      rows: 24,
      planMode: false,
      worktree: null,
    });
    const mounted = h.useStore.getState();
    expect(mounted.tabs.map((tab) => tab.tabId)).toEqual([FRESH]);
    expect(mounted.activeTabId).toBe(FRESH);
    // Nothing goes to omp before the process reports ready.
    expect(h.sent).toEqual([]);

    h.useStore.setState({ rpc: { [FRESH]: rpcTabState() } });
    await h.flushMicrotasks();
    const seeded = answerSent();
    expect(seeded).toHaveLength(1);
    expect(await launch).toBe(true);
    expect(h.sent).toEqual([]);
  });

  it("reuses the checkout's worktree and spawns under its registered project", async () => {
    const wt = { path: "/p/.omp-ui/wt/abc", branch: "wt/abc", base: "main" };
    h.backendState = h.stateWithRecord("sess-1", "dormant", wt);
    h.useStore.setState({
      state: h.backendState,
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });
    h.mockBackend.spawnSession.mockResolvedValue({ tabId: FRESH });

    const launch = h.useStore.getState().spawnGitResolution(wt.path, {
      kind: "merge",
      branch: wt.branch,
      cwd: wt.path,
    });
    await h.flushMicrotasks();
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ projectCwd: "/p", worktree: { reuse: wt } }),
    );

    h.useStore.setState({ rpc: { [FRESH]: rpcTabState() } });
    await h.flushMicrotasks();
    const seeded = answerSent();
    expect(seeded).toHaveLength(1);
    expect(await launch).toBe(true);
  });

  it("reports a rejected spawn and mounts no tab", async () => {
    seedSpawn();
    h.mockBackend.spawnSession.mockRejectedValueOnce(
      new Error("no model provider configured"),
    );
    expect(await h.useStore.getState().spawnGitResolution("/p", diverged)).toBe(false);
    expect(h.useStore.getState().tabs).toEqual([]);
    expect(h.errorMessages()).toEqual([
      expect.stringContaining("no model provider configured"),
    ]);
    expect(h.sent).toEqual([]);
  });

  it("sends nothing when the boot exits before ready", async () => {
    seedSpawn();
    const launch = h.useStore.getState().spawnGitResolution("/p", diverged);
    await h.flushMicrotasks();
    h.useStore.setState({ exited: { [FRESH]: 1 } });
    expect(await launch).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.errorMessages()).toEqual([]);
  });

  it("reports a boot that never finishes starting and sends nothing", async () => {
    vi.useFakeTimers();
    try {
      seedSpawn();
      const launch = h.useStore.getState().spawnGitResolution("/p", diverged);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await launch).toBe(false);
      expect(h.sent).toEqual([]);
      expect(h.errorMessages().join("\n")).toContain("never finished starting");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([null, "same-path-host"])("reuses only the explicitly addressed instance's identical worktree path (%s)", async (instanceId) => {
    const path = "/shared/worktree";
    const localTree = { path, branch: "wt/local", base: "main" };
    const remoteTree = { path, branch: "wt/remote", base: "main" };
    const local = h.stateWithRecord("local", "dormant", localTree).projects[0]!;
    const remote = h.stateWithRecord("remote", "dormant", remoteTree).projects[0]!;
    local.project = { ...local.project, path: "/local" };
    local.sessions = [{ ...local.sessions[0]!, projectCwd: "/local" }];
    remote.project = { ...remote.project, path: "/remote" };
    remote.sessions = [{ ...remote.sessions[0]!, tabId: "remote-source", projectCwd: "/remote" }];
    h.useStore.setState({ state: makeBackendState({ projects: [local], remoteInstances: [remoteInstance({ id: "same-path-host", projects: [remote] })] }), advisorDefaults: {} });
    h.mockBackend.spawnSession.mockResolvedValue({ tabId: FRESH });
    h.mockBackend.remoteInstanceRequest.mockImplementation(async (_id, channel) =>
      channel === "session:spawn" ? { tabId: FRESH } : { enabled: false, model: null },
    );
    const launch = h.useStore.getState().spawnGitResolution("/requested", { kind: "merge", branch: null, cwd: path }, instanceId);
    await h.flushMicrotasks();
    const spawn = expect.objectContaining({ projectCwd: instanceId === null ? "/local" : "/remote", worktree: { reuse: instanceId === null ? localTree : remoteTree } });
    if (instanceId === null) {
      expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(spawn);
      expect(h.mockBackend.remoteInstanceRequest).not.toHaveBeenCalled();
    } else {
      expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
      expect(h.mockBackend.remoteInstanceRequest).toHaveBeenCalledWith(instanceId, "session:spawn", [spawn]);
    }
    expect(h.useStore.getState().tabs[0]!.instanceId).toBe(instanceId);
    h.useStore.setState({ rpc: { [FRESH]: rpcTabState() } });
    await h.flushMicrotasks();
    answerSent();
    expect(await launch).toBe(true);
  });

  it("an omitted instance stays local even when only a remote worktree owns the matching path", async () => {
    const remote = h.stateWithRecord("remote", "dormant", { path: "/p", branch: "wt/remote", base: "main" }).projects[0]!;
    h.useStore.setState({ state: makeBackendState({ remoteInstances: [remoteInstance({ projects: [remote] })] }), advisorDefaults: {} });
    h.mockBackend.spawnSession.mockResolvedValue({ tabId: FRESH });
    const launch = h.useStore.getState().spawnGitResolution("/p", diverged);
    await h.flushMicrotasks();
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(expect.objectContaining({ projectCwd: "/p", worktree: null }));
    expect(h.mockBackend.remoteInstanceRequest).not.toHaveBeenCalled();
    h.useStore.setState({ rpc: { [FRESH]: rpcTabState() } });
    await h.flushMicrotasks();
    answerSent();
    expect(await launch).toBe(true);
  });

  it("waits for fresh boot commands to settle before sending the resolution seed", async () => {
    seedSpawn();
    const launch = h.useStore.getState().spawnGitResolution("/p", diverged);
    await h.flushMicrotasks();
    h.useStore.setState({ rpc: { [FRESH]: rpcTabState({ busy: true }) } });
    await h.flushMicrotasks();
    expect(h.sent).toEqual([]);
    h.useStore.setState({ rpc: { [FRESH]: rpcTabState({ busy: false }) } });
    await h.flushMicrotasks();
    answerSent();
    expect(await launch).toBe(true);
  });

  it("returns false on a rejected ready seed and retains the visible native tab failure", async () => {
    seedSpawn();
    const launch = h.useStore.getState().spawnGitResolution("/p", diverged);
    await h.flushMicrotasks();
    h.useStore.setState({ rpc: { [FRESH]: rpcTabState() } });
    await h.flushMicrotasks();
    for (const entry of h.sent.splice(0)) {
      h.respond(entry.tabId, entry.cmd, entry.cmd.type === "prompt" ? "seed rejected" : {}, entry.cmd.type !== "prompt");
    }
    expect(await launch).toBe(false);
    expect(h.useStore.getState().activeTabId).toBe(FRESH);
    expect(h.useStore.getState().rpc[FRESH]!.failure!.message).toContain("seed rejected");
  });

  it("returns false for a boot failure without hiding its failure banner", async () => {
    seedSpawn();
    const launch = h.useStore.getState().spawnGitResolution("/p", diverged);
    await h.flushMicrotasks();
    const failure: RpcTabState["failure"] = { kind: "boot", fatal: true, message: "boot failed", recovery: "retry" };
    h.useStore.setState({ rpc: { [FRESH]: rpcTabState({ status: "error", failure }) } });
    expect(await launch).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.useStore.getState().rpc[FRESH]!.failure).toBe(failure);
  });
});

describe("Finish worktree agent resolution (issue #727)", () => {
  const FRESH = "finish-resolve";
  const INSTANCE = "resolution-host";
  const worktree = { path: "/p/.omp-ui/wt/original", branch: "wt/original", base: "main" };
  const trigger = {
    kind: "merge" as const,
    branch: "main",
    cwd: "/p",
    finish: { sourceBranch: worktree.branch, destinationBranch: "main", files: ["src/conflict.ts"] },
  };

  function seedSource(
    patch: Partial<SessionSummary> = {},
    instanceId: string | null = null,
    mounted = true,
    rpc: Partial<RpcTabState> = {},
  ): SessionSummary {
    const state = h.stateWithRecord("original-session", "live", worktree);
    const project = state.projects[0]!;
    const record = { ...project.sessions[0]!, ...patch };
    project.sessions = [record];
    h.backendState = instanceId === null ? state : {
      ...state,
      projects: [],
      remoteInstances: [remoteInstance({ id: instanceId, projects: [project] })],
    };
    h.useStore.setState({
      state: h.backendState,
      tabs: mounted ? [tabInfo({ tabId: h.TAB, projectCwd: "/p", mode: record.mode, instanceId, hidden: true })] : [],
      rpc: record.mode === "rpc-ui" ? { [h.TAB]: rpcTabState({ initialPrompt: "Original worktree task", ...rpc }) } : {},
      activeTabId: null,
      handedOffFor: {},
      observedPlanHandoffs: {},
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });
    h.mockBackend.spawnSession.mockResolvedValue({ tabId: FRESH });
    h.mockBackend.remoteInstanceRequest.mockImplementation(async (_id, channel) =>
      channel === "session:spawn" ? { tabId: FRESH } : { enabled: false, model: null },
    );
    return record;
  }

  function changeRecord(patch: Partial<SessionSummary>): void {
    const state = h.useStore.getState().state!;
    const update = (project: BackendState["projects"][number]) => ({
      ...project,
      sessions: project.sessions.map((record) => record.tabId === h.TAB ? { ...record, ...patch } : record),
    });
    h.useStore.setState({ state: {
      ...state,
      projects: state.projects.map(update),
      remoteInstances: state.remoteInstances.map((instance) => ({ ...instance, projects: instance.projects.map(update) })),
    } });
  }

  function changeRpc(patch: Partial<RpcTabState>): void {
    h.useStore.setState((state) => ({ rpc: { ...state.rpc, [h.TAB]: { ...state.rpc[h.TAB]!, ...patch } } }));
  }

  function publishPlan(enabled: boolean): void {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request", id: `plan-${enabled}`, method: "setStatus",
      statusKey: PLAN_STATUS_KEY,
      statusText: JSON.stringify({ enabled, planFilePath: null, planAbsPath: null, approved: false }),
    });
  }

  function acknowledgePrompt(success = true): string {
    let entry = h.sent.shift()!;
    while (entry.cmd.type !== "prompt") {
      h.respond(entry.tabId, entry.cmd, {});
      entry = h.sent.shift()!;
    }
    h.respond(entry.tabId, entry.cmd, success ? {} : "prompt refused", success);
    return String(entry.cmd.message);
  }

  function addTarget(instanceId: string | null, running = true, inWorktree = false, native = true): void {
    const state = h.useStore.getState().state!;
    const project = h.stateWithRecord("target-session").projects[0]!;
    project.sessions = [{ ...project.sessions[0]!, tabId: "target", title: "Target worker", mode: native ? "rpc-ui" : "pty", worktree: inWorktree ? { path: "/other-checkout", branch: "wt/other", base: "main" } : null }];
    h.useStore.setState((s) => ({
      state: {
        ...state,
        projects: instanceId === null ? [...state.projects, project] : state.projects,
        remoteInstances: instanceId === null ? state.remoteInstances :
          state.remoteInstances.some((instance) => instance.id === instanceId)
            ? state.remoteInstances.map((instance) => instance.id === instanceId
              ? { ...instance, projects: [...instance.projects, project] } : instance)
            : [...state.remoteInstances, remoteInstance({ id: instanceId, projects: [project] })],
      },
      tabs: [...s.tabs, tabInfo({ tabId: "target", projectCwd: "/p", instanceId, mode: native ? "rpc-ui" : "pty" })],
      rpc: { ...s.rpc, target: rpcTabState({ status: running ? "running" : "ready" }) },
    }));
  }

  it("prompts and focuses the original native session despite its different effective cwd, without spawning or handing off", async () => {
    const record = seedSource();
    const items = h.useStore.getState().rpc[h.TAB]!.items;
    const pending = h.useStore.getState().resolveWorktreeMerge(h.TAB, trigger, "current");
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]!.tabId).toBe(h.TAB);
    expect(h.useStore.getState().activeTabId).toBeNull();
    const prompt = acknowledgePrompt();
    expect(prompt).toContain("/p");
    expect(prompt).toContain("wt/original");
    expect(await pending).toBe(true);
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
    expect(h.mockBackend.hibernatePlanSource).not.toHaveBeenCalled();
    const state = h.useStore.getState();
    expect(state.activeTabId).toBe(h.TAB);
    expect(state.tabs[0]!.hidden).toBe(false);
    expect(state.state!.projects[0]!.sessions[0]).toBe(record);
    expect(state.rpc[h.TAB]!.items).toBe(items);
    expect(state.handedOffFor).toEqual({});
    expect(state.observedPlanHandoffs).toEqual({});
  });

  it("waits for the published Build acknowledgment and command completion before prompting", async () => {
    seedSource();
    publishPlan(true);
    const pending = h.useStore.getState().resolveWorktreeMerge(h.TAB, trigger, "current");
    expect(acknowledgePrompt()).toBe("/omp-ui-plan off");
    await h.flushMicrotasks();
    expect(h.sent).toEqual([]);
    expect(h.useStore.getState().rpc[h.TAB]!.plan!.enabled).toBe(true);
    publishPlan(false);
    await h.flushMicrotasks();
    expect(h.sent).toHaveLength(1);
    acknowledgePrompt();
    expect(await pending).toBe(true);
  });

  it("requires a new Build publication when the owning record is Plan but the renderer has a stale Build snapshot", async () => {
    seedSource({ agentMode: "plan" });
    publishPlan(false);
    const pending = h.useStore.getState().resolveWorktreeMerge(h.TAB, trigger, "current");
    expect(acknowledgePrompt()).toBe("/omp-ui-plan off");
    await h.flushMicrotasks();
    expect(h.sent).toEqual([]);
    publishPlan(false);
    await h.flushMicrotasks();
    acknowledgePrompt();
    expect(await pending).toBe(true);
  });

  it("sends no resolution when a stale Build snapshot never receives a fresh acknowledgment", async () => {
    vi.useFakeTimers();
    try {
      seedSource({ agentMode: "plan" });
      publishPlan(false);
      const pending = h.useStore.getState().resolveWorktreeMerge(h.TAB, trigger, "current");
      acknowledgePrompt();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toBe(false);
      expect(h.sent).toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it("does not prompt when Build is published while the mode command is still in flight", async () => {
    seedSource();
    publishPlan(true);
    const pending = h.useStore.getState().resolveWorktreeMerge(h.TAB, trigger, "current");
    const mode = h.sent.shift()!;
    publishPlan(false);
    await h.flushMicrotasks();
    expect(h.sent).toEqual([]);
    h.respond(mode.tabId, mode.cmd, {});
    await h.flushMicrotasks();
    acknowledgePrompt();
    expect(await pending).toBe(true);
  });

  it("times out after five seconds without a Build publication and sends no resolution", async () => {
    vi.useFakeTimers();
    try {
      seedSource();
      publishPlan(true);
      const pending = h.useStore.getState().resolveWorktreeMerge(h.TAB, trigger, "current");
      acknowledgePrompt();
      await vi.advanceTimersByTimeAsync(4_999);
      expect(h.sent).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      expect(await pending).toBe(false);
      expect(h.sent).toEqual([]);
      expect(h.useStore.getState().rpc[h.TAB]!.plan!.enabled).toBe(true);
      expect(h.errorMessages()).not.toEqual([]);
    } finally { vi.useRealTimers(); }
  });

  it.each(["exit", "dormant", "record", "worktree", "owner"])("rejects a changed original during the Build wait (%s)", async (change) => {
    seedSource();
    publishPlan(true);
    const pending = h.useStore.getState().resolveWorktreeMerge(h.TAB, trigger, "current");
    acknowledgePrompt();
    if (change === "exit") h.useStore.setState({ exited: { [h.TAB]: 0 } });
    if (change === "dormant") changeRecord({ live: "dormant" });
    if (change === "record") changeRecord({ sessionId: "successor-session" });
    if (change === "worktree") changeRecord({ worktree: null });
    if (change === "owner") {
      const state = h.useStore.getState().state!;
      h.useStore.setState({ state: { ...state, projects: [], remoteInstances: [remoteInstance({ id: INSTANCE, projects: state.projects })] } });
    }
    expect(await pending).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
  });

  const blockers: Array<[string, Partial<SessionSummary>, Partial<RpcTabState>]> = [
    ["main pending plan", { pendingPlan: { title: "Pending plan", planFilePath: "local://plan.md", planAbsPath: null, frameId: "pending", proposedAt: "t" } }, {}],
    ["main human answer", { awaitingHumanAnswer: true }, {}],
    ["plan review", {}, { planReview: { request: { title: "review", planFilePath: "local://plan.md", planAbsPath: null }, frame: { id: "review" } } }],
    ["tool approval", {}, { approvalPrompt: { frame: { id: "approval" } } as RpcTabState["approvalPrompt"] }],
    ["experiment proposal", {}, { experimentProposal: { frame: { id: "proposal" } } as RpcTabState["experimentProposal"] }],
    ["extension dialog", {}, { extensionQueue: [{ id: "dialog", method: "select" }] }],
    ["running", {}, { status: "running" }],
    ["starting", {}, { status: "starting" }],
    ["failed process", {}, { status: "error" }],
    ["in-flight command", {}, { busy: true }],
    ["admission blocked", {}, { commandAdmissionBlocked: true }],
    ["compaction", {}, { compacting: { startedAt: 1 } }],
    ["streaming", {}, { session: { ...rpcTabState().session, isStreaming: true } }],
    ["automatic compaction", {}, { session: { ...rpcTabState().session, isCompacting: true } }],
    ["queued turn", {}, { session: { ...rpcTabState().session, queuedMessageCount: 1 } }],
  ];

  it.each(blockers)("refuses %s without answering or dispatching", async (_name, recordPatch, rpcPatch) => {
    seedSource(recordPatch, null, true, rpcPatch);
    expect(worktreeMergeResolutionState(h.useStore.getState(), h.TAB)!.blockedReason).not.toBeNull();
    expect(await h.useStore.getState().resolveWorktreeMerge(h.TAB, trigger, "current")).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
  });

  it.each(blockers)("rechecks %s immediately after Build acknowledgment", async (_name, recordPatch, rpcPatch) => {
    seedSource();
    publishPlan(true);
    const pending = h.useStore.getState().resolveWorktreeMerge(h.TAB, trigger, "current");
    acknowledgePrompt();
    changeRecord(recordPatch);
    changeRpc(rpcPatch);
    publishPlan(false);
    // A busy command cannot settle the mode subscription: stop the wait by
    // changing the record, and still assert that no prompt was sent.
    if (rpcPatch.busy) changeRecord({ sessionId: "changed-while-busy" });
    expect(await pending).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it.each([
    [null, "terminal"], [null, "dormant"], [null, "exited"],
    [INSTANCE, "terminal"], [INSTANCE, "dormant"], [INSTANCE, "exited"],
  ] as const)("launches a native Build project resolution for %s / %s, without worktree or handoff", async (instanceId, source) => {
    seedSource({ mode: source === "terminal" ? "pty" : "rpc-ui", live: source === "dormant" ? "dormant" : "live" }, instanceId, source !== "dormant");
    if (source === "exited") h.useStore.setState({ exited: { [h.TAB]: 0 } });
    expect(worktreeMergeResolutionState(h.useStore.getState(), h.TAB)).toEqual({ route: "fresh", blockedReason: null });
    const pending = h.useStore.getState().resolveWorktreeMerge(h.TAB, trigger, "fresh");
    await h.flushMicrotasks();
    const spawn = expect.objectContaining({ origin: "new", projectCwd: "/p", mode: "rpc-ui", planMode: false, worktree: null });
    if (instanceId === null) expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(spawn);
    else {
      expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
      expect(h.mockBackend.remoteInstanceRequest).toHaveBeenCalledWith(instanceId, "session:spawn", [spawn]);
    }
    const mounted = h.useStore.getState().tabs.find((tab) => tab.tabId === FRESH)!;
    expect(mounted).toEqual(expect.objectContaining({ mode: "rpc-ui", projectCwd: "/p", instanceId }));
    h.useStore.setState((state) => ({ rpc: { ...state.rpc, [FRESH]: rpcTabState() } }));
    await h.flushMicrotasks();
    expect(h.sent[0]!.tabId).toBe(FRESH);
    acknowledgePrompt();
    expect(await pending).toBe(true);
    expect(h.useStore.getState().handedOffFor).toEqual({});
    expect(h.mockBackend.hibernatePlanSource).not.toHaveBeenCalled();
    expect(h.mockBackend.switchMode).not.toHaveBeenCalled();
  });

  it.each([["current", null], ["fresh", null], ["current", INSTANCE], ["fresh", INSTANCE]] as const)("blocks a same-owner project-checkout worker on the %s route / %s instance", async (route, instanceId) => {
    seedSource({ live: route === "fresh" ? "dormant" : "live" }, instanceId);
    addTarget(instanceId);
    expect(worktreeMergeResolutionState(h.useStore.getState(), h.TAB)!.blockedReason).toContain("Target worker");
    expect(await h.useStore.getState().resolveWorktreeMerge(h.TAB, trigger, route)).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
    expect(h.mockBackend.remoteInstanceRequest).not.toHaveBeenCalled();
  });

  it.each(["remote", "local", "worktree", "idle", "terminal"])("does not block an unrelated target (%s)", async (target) => {
    seedSource({}, target === "local" ? INSTANCE : null);
    addTarget(target === "remote" ? INSTANCE : null, target !== "idle", target === "worktree", target !== "terminal");
    expect(worktreeMergeResolutionState(h.useStore.getState(), h.TAB)!.blockedReason).toBeNull();
    const pending = h.useStore.getState().resolveWorktreeMerge(h.TAB, trigger, "current");
    expect(h.sent[0]!.tabId).toBe(h.TAB);
    acknowledgePrompt();
    expect(await pending).toBe(true);
  });

  it("rechecks a newly running target after Build acknowledgment", async () => {
    seedSource();
    publishPlan(true);
    const pending = h.useStore.getState().resolveWorktreeMerge(h.TAB, trigger, "current");
    acknowledgePrompt();
    addTarget(null);
    publishPlan(false);
    expect(await pending).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it.each(["current-to-fresh", "fresh-to-current", "wrong-cwd", "missing-worktree", "missing-record", "wrong-instance"])("rejects stale Finish dispatch (%s)", async (stale) => {
    seedSource({ live: stale === "fresh-to-current" ? "dormant" : "live" });
    const route = stale === "fresh-to-current" ? "current" : stale === "current-to-fresh" ? "fresh" : "current";
    if (stale === "missing-worktree") changeRecord({ worktree: null });
    if (stale === "missing-record") h.useStore.setState({ state: makeBackendState() });
    if (stale === "wrong-instance") h.useStore.setState({ tabs: [tabInfo({ tabId: h.TAB, projectCwd: "/p", instanceId: INSTANCE })] });
    expect(await h.useStore.getState().resolveWorktreeMerge(h.TAB, stale === "wrong-cwd" ? { ...trigger, cwd: worktree.path } : trigger, route)).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
  });

  it.each(["record", "route", "target"])("keeps the fresh tab visible but sends no seed when the source becomes unsafe (%s)", async (change) => {
    seedSource({ live: "dormant" });
    const pending = h.useStore.getState().resolveWorktreeMerge(h.TAB, trigger, "fresh");
    await h.flushMicrotasks();
    if (change === "record") changeRecord({ sessionId: "different-session" });
    if (change === "route") changeRecord({ live: "live" });
    if (change === "target") addTarget(null);
    h.useStore.setState((state) => ({ rpc: { ...state.rpc, [FRESH]: rpcTabState() } }));
    expect(await pending).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.useStore.getState().activeTabId).toBe(FRESH);
    expect(h.useStore.getState().rpc[FRESH]!.items).not.toEqual([]);
  });

  it("rechecks the fresh route after asynchronous spawn parameters before creating a process", async () => {
    seedSource({ live: "dormant" });
    const defaults = h.deferred<{ enabled: boolean; model: null }>();
    h.mockBackend.getAdvisorDefaults.mockReturnValueOnce(defaults.promise);
    h.useStore.setState({ advisorDefaults: {} });
    const pending = h.useStore.getState().resolveWorktreeMerge(h.TAB, trigger, "fresh");
    changeRecord({ worktree: null });
    defaults.resolve({ enabled: false, model: null });
    expect(await pending).toBe(false);
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
  });

  it.each(["current", "fresh"] as const)("returns false when the %s prompt is refused and leaves a retryable failure", async (route) => {
    seedSource({ live: route === "fresh" ? "dormant" : "live" });
    const pending = h.useStore.getState().resolveWorktreeMerge(h.TAB, trigger, route);
    if (route === "fresh") {
      await h.flushMicrotasks();
      h.useStore.setState((state) => ({ rpc: { ...state.rpc, [FRESH]: rpcTabState() } }));
      await h.flushMicrotasks();
    }
    acknowledgePrompt(false);
    expect(await pending).toBe(false);
    const state = h.useStore.getState();
    expect(state.rpc[route === "current" ? h.TAB : FRESH]!.failure!.message).toContain("prompt refused");
    expect(state.activeTabId).toBe(route === "current" ? null : FRESH);
    expect(state.handedOffFor).toEqual({});
  });

  it.each(["admission", "answer", "plan", "streaming", "compaction", "exit"])("does not seed a fresh resolution process that becomes unsafe (%s)", async (blocker) => {
    seedSource({ live: "dormant" });
    const pending = h.useStore.getState().resolveWorktreeMerge(h.TAB, trigger, "fresh");
    await h.flushMicrotasks();
    const fresh = rpcTabState();
    if (blocker === "admission") fresh.commandAdmissionBlocked = true;
    if (blocker === "answer") fresh.extensionQueue = [{ id: "pending-answer" }];
    if (blocker === "plan") fresh.plan = { enabled: true, planFilePath: null, planAbsPath: null, approved: false };
    if (blocker === "streaming") fresh.session.isStreaming = true;
    if (blocker === "compaction") fresh.compacting = { startedAt: 1 };
    h.useStore.setState((state) => ({ rpc: { ...state.rpc, [FRESH]: fresh }, exited: blocker === "exit" ? { [FRESH]: 0 } : state.exited }));
    expect(await pending).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.useStore.getState().activeTabId).toBe(FRESH);
  });

  it.each(["starting", "error"] as const)("never replaces the mounted native original when its %s process precedes the live summary", async (status) => {
    seedSource({ live: "dormant" }, null, true, { status });
    expect(worktreeMergeResolutionState(h.useStore.getState(), h.TAB)).toEqual({ route: "current", blockedReason: expect.any(String) });
    expect(await h.useStore.getState().resolveWorktreeMerge(h.TAB, trigger, "current")).toBe(false);
    expect(await h.useStore.getState().resolveWorktreeMerge(h.TAB, trigger, "fresh")).toBe(false);
    expect(h.sent).toEqual([]);
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
  });

  it("bounds the Build wait even when the plan-mode command never acknowledges", async () => {
    vi.useFakeTimers();
    try {
      seedSource();
      publishPlan(true);
      const pending = h.useStore.getState().resolveWorktreeMerge(h.TAB, trigger, "current");
      const mode = h.sent.shift()!;
      expect(mode.cmd.message).toBe("/omp-ui-plan off");
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toBe(false);
      expect(h.sent).toEqual([]);
      h.respond(mode.tabId, mode.cmd, {});
      await h.flushMicrotasks();
    } finally { vi.useRealTimers(); }
  });

  it("never treats a missing plan snapshot as acknowledgment after explicitly exiting Plan", async () => {
    vi.useFakeTimers();
    try {
      seedSource();
      publishPlan(true);
      const pending = h.useStore.getState().resolveWorktreeMerge(h.TAB, trigger, "current");
      acknowledgePrompt();
      changeRpc({ plan: null });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await pending).toBe(false);
      expect(h.sent).toEqual([]);
    } finally { vi.useRealTimers(); }
  });
});
