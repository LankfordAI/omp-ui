import { describe, expect, it } from "vitest";
import { filterModelsForTab } from "./model-filter";
import type { ModelInfo } from "./rpc-types";

const mockModels: ModelInfo[] = [
  { id: "claude-opus-5", name: "Opus 5", provider: "anthropic" },
  { id: "claude-sonnet-4", name: "Sonnet 4", provider: "anthropic" },
  { id: "gpt-4o", name: "GPT-4o", provider: "openai" },
  { id: "gpt-5", name: "GPT-5", provider: "openai" },
];

describe("filterModelsForTab", () => {
  it("returns only models for the given provider", () => {
    const result = filterModelsForTab(mockModels, "anthropic", new Set());
    expect(result.map((m) => m.id)).toEqual(["claude-opus-5", "claude-sonnet-4"]);
  });

  it("returns empty array for unknown provider", () => {
    const result = filterModelsForTab(mockModels, "groq", new Set());
    expect(result).toEqual([]);
  });

  it("returns only starred models for favorites tab", () => {
    const favorites = new Set(["anthropic/claude-opus-5", "openai/gpt-5"]);
    const result = filterModelsForTab(mockModels, "favorites", favorites);
    expect(result.map((m) => m.id)).toEqual(["claude-opus-5", "gpt-5"]);
  });

  it("drops orphaned favorites from the list", () => {
    // A favorite key whose model is no longer in availableModels
    const favorites = new Set([
      "anthropic/claude-opus-5",
      "openrouter/deleted-model",
    ]);
    const result = filterModelsForTab(mockModels, "favorites", favorites);
    expect(result.map((m) => m.id)).toEqual(["claude-opus-5"]);
  });

  it("returns empty array when no favorites exist", () => {
    const result = filterModelsForTab(mockModels, "favorites", new Set());
    expect(result).toEqual([]);
  });
});
