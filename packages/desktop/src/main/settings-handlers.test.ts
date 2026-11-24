import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CH, Registry } from "@omp-ui/core";
import { registerSettingsHandlers } from "./settings-handlers";
import type { StoredThemeDeps } from "./stored-themes";
import { ThemeBackdropStore } from "./theme-backdrop-store";
import { ThemeRepositoryService } from "./theme-repositories";

function themes(registry: Registry, dir: string): StoredThemeDeps {
  return {
    registry,
    broadcast: async () => {},
    backdrops: new ThemeBackdropStore(path.join(dir, "theme-backdrops")),
    newId: () => "custom-test-000000",
  };
}

function repositories(registry: Registry, dir: string): ThemeRepositoryService {
  return new ThemeRepositoryService({ registry, broadcast: async () => {}, themes: themes(registry, dir) });
}

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
    themes: themes(registry, dir),
    themeRepositories: repositories(registry, dir),
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
        themes: themes(registry, dir),
        themeRepositories: repositories(registry, dir),
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
        themes: themes(registry, dir),
        themeRepositories: repositories(registry, dir),
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

describe("theme telemetry consent", () => {
  it("persists consent before synchronous notification and rotates the ID only after revocation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-theme-consent-"));
    try {
      const file = path.join(dir, "registry.json");
      const registry = Registry.load(file);
      const order: Array<string | null> = [];
      const handlers = registerSettingsHandlers({
        registry,
        broadcast: async () => { order.push("broadcast"); },
        supportedCompactionMethods: async () => [],
        onAppUpdateTrainChanged: async () => {},
        onFleetLadderChanged: () => {},
        onTelemetryChanged: () => { order.push(Registry.load(file).getSetting("telemetryThemesConsentId")); },
        seedCouncilRoster: async () => {},
        themes: themes(registry, dir),
        themeRepositories: repositories(registry, dir),
      });
      const enable = handlers[CH.setTelemetryThemesEnabled](true);
      const id = registry.getSetting("telemetryThemesConsentId");
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(order).toEqual([id, "broadcast"]);
      await enable;
      await handlers[CH.setTelemetryThemesEnabled](true);
      const disable = handlers[CH.setTelemetryThemesEnabled](false);
      expect(order).toEqual([id, "broadcast", id, "broadcast", null, "broadcast"]);
      await disable;
      await handlers[CH.setTelemetryThemesEnabled](true);
      const nextId = Registry.load(file).getSetting("telemetryThemesConsentId");
      expect(nextId).not.toBeNull();
      expect(nextId).not.toBe(id);
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
        themes: themes(registry, dir),
        themeRepositories: repositories(registry, dir),
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

describe("theme backdrop reads (issue #1168)", () => {
  it("answers null for an unknown hash and base64 with the sniffed mime for a stored one", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-backdrop-read-"));
    try {
      const registry = Registry.load(path.join(dir, "registry.json"));
      const deps = themes(registry, dir);
      const handlers = registerSettingsHandlers({
        registry,
        broadcast: async () => {},
        supportedCompactionMethods: async () => [],
        onAppUpdateTrainChanged: async () => {},
        onFleetLadderChanged: () => {}, onTelemetryChanged: () => {}, seedCouncilRoster: async () => {},
        themes: deps,
        themeRepositories: new ThemeRepositoryService({ registry, broadcast: async () => {}, themes: deps }),
      });
      const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
      const hash = await deps.backdrops.put(svg);
      await expect(handlers[CH.readThemeBackdrop]("0".repeat(64))).resolves.toBeNull();
      await expect(handlers[CH.readThemeBackdrop](hash)).resolves.toEqual({
        mime: "image/svg+xml",
        data: Buffer.from(svg).toString("base64"),
      });
      const mp4 = new Uint8Array([
        0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d,
      ]);
      const mp4Hash = await deps.backdrops.put(mp4);
      await expect(handlers[CH.readThemeBackdrop](mp4Hash)).resolves.toEqual({
        mime: "video/mp4",
        data: Buffer.from(mp4).toString("base64"),
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
