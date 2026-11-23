import { describe, expect, it } from "vitest";
import { supportsToolCommands, TOOL_COMMANDS_MIN_OMP } from "./tool-commands";

describe("supportsToolCommands (issue #1270)", () => {
  it("turns on at the release that renamed the mount probe and moved propose", () => {
    expect(TOOL_COMMANDS_MIN_OMP).toBe("19.1.0");
    expect(supportsToolCommands("19.1.0")).toBe(true);
    expect(supportsToolCommands("19.1.1")).toBe(true);
    expect(supportsToolCommands("20.0.0")).toBe(true);
  });

  it("keeps the xd:// dialect on a harness that predates tool commands", () => {
    expect(supportsToolCommands("19.0.0")).toBe(false);
    expect(supportsToolCommands("18.14.0")).toBe(false);
  });

  it("treats an unreported or unparseable version as the older dialect", () => {
    expect(supportsToolCommands(null)).toBe(false);
    expect(supportsToolCommands("nightly")).toBe(false);
  });
});
