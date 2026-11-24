// The routines slice's review-link focus (ADR-0100 amendment): a transcript
// omp-ui://routine/<id> click opens the full-pane view and carries the id for
// RoutinesView to pick, gated by routinesEnabled like openRoutines itself.
import { describe, expect, it, vi } from "vitest";
import type { RoutineRecord, RoutinesState } from "@omp-ui/core/routine";
import { h } from "../../test/store-harness";
import { remoteInstance } from "../../test/fixtures";

const ID = "AbCdEfGhIjKlMnOpQrStUv";

describe("routines slice focusRoutine", () => {
  it("opens the view and records the focus id when Routines is enabled", () => {
    h.useStore.setState({ state: { ...h.backendState, routinesEnabled: true } });
    h.useStore.getState().focusRoutine(ID);
    expect(h.useStore.getState().routinesOpen).toBe(true);
    expect(h.useStore.getState().routineFocusId).toBe(ID);
  });

  it("is a no-op with the gate off, leaving no stale focus request", () => {
    h.useStore.setState({ state: { ...h.backendState, routinesEnabled: false }, routinesOpen: false, routineFocusId: null });
    h.useStore.getState().focusRoutine(ID);
    expect(h.useStore.getState().routinesOpen).toBe(false);
    expect(h.useStore.getState().routineFocusId).toBeNull();
  });

  it("clears on consume and when the view closes", () => {
    h.useStore.setState({ state: { ...h.backendState, routinesEnabled: true } });
    h.useStore.getState().focusRoutine(ID);
    h.useStore.getState().clearRoutineFocus();
    expect(h.useStore.getState().routineFocusId).toBeNull();
    h.useStore.getState().focusRoutine(ID);
    h.useStore.getState().closeRoutines();
    expect(h.useStore.getState().routinesOpen).toBe(false);
    expect(h.useStore.getState().routineFocusId).toBeNull();
  });
});

function routinesStateWith(allow: string[], deny: string[]): RoutinesState {
  const routine: RoutineRecord = {
    id: ID,
    name: "Morning overview",
    instructions: "Summarize the repo.",
    schedule: { kind: "cron", expr: "0 9 * * *" },
    timeZone: "UTC",
    destination: { projectCwd: "/repo", workspace: "worktree" },
    mode: "build",
    model: null,
    thinkingLevel: null,
    spend: { warnUsd: null, maxUsd: null },
    toolPolicy: { allow, deny, lastReviewedAt: "2026-11-22T12:00:00.000Z", reviewedCatalog: [] },
    scripts: { pre: "", post: "" },
    timeoutMinutes: null,
    notifications: { onStart: false, onComplete: false, onFail: false, onApproval: false, agentMessage: false },
    artifact: null,
    enabled: true,
    createdAt: "2026-11-01T00:00:00.000Z",
    nextRunAtMs: null,
    lastRunAtMs: null,
    lastRunTabId: null,
    notices: [],
  };
  return {
    enabled: true,
    machineLabel: "this computer",
    routines: [routine],
    runs: [],
    activeRunTabId: null,
    defaultWarnCostUsd: 1,
    defaultMaxCostUsd: 5,
  };
}

