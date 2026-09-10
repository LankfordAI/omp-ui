import { describe, expect, it } from "vitest";
import { NO_GATE, gateSelector, parseSpawnGate } from "./spawn-gate";

describe("parseSpawnGate", () => {
  it("treats an unset seam as no gate at all", () => {
    expect(parseSpawnGate({})).toEqual(NO_GATE);
  });

  it("treats a blank or whitespace-only seam as no gate", () => {
    // Shell plumbing loves to produce these; they must not mean "pin to nothing".
    expect(parseSpawnGate({ OMP_UI_TEST_MODEL: "", OMP_UI_TEST_ADVISOR: "   " })).toEqual(NO_GATE);
  });

  it("parses a bare provider/model selector", () => {
    expect(parseSpawnGate({ OMP_UI_TEST_MODEL: "p/m" })).toEqual({
      model: { model: "p/m" },
      advisorModel: null,
    });
  });

  it("keeps an omp thinking level on the selector", () => {
    expect(parseSpawnGate({ OMP_UI_TEST_MODEL: "p/m:high" })).toEqual({
      model: { model: "p/m", level: "high" },
      advisorModel: null,
    });
  });

  it("keeps the level of a suffixed OpenRouter selector", () => {
    const gate = parseSpawnGate({
      OMP_UI_TEST_MODEL: "openrouter/openai/gpt-5.6-luna:low",
      OMP_UI_TEST_ADVISOR: "openrouter/openai/gpt-5.6-terra:low",
    });
    expect(gate.model).toEqual({ model: "openrouter/openai/gpt-5.6-luna", level: "low" });
    expect(gateSelector(gate)).toBe("openrouter/openai/gpt-5.6-luna:low");
    expect(gate.advisorModel).toEqual({ model: "openrouter/openai/gpt-5.6-terra", level: "low" });
  });

  it("gates the advisor alone without inventing a main-model pin", () => {
    const gate = parseSpawnGate({ OMP_UI_TEST_ADVISOR: "p/a:low" });
    expect(gate.model).toBeNull();
    expect(gateSelector(gate)).toBeNull();
  });
});
