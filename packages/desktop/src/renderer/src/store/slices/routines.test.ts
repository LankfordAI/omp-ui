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
        schedule: { kind: "cron", expr: "0 9 * * *" },
        destination: { projectCwd: "/repo", workspace: "worktree" },
        mode: "build",
        toolPolicy: { allow, deny, lastReviewedAt: "2026-11-22T12:00:00.000Z", reviewedCatalog: [] },
    h.useStore.setState({ routinesState: routinesStateWith(["read"], ["write"]) });
    const updateRoutine = vi.mocked(h.mockBackend.updateRoutine);
    expect(updateRoutine).toHaveBeenCalledTimes(1);
    const [id, patch] = updateRoutine.mock.calls[0]!;
    expect(patch.toolPolicy?.allow).toEqual(["read", "write"]);
    expect(patch.toolPolicy?.deny).toEqual([]);
    h.useStore.setState({ routinesState: routinesStateWith(["read"], []) });
    const [, patch] = vi.mocked(h.mockBackend.updateRoutine).mock.calls[0]!;
    expect(patch.toolPolicy?.allow).toEqual(["read"]);
    vi.mocked(h.mockBackend.getRoutinesState).mockResolvedValue(routinesStateWith([], []));
    const [, patch] = vi.mocked(h.mockBackend.updateRoutine).mock.calls[0]!;
    expect(patch.toolPolicy?.allow).toEqual(["grep"]);
    vi.mocked(h.mockBackend.getRoutinesState).mockResolvedValue({ ...routinesStateWith([], []), routines: [] });