describe("routines slice setRoutineToolDecision", () => {
  it("appends the key to allow and drops it from deny", async () => {
    h.useStore.setState({ routinesState: routinesStateWith(["read"], ["write"]) });
    const updateRoutine = vi.mocked(h.mockBackend.updateRoutine);
    updateRoutine.mockResolvedValue(routinesStateWith(["read", "write"], []).routines[0]!);
    await h.useStore.getState().setRoutineToolDecision(ID, "write", "allow");
    expect(updateRoutine).toHaveBeenCalledTimes(1);
    const [id, patch] = updateRoutine.mock.calls[0]!;
    expect(id).toBe(ID);
    expect(patch.toolPolicy?.allow).toEqual(["read", "write"]);
    expect(patch.toolPolicy?.deny).toEqual([]);
  });

  it("leaves allow untouched when the key is already granted", async () => {
    h.useStore.setState({ routinesState: routinesStateWith(["read"], []) });
    vi.mocked(h.mockBackend.updateRoutine).mockResolvedValue(routinesStateWith(["read"], []).routines[0]!);
    await h.useStore.getState().setRoutineToolDecision(ID, "read", "allow");
    const [, patch] = vi.mocked(h.mockBackend.updateRoutine).mock.calls[0]!;
    expect(patch.toolPolicy?.allow).toEqual(["read"]);
    expect(patch.toolPolicy?.deny).toEqual([]);
  });

  it("appends the key to deny and drops it from allow", async () => {
    h.useStore.setState({ routinesState: routinesStateWith(["read", "bash"], ["write"]) });
    const updateRoutine = vi.mocked(h.mockBackend.updateRoutine);
    updateRoutine.mockResolvedValue(routinesStateWith(["read"], ["write", "bash"]).routines[0]!);
    await h.useStore.getState().setRoutineToolDecision(ID, "bash", "deny");
    expect(updateRoutine).toHaveBeenCalledTimes(1);
    const [id, patch] = updateRoutine.mock.calls[0]!;
    expect(id).toBe(ID);
    expect(patch.toolPolicy?.allow).toEqual(["read"]);
    expect(patch.toolPolicy?.deny).toEqual(["write", "bash"]);
  });

  it("leaves deny untouched when the key is already denied", async () => {
    h.useStore.setState({ routinesState: routinesStateWith(["read"], ["bash"]) });
    vi.mocked(h.mockBackend.updateRoutine).mockResolvedValue(routinesStateWith(["read"], ["bash"]).routines[0]!);
    await h.useStore.getState().setRoutineToolDecision(ID, "bash", "deny");
    const [, patch] = vi.mocked(h.mockBackend.updateRoutine).mock.calls[0]!;
    expect(patch.toolPolicy?.allow).toEqual(["read"]);
    expect(patch.toolPolicy?.deny).toEqual(["bash"]);
  });

  it("refetches routines:state once when the local snapshot is missing", async () => {
    h.useStore.setState({ routinesState: null });
    vi.mocked(h.mockBackend.getRoutinesState).mockResolvedValue(routinesStateWith([], []));
    vi.mocked(h.mockBackend.updateRoutine).mockResolvedValue(routinesStateWith(["grep"], []).routines[0]!);
    await h.useStore.getState().setRoutineToolDecision(ID, "grep", "allow");
    const [, patch] = vi.mocked(h.mockBackend.updateRoutine).mock.calls[0]!;
    expect(patch.toolPolicy?.allow).toEqual(["grep"]);
    expect(patch.toolPolicy?.deny).toEqual([]);
  });

  it("refetches routines:state once when denying with a missing local snapshot", async () => {
    h.useStore.setState({ routinesState: null });
    vi.mocked(h.mockBackend.getRoutinesState).mockResolvedValue(routinesStateWith(["bash"], []));
    vi.mocked(h.mockBackend.updateRoutine).mockResolvedValue(routinesStateWith([], ["bash"]).routines[0]!);
    await h.useStore.getState().setRoutineToolDecision(ID, "bash", "deny");
    const [, patch] = vi.mocked(h.mockBackend.updateRoutine).mock.calls[0]!;
    expect(patch.toolPolicy?.allow).toEqual([]);
    expect(patch.toolPolicy?.deny).toEqual(["bash"]);
  });

  it("refuses an id the refetch does not know", async () => {
    h.useStore.setState({ routinesState: null });
    vi.mocked(h.mockBackend.getRoutinesState).mockResolvedValue({ ...routinesStateWith([], []), routines: [] });
    await expect(h.useStore.getState().setRoutineToolDecision(ID, "grep", "allow")).rejects.toThrow(/unknown routine/);
    await expect(h.useStore.getState().setRoutineToolDecision(ID, "grep", "deny")).rejects.toThrow(/unknown routine/);
    expect(h.mockBackend.updateRoutine).not.toHaveBeenCalled();
  });
});

