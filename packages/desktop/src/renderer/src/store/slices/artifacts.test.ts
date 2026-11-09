import { describe, expect, it, vi } from "vitest";
import { h } from "../../test/store-harness";
import { getNavigationGeneration } from "./view";

describe("artifact main-pane selection", () => {
  it("does not open while disabled and never discards session tabs", () => {
    const before = h.useStore.getState().tabs;
    h.useStore.setState({ artifacts: null, state: { ...h.backendState, artifactLibraryEnabled: false } });
    h.useStore.getState().openArtifacts();
    expect(h.useStore.getState().artifacts).toBeNull();
    h.useStore.setState({ state: { ...h.backendState, artifactLibraryEnabled: true } });
    h.useStore.getState().openArtifacts();
    expect(h.useStore.getState().artifacts).toEqual({ artifactId: null });
    expect(h.useStore.getState().tabs).toBe(before);
  });

  it("stops Lab through its close action and excludes every other main pane", () => {
    const stop = vi.fn();
    const closeLab = h.useStore.getState().closeLab;
    h.useStore.setState({ state: { ...h.backendState, artifactLibraryEnabled: true }, lab: { projectCwd: null, instanceId: null, experiment: null }, closeLab: stop, fleetTerminal: "terminal" });
    try {
      h.useStore.getState().openArtifacts({ artifactId: "artifact" });
      expect(stop).toHaveBeenCalledOnce();
      expect(h.useStore.getState()).toMatchObject({ artifacts: { artifactId: "artifact" }, stats: null, fleet: null, fleetTerminal: null, compactSurface: null });
    } finally { h.useStore.setState({ closeLab, lab: null }); }
  });

  it("Stats and Fleet terminal navigation close the library and advance intent", () => {
    h.useStore.setState({ artifacts: { artifactId: null } });
    const before = getNavigationGeneration();
    h.useStore.getState().openStats();
    expect(h.useStore.getState().artifacts).toBeNull();
    expect(getNavigationGeneration()).toBeGreaterThan(before);
    h.useStore.setState({ artifacts: { artifactId: null } });
    h.useStore.getState().showFleetTerminal("terminal");
    expect(h.useStore.getState().artifacts).toBeNull();
  });
});
