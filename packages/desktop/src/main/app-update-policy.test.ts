import { describe, expect, it } from "vitest";
import { appUpdateEnabledForBuild } from "./app-update-policy";

describe("appUpdateEnabledForBuild", () => {
  it.each([
    {
      name: "enables packaged Linux builds",
      opts: { packaged: true, platform: "linux" as const, forceEnabled: false },
      expected: true,
    },
    {
      name: "disables packaged Darwin builds",
      opts: { packaged: true, platform: "darwin" as const, forceEnabled: false },
      expected: false,
    },
    {
      name: "disables unpackaged Linux builds",
      opts: { packaged: false, platform: "linux" as const, forceEnabled: false },
      expected: false,
    },
    {
      name: "allows a forced Darwin build",
      opts: { packaged: true, platform: "darwin" as const, forceEnabled: true },
      expected: true,
    },
  ])("$name", ({ opts, expected }) => {
    expect(appUpdateEnabledForBuild(opts)).toBe(expected);
  });
});