describe("routines slice multi-host support (issue #1306)", () => {
  it("opens on the first joined remote when local Routines is off and remote Routines is on", () => {
    const remote = remoteInstance({ id: "inst-studio", nickname: "studio", status: "joined", routinesEnabled: true });
    vi.mocked(h.mockBackend.remoteInstanceRequest).mockResolvedValue(routinesStateWith(["read"], []));
    h.useStore.setState({
      state: { ...h.backendState, routinesEnabled: false, remoteInstances: [remote] },
      routinesOpen: false,
      routinesInstanceId: null,
    });
    h.useStore.getState().openRoutines();
    expect(h.useStore.getState().routinesOpen).toBe(true);
    expect(h.useStore.getState().routinesInstanceId).toBe("inst-studio");
  });

  it("stores remote routines per instance, isolates unknown channel errors, and routes setRoutineToolDecision to the remote host", async () => {
    const remoteState = { ...routinesStateWith(["read"], ["bash"]), machineLabel: "studio" };
    h.useStore.getState().replaceRemoteRoutines("inst-studio", remoteState);
    expect(h.useStore.getState().routinesByInstance["inst-studio"]?.machineLabel).toBe("studio");

    // Error on another host is stored in routinesLoadError without firing reportError.
    const errorsBefore = h.useStore.getState().errorNotices.length;
    vi.mocked(h.mockBackend.remoteInstanceRequest).mockRejectedValueOnce(new Error("unknown channel routines:getState"));
    await h.useStore.getState().refreshRoutines("inst-lite");
    expect(h.useStore.getState().routinesLoadError["inst-lite"]).toContain("unknown channel routines:getState");
    expect(h.useStore.getState().errorNotices).toHaveLength(errorsBefore);

    // setRoutineToolDecision on a remote instance routes routines:update through remoteInstanceRequest.
    vi.mocked(h.mockBackend.remoteInstanceRequest).mockResolvedValueOnce(routinesStateWith(["read", "bash"], []).routines[0]!);
    await h.useStore.getState().setRoutineToolDecision(ID, "bash", "allow", "inst-studio");
    expect(h.mockBackend.remoteInstanceRequest).toHaveBeenCalledWith(
      "inst-studio",
      "routines:update",
      [
        ID,
        expect.objectContaining({
          toolPolicy: expect.objectContaining({ allow: ["read", "bash"], deny: [] }),
        }),
      ],
    );

    vi.mocked(h.mockBackend.remoteInstanceRequest).mockResolvedValueOnce(routinesStateWith([], ["bash", "read"]).routines[0]!);
    await h.useStore.getState().setRoutineToolDecision(ID, "read", "deny", "inst-studio");
    expect(h.mockBackend.remoteInstanceRequest).toHaveBeenCalledWith(
      "inst-studio",
      "routines:update",
      [
        ID,
        expect.objectContaining({
          toolPolicy: expect.objectContaining({ allow: [], deny: ["bash", "read"] }),
        }),
      ],
    );
    expect(h.mockBackend.updateRoutine).not.toHaveBeenCalled();
  });

  it("cleans up cached state and falls back when the active remote instance is removed", () => {
    const remote = remoteInstance({ id: "inst-studio", nickname: "studio", status: "joined", routinesEnabled: true });
    h.useStore.setState({
      state: { ...h.backendState, routinesEnabled: true, remoteInstances: [remote] },
      routinesOpen: true,
      routinesInstanceId: "inst-studio",
      routinesByInstance: { "inst-studio": routinesStateWith(["read"], []) },
      routinesLoadError: { "inst-studio": "err" },
    });
    h.useStore.getState().reconcileRoutinesInstances({ ...h.backendState, routinesEnabled: true, remoteInstances: [] });
    expect(h.useStore.getState().routinesInstanceId).toBeNull();
    expect(h.useStore.getState().routinesByInstance).toEqual({});
    expect(h.useStore.getState().routinesLoadError).toEqual({});
    expect(h.useStore.getState().routinesOpen).toBe(true);
  });
});