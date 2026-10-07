import { describe, expect, it } from "vitest";
import { parseChatModelCatalog, readModelCatalog } from "./model-catalog";
import type { OmpConfigRunner } from "./omp-settings";

/** Trimmed copy of real `omp models --kind chat --json` output (v18.7.0).
 *  The row shape is ModelInfo-compatible except `thinking`, which arrives as
 *  a bare efforts array (issue #774). */
const CATALOG = {
  models: [
    {
      provider: "litellm",
      kind: "chat",
      id: "Qwen3.8-Flash-Next",
      selector: "litellm/Qwen3.8-Flash-Next",
      name: "Qwen3.8 Flash Next",
      contextWindow: 131072,
      maxTokens: 16384,
      reasoning: true,
      thinking: ["off", "low", "medium", "high", "xhigh"],
      input: ["text"],
      cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.125 },
    },
    {
      provider: "anthropic",
      kind: "chat",
      id: "claude-sonnet-4-5",
      selector: "anthropic/claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      contextWindow: 200000,
      reasoning: true,
      thinking: null,
      input: ["text", "image"],
      cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    },
  ],
};

describe("parseChatModelCatalog", () => {
  it("keeps catalog order and the ModelInfo-shaped rows", () => {
    expect(parseChatModelCatalog(CATALOG)).toEqual([
      {
        provider: "litellm",
        id: "Qwen3.8-Flash-Next",
        name: "Qwen3.8 Flash Next",
        contextWindow: 131072,
        maxTokens: 16384,
        reasoning: true,
        input: ["text"],
        cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.125 },
        thinking: { efforts: ["off", "low", "medium", "high", "xhigh"] },
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        contextWindow: 200000,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      },
    ]);
  });

  it("drops non-chat rows and rows without a usable provider/id pair", () => {
    const models = parseChatModelCatalog({
      models: [
        { provider: "openrouter", kind: "judge", id: "jev", name: "Jev" },
        { provider: "openrouter", kind: "chat", id: "", name: "Empty Id" },
        { provider: "", kind: "chat", id: "m", name: "Empty Provider" },
        { provider: 42, kind: "chat", id: "m" },
        { kind: "chat", id: "m" },
        "garbage",
        null,
      ],
    });
    expect(models).toEqual([]);
  });

  it("collapses duplicate provider/id pairs to the first and falls back to id for a blank name", () => {
    const models = parseChatModelCatalog({
      models: [
        { provider: "p", kind: "chat", id: "m", name: "First" },
        { provider: "p", kind: "chat", id: "m", name: "Second" },
        { provider: "p", kind: "chat", id: "blank", name: "" },
      ],
    });
    expect(models).toEqual([
      { provider: "p", id: "m", name: "First" },
      { provider: "p", id: "blank", name: "blank" },
    ]);
  });

  it("drops malformed optional fields rather than handing them to the palette", () => {
    const models = parseChatModelCatalog({
      models: [
        {
          provider: "p",
          kind: "chat",
          id: "m",
          name: "M",
          contextWindow: "big",
          maxTokens: null,
          reasoning: "yes",
          input: ["text", 7],
          cost: "free",
          thinking: "off",
        },
      ],
    });
    expect(models).toEqual([{ provider: "p", id: "m", name: "M" }]);
  });

  it("rejects unparseable shapes", () => {
    expect(parseChatModelCatalog(null)).toBeNull();
    expect(parseChatModelCatalog({})).toBeNull();
    expect(parseChatModelCatalog({ models: "nope" })).toBeNull();
    expect(parseChatModelCatalog([])).toBeNull();
  });
});

describe("readModelCatalog", () => {
  it("reports a missing binary without throwing", async () => {
    await expect(readModelCatalog({ ompPath: null })).resolves.toEqual({
      models: [],
      discovered: false,
      error: "omp binary not found",
    });
  });

  it("probes the chat kind under the live environment", async () => {
    const run: OmpConfigRunner = async (args) => {
      expect(args).toEqual(["models", "--kind", "chat", "--json"]);
      return JSON.stringify(CATALOG);
    };
    const snapshot = await readModelCatalog({ ompPath: "/bin/omp" }, run);
    expect(snapshot.discovered).toBe(true);
    expect(snapshot.error).toBeNull();
    expect(snapshot.models.map((m) => `${m.provider}/${m.id}`)).toEqual([
      "litellm/Qwen3.8-Flash-Next",
      "anthropic/claude-sonnet-4-5",
    ]);
  });

  it("degrades to discovered:false on bad JSON and on probe failure", async () => {
    const bad: OmpConfigRunner = async () => "not json";
    await expect(readModelCatalog({ ompPath: "/bin/omp" }, bad)).resolves.toEqual({
      models: [],
      discovered: false,
      error: "omp did not return a model list",
    });
    const failing: OmpConfigRunner = async () => {
      throw new Error("  omp: command models not found for kind chat  ");
    };
    const snapshot = await readModelCatalog({ ompPath: "/bin/omp" }, failing);
    expect(snapshot.models).toEqual([]);
    expect(snapshot.discovered).toBe(false);
    expect(snapshot.error).toBe("omp: command models not found for kind chat");
  });
});
