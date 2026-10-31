import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveAgentDeviceBin } from "./agent-device-bin";

const BIN = path.join("node_modules", "agent-device", "bin", "agent-device.mjs");

describe("resolveAgentDeviceBin", () => {
  it("maps a packaged app.asar location to its app.asar.unpacked twin", () => {
    const resources = path.join(path.sep, "opt", "omp-ui", "resources");
    const unpacked = path.join(resources, "app.asar.unpacked", BIN);
    const probed: string[] = [];
    const found = resolveAgentDeviceBin((p) => {
      probed.push(p);
      return p === unpacked;
    }, path.join(resources, "app.asar", "out", "main"));
    expect(found).toBe(unpacked);
    expect(probed.some((p) => p.split(path.sep).includes("app.asar"))).toBe(false);
  });

  it("walks up from a dev build to the hoisted repo-root node_modules", () => {
    const repo = path.join(path.sep, "work", "omp-ui");
    const hoisted = path.join(repo, BIN);
    expect(resolveAgentDeviceBin((p) => p === hoisted, path.join(repo, "packages", "desktop", "out", "main"))).toBe(hoisted);
  });

  it("answers null when no ancestor holds the package", () => {
    expect(resolveAgentDeviceBin(() => false, path.join(path.sep, "a", "b"))).toBeNull();
  });
});
