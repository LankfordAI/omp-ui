import { describe, expect, it } from "vitest";
import {
  HOST_CONTROLS_MIN_OMP,
  modelPickerCommand,
  parseDeliverQueueResult,
  parseModelPickerResult,
  setModelFromRowCommand,
  supportsHostControls,
} from "./host-controls";

describe("supportsHostControls", () => {
  it("opens at the gate version and stays open above it", () => {
    expect(supportsHostControls(HOST_CONTROLS_MIN_OMP)).toBe(true);
    expect(supportsHostControls("19.2.0")).toBe(true);
    expect(supportsHostControls("v19.1.0")).toBe(true);
  });

  it("keeps the controls off for older runtimes and unknown versions", () => {
    // The local omp binary in this repo's dev boxes is 19.0.1: every verb
    // here would come back "Unknown command".
    expect(supportsHostControls("19.0.1")).toBe(false);
    expect(supportsHostControls("18.21.4")).toBe(false);
    expect(supportsHostControls(null)).toBe(false);
    expect(supportsHostControls("nightly")).toBe(false);
  });
});

describe("modelPickerCommand", () => {
  it("omits query and limit when absent or blank — blank query browses Recent-first", () => {
    expect(modelPickerCommand()).toEqual({ type: "get_model_picker" });
    expect(modelPickerCommand("")).toEqual({ type: "get_model_picker" });
    expect(modelPickerCommand(undefined, undefined)).toEqual({ type: "get_model_picker" });
  });

  it("passes a query and a limit through", () => {
    expect(modelPickerCommand("anthropic/claude", 25)).toEqual({
      type: "get_model_picker",
      query: "anthropic/claude",
      limit: 25,
    });
    expect(modelPickerCommand("@")).toEqual({ type: "get_model_picker", query: "@" });
  });
});

describe("setModelFromRowCommand", () => {
  it("sends provider + modelId for a model row — no role, no thinkingLevel", () => {
    const row = { provider: "anthropic", id: "claude-x", name: "Claude X" };
    expect(setModelFromRowCommand(row)).toEqual({
      type: "set_model",
      provider: "anthropic",
      modelId: "claude-x",
    });
  });

  it("carries the role back from a quick-role row, which set_model accepts", () => {
    const row = { provider: "gate", id: "gaterati", name: "Gaterati", role: "advisor" };
    expect(setModelFromRowCommand(row)).toEqual({
      type: "set_model",
      provider: "gate",
      modelId: "gaterati",
      role: "advisor",
    });
  });

  it("carries an explicit thinking level when the pick names one; blank never rides", () => {
    const row = { provider: "p", id: "m", name: "M", thinkingLevel: "high" };
    expect(setModelFromRowCommand(row, "low")).toEqual({
      type: "set_model",
      provider: "p",
      modelId: "m",
      thinkingLevel: "low",
    });
    expect(setModelFromRowCommand(row, "")).toEqual({
      type: "set_model",
      provider: "p",
      modelId: "m",
    });
  });
});

describe("parseModelPickerResult", () => {
  const ROW = {
    provider: "anthropic",
    id: "claude-x",
    name: "Claude X",
    roles: [{ role: "default", label: "Default" }, { role: "advisor", label: "Advisor", auto: true }],
    thinking: ["off", "low", "high"],
    thinkingLevel: "high",
    current: true,
  };

  it("accepts a full result verbatim", () => {
    const result = parseModelPickerResult({ rows: [ROW], recent: 1, total: 7 });
    expect(result).toEqual({
      rows: [
        {
          provider: "anthropic",
          id: "claude-x",
          name: "Claude X",
          roles: [
            { role: "default", label: "Default" },
            { role: "advisor", label: "Advisor", auto: true },
          ],
          thinking: ["off", "low", "high"],
          thinkingLevel: "high",
          current: true,
        },
      ],
      recent: 1,
      total: 7,
    });
  });

  it("keeps a quick-role row's role and drops model-only scalars it lacks", () => {
    const result = parseModelPickerResult({
      rows: [{ provider: "gate", id: "gaterati", name: "Gaterati", role: "advisor", thinkingLevel: "low", current: true }],
      recent: 0,
      total: 1,
    });
    expect(result?.rows[0]).toEqual({
      provider: "gate",
      id: "gaterati",
      name: "Gaterati",
      role: "advisor",
      thinkingLevel: "low",
      current: true,
    });
  });

  it("drops rows without provider/id — they could never round-trip through set_model", () => {
    const result = parseModelPickerResult({
      rows: [
        ROW,
        { name: "ghost" },
        { provider: "p", name: "no id" },
        "not a row",
        null,
      ],
      recent: 1,
      total: 4,
    });
    expect(result?.rows).toHaveLength(1);
    expect(result?.rows[0]?.id).toBe("claude-x");
  });

  it("defaults a missing name to the id and degrades absent scalars", () => {
    const result = parseModelPickerResult({ rows: [{ provider: "p", id: "m" }] });
    expect(result).toEqual({ rows: [{ provider: "p", id: "m", name: "m" }], recent: 0, total: 1 });
  });

  it("clamps recent into the returned rows and never lets total claim fewer than shown", () => {
    const result = parseModelPickerResult({ rows: [ROW], recent: 9, total: 0 });
    expect(result?.recent).toBe(1);
    expect(result?.total).toBe(1);
  });

  it("is not a picker result without a rows array", () => {
    expect(parseModelPickerResult(null)).toBeNull();
    expect(parseModelPickerResult({})).toBeNull();
    expect(parseModelPickerResult({ rows: "nope" })).toBeNull();
    expect(parseModelPickerResult([])).toBeNull();
  });

  it("keeps overContext only when true", () => {
    const result = parseModelPickerResult({
      rows: [
        { provider: "p", id: "a", name: "A", overContext: true },
        { provider: "p", id: "b", name: "B", overContext: false },
      ],
    });
    expect(result?.rows[0]?.overContext).toBe(true);
    expect(result?.rows[1]).not.toHaveProperty("overContext");
  });
});

describe("parseDeliverQueueResult", () => {
  it("reads the aborted flag both ways", () => {
    expect(parseDeliverQueueResult({ aborted: true })).toBe(true);
    expect(parseDeliverQueueResult({ aborted: false })).toBe(false);
  });

  it("reports no usable answer for a payload without the flag", () => {
    expect(parseDeliverQueueResult({})).toBeNull();
    expect(parseDeliverQueueResult(null)).toBeNull();
    expect(parseDeliverQueueResult({ aborted: "yes" })).toBeNull();
  });
});
