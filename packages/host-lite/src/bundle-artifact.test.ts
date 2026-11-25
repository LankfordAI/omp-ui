import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultBundlePath } from "./bundle-artifact";

describe("defaultBundlePath SEA resolution (#1368)", () => {
  it("resolves OMP_UI_LITE_BUNDLE override first when present", () => {
    const resolved = defaultBundlePath({
      sea: true,
      execPath: "/home/user/.local/bin/omp-ui-lite",
      env: { OMP_UI_LITE_BUNDLE: "/custom/session-bundle.mjs" },
      exists: (p) => p === "/custom/session-bundle.mjs",
    });
    expect(resolved).toBe("/custom/session-bundle.mjs");
  });

  it("resolves ../lib/omp-ui-lite/session-bundle.mjs beside node_modules without a source checkout", () => {
    const expected = path.resolve("/home/user/.local/bin", "..", "lib", "omp-ui-lite", "session-bundle.mjs");
    const resolved = defaultBundlePath({
      sea: true,
      execPath: "/home/user/.local/bin/omp-ui-lite",
      env: {},
      exists: (p) => p === expected,
    });
    expect(resolved).toBe(expected);
  });

  it("falls back to NODE_PATH entry parent before execPath sibling", () => {
    const nodePathBundle = path.join("/opt/omp-lite/lib", "session-bundle.mjs");
    const resolved = defaultBundlePath({
      sea: true,
      execPath: "/usr/local/bin/omp-ui-lite",
      env: { NODE_PATH: "/opt/omp-lite/lib/node_modules" },
      exists: (p) => p === nodePathBundle,
    });
    expect(resolved).toBe(nodePathBundle);
  });
});
