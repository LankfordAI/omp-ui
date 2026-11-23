// The routines slice's review-link focus (ADR-0100 amendment): a transcript
// omp-ui://routine/<id> click opens the full-pane view and carries the id for
// RoutinesView to pick, gated by routinesEnabled like openRoutines itself.
import { describe, expect, it, vi } from "vitest";
import type { RoutineRecord, RoutinesState } from "@omp-ui/core/routine";
import { h } from "../../test/store-harness";

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

describe("routines slice grantRoutineTool", () => {
  it("appends the key to allow and drops it from deny", async () => {
    h.useStore.setState({ routinesState: routinesStateWith(["read"], ["write"]) });
    const updateRoutine = vi.mocked(h.mockBackend.updateRoutine);
    updateRoutine.mockResolvedValue(routinesStateWith(["read", "write"], []).routines[0]!);
    await h.useStore.getState().grantRoutineTool(ID, "write");
    expect(updateRoutine).toHaveBeenCalledTimes(1);
    const [id, patch] = updateRoutine.mock.calls[0]!;
    expect(id).toBe(ID);
    expect(patch.toolPolicy?.allow).toEqual(["read", "write"]);
    expect(patch.toolPolicy?.deny).toEqual([]);
  });

  it("leaves allow untouched when the key is already granted", async () => {
    h.useStore.setState({ routinesState: routinesStateWith(["read"], []) });
    vi.mocked(h.mockBackend.updateRoutine).mockResolvedValue(routinesStateWith(["read"], []).routines[0]!);
    await h.useStore.getState().grantRoutineTool(ID, "read");
    const [, patch] = vi.mocked(h.mockBackend.updateRoutine).mock.calls[0]!;
    expect(patch.toolPolicy?.allow).toEqual(["read"]);
  });

  it("refetches routines:state once when the local snapshot is missing", async () => {
    h.useStore.setState({ routinesState: null });
    vi.mocked(h.mockBackend.getRoutinesState).mockResolvedValue(routinesStateWith([], []));
    vi.mocked(h.mockBackend.updateRoutine).mockResolvedValue(routinesStateWith(["grep"], []).routines[0]!);
    await h.useStore.getState().grantRoutineTool(ID, "grep");
    const [, patch] = vi.mocked(h.mockBackend.updateRoutine).mock.calls[0]!;
    expect(patch.toolPolicy?.allow).toEqual(["grep"]);
  });

  it("refuses an id the refetch does not know", async () => {
    h.useStore.setState({ routinesState: null });
    vi.mocked(h.mockBackend.getRoutinesState).mockResolvedValue({ ...routinesStateWith([], []), routines: [] });
    await expect(h.useStore.getState().grantRoutineTool(ID, "grep")).rejects.toThrow(/unknown routine/);
    expect(h.mockBackend.updateRoutine).not.toHaveBeenCalled();
  });
});