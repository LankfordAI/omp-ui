import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CH, Registry } from "@omp-ui/core";
import { registerSettingsHandlers } from "./settings-handlers";

/**
 * The council enable handler's ordering (amends #1055): the roster seed must
 * complete before `councilEnabled` commits, so the editor rendered after the
 * flag flip already shows the seeded roster.
 */

function setup(seedCouncilRoster: () => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-sethandlers-"));
  const registry = Registry.load(path.join(dir, "registry.json"));
  // Explicitly off: the test must not depend on the shipped default.
  registry.setSetting("councilEnabled", false);
  const order: string[] = [];
  const handlers = registerSettingsHandlers({
    registry,
    broadcast: async () => {},
    supportedCompactionMethods: async () => [],
    onAppUpdateTrainChanged: async () => {},
    onFleetLadderChanged: () => {},
    onTelemetryChanged: () => {},
    seedCouncilRoster: async () => {
      order.push("seed");
      await seedCouncilRoster();
    },
  });
  return { dir, registry, order, handlers };
}

describe("setCouncilEnabled", () => {
  it("awaits the roster seed before committing the flag on", async () => {
    let releaseSeed!: () => void;
    const seedGate = new Promise<void>((resolve) => {
      releaseSeed = resolve;
    });
    const { dir, registry, order, handlers } = setup(async () => {
      await seedGate;
      order.push("seed-done");
    });
    try {
      const flipping = handlers[CH.setCouncilEnabled](true);
      // Still pending: the flag must not commit while the seed is in flight.
      expect(registry.getSetting("councilEnabled")).toBe(false);
      releaseSeed();
      await flipping;
      expect(order).toEqual(["seed", "seed-done"]);
      expect(registry.getSetting("councilEnabled")).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not seed when turning the flag off", async () => {
    const seedCouncilRoster = vi.fn(async () => {});
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-sethandlers-"));
    try {
      const registry = Registry.load(path.join(dir, "registry.json"));
      registry.setSetting("councilEnabled", true);
      const handlers = registerSettingsHandlers({
        registry,
        broadcast: async () => {},
        supportedCompactionMethods: async () => [],
        onAppUpdateTrainChanged: async () => {},
        onFleetLadderChanged: () => {},
        onTelemetryChanged: () => {},
        seedCouncilRoster: seedCouncilRoster,
      });
      await handlers[CH.setCouncilEnabled](false);
      expect(seedCouncilRoster).not.toHaveBeenCalled();
      expect(registry.getSetting("councilEnabled")).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("model usage telemetry consent", () => {
  it("persists consent and revokes reporting synchronously before broadcasting", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-consent-"));
    try {
      const registry = Registry.load(path.join(dir, "registry.json"));
      const order: string[] = [];
      const handlers = registerSettingsHandlers({
        registry,
        broadcast: async () => { order.push("broadcast"); },
        supportedCompactionMethods: async () => [],
        onAppUpdateTrainChanged: async () => {},
        onFleetLadderChanged: () => {},
        onTelemetryChanged: () => { order.push(`consent:${registry.getSetting("telemetryModelsEnabled")}`); },
        seedCouncilRoster: async () => {},
      });
      const enabling = handlers[CH.setTelemetryModelsEnabled](true);
      expect(order).toEqual(["consent:true", "broadcast"]);
      await enabling;
      const disabling = handlers[CH.setTelemetryModelsEnabled](false);
      expect(order).toEqual(["consent:true", "broadcast", "consent:false", "broadcast"]);
      await disabling;
      expect(Registry.load(path.join(dir, "registry.json")).getSetting("telemetryModelsEnabled")).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("artifact library gate ordering", () => {
  it("persists and revokes before broadcasting even when reconciliation fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-artifact-gate-"));
    try {
      const registry = Registry.load(path.join(dir, "registry.json"));
      registry.setSetting("artifactLibraryEnabled", true);
      let admitted = true;
      const observed: boolean[] = [];
      const handlers = registerSettingsHandlers({
        registry,
        broadcast: async () => { observed.push(admitted); },
        supportedCompactionMethods: async () => [],
        onAppUpdateTrainChanged: async () => {},
        onFleetLadderChanged: () => {}, onTelemetryChanged: () => {}, seedCouncilRoster: async () => {},
        onArtifactLibraryChanged: () => {
          admitted = registry.getSetting("artifactLibraryEnabled");
          throw new Error("failed roster update");
        },
      });
      await expect(handlers[CH.setArtifactLibraryEnabled](false)).rejects.toThrow("failed roster update");
      expect(observed).toEqual([false]);
      expect(Registry.load(path.join(dir, "registry.json")).getSetting("artifactLibraryEnabled")).toBe(false);
    } finally { fs.rmSync(dir, {recursive: true, force: true}); }
  });
});
