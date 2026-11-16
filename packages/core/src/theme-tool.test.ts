import { describe, expect, it } from "vitest";
import { parseThemeToolArgs, themeTool } from "./theme-tool";

const ARGS = { label: "Dusk", seeds: { canvas: "#1a1b26" } };

describe("parseThemeToolArgs apply flag (issue #1169)", () => {
  it("parses apply:true and round-trips it", () => {
    const parsed = parseThemeToolArgs({ ...ARGS, apply: true });
    expect(parsed).toEqual({ ok: true, args: { label: "Dusk", seeds: { canvas: "#1a1b26" }, apply: true } });
  });

  it("parses apply:false the same way", () => {
    const parsed = parseThemeToolArgs({ ...ARGS, apply: false });
    expect(parsed.ok && parsed.args.apply).toBe(false);
  });

  it("refuses a non-boolean apply with the boolean message", () => {
    expect(parseThemeToolArgs({ ...ARGS, apply: "yes" })).toEqual({ ok: false, reason: "apply must be a boolean" });
  });

  it("leaves apply absent when the agent did not pass it", () => {
    const parsed = parseThemeToolArgs(ARGS);
    expect(parsed.ok && "apply" in parsed.args).toBe(false);
  });

  it("the schema carries apply as an optional boolean", () => {
    const tool = themeTool();
    const properties = tool.parameters.properties as Record<string, unknown>;
    expect(properties.apply).toEqual({ type: "boolean" });
    expect(tool.parameters.required).not.toContain("apply");
  });
});
