import { describe, expect, it } from "vitest";
import { parseThemeSetArgs, parseThemeToolArgs, themeListTool, themeSetTool, themeTool } from "./theme-tool";

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

describe("parseThemeSetArgs (issue #1175)", () => {
  it("refuses an empty object naming every accepted field", () => {
    expect(parseThemeSetArgs({})).toEqual({ ok: false, reason: "pass at least one of id, slot, mode, motion" });
  });

  it("names an unknown field by its path", () => {
    expect(parseThemeSetArgs({ id: "nord", theme: "nord" })).toEqual({ ok: false, reason: "unknown field theme" });
  });

  it("refuses slot without an id to place", () => {
    expect(parseThemeSetArgs({ slot: "dark" })).toEqual({ ok: false, reason: "slot needs id" });
    expect(parseThemeSetArgs({ mode: "system", slot: "light" })).toEqual({ ok: false, reason: "slot needs id" });
  });

  it("bounds slot and mode to their enums", () => {
    expect(parseThemeSetArgs({ id: "nord", slot: "bright" }).ok).toBe(false);
    expect(parseThemeSetArgs({ mode: "auto" }).ok).toBe(false);
    expect(parseThemeSetArgs({ id: "nord", slot: "light", mode: "system" })).toEqual({
      ok: true,
      args: { id: "nord", slot: "light", mode: "system" },
    });
  });

  it("refuses a non-boolean motion and an over-long or empty id", () => {
    expect(parseThemeSetArgs({ motion: "on" })).toEqual({ ok: false, reason: "motion must be a boolean" });
    expect(parseThemeSetArgs({ id: "" }).ok).toBe(false);
    expect(parseThemeSetArgs({ id: "x".repeat(97) }).ok).toBe(false);
  });

  it("round-trips every field of a full call", () => {
    expect(parseThemeSetArgs({ id: "nord", slot: "auto", mode: "fixed", motion: false })).toEqual({
      ok: true,
      args: { id: "nord", slot: "auto", mode: "fixed", motion: false },
    });
  });

  it("theme_set takes no required parameters and closes its schema", () => {
    const tool = themeSetTool();
    expect(tool.parameters.required).toBeUndefined();
    expect(tool.parameters.additionalProperties).toBe(false);
  });

  it("theme_list takes no parameters at all", () => {
    const tool = themeListTool();
    expect(tool.parameters).toEqual({ type: "object", additionalProperties: false, properties: {} });
  });
});
