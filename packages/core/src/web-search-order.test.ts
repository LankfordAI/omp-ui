import { describe, expect, it } from "vitest";
import {
  normalizeWebSearchOrder,
  parseWebSearchProviderCatalog,
  unknownWebSearchProviders,
  WEB_SEARCH_CUSTOM_OPTION,
  webSearchOrderForOption,
  webSearchSelection,
} from "./web-search-order";

/** One catalog row per v18.3.2: `omp models --kind search --json`. */
function searchRow(id: string, extra: Record<string, unknown> = {}) {
  return {
    provider: "web",
    kind: "search",
    id,
    selector: `web/${id}`,
    name: id,
    ...extra,
  };
}

describe("parseWebSearchProviderCatalog", () => {
  it("keeps web/search ids in catalog order", () => {
    expect(
      parseWebSearchProviderCatalog({
        models: [searchRow("brave"), searchRow("exa"), searchRow("perplexity")],
      }),
    ).toEqual(["brave", "exa", "perplexity"]);
  });

  it("returns null for shapes without a models array", () => {
    for (const json of [undefined, null, {}, [], "brave", { models: "brave" }]) {
      expect(parseWebSearchProviderCatalog(json)).toBeNull();
    }
  });

  it("drops rows that are not web/search and rows without a usable id", () => {
    expect(
      parseWebSearchProviderCatalog({
        models: [
          { provider: "anthropic", kind: "chat", id: "claude" },
          { provider: "local", kind: "search", id: "ollama-web" },
          { provider: "web", kind: "stt", id: "whisper" },
          searchRow(""),
          searchRow("exa", { id: 42 }),
          searchRow("brave", { id: undefined }),
          "not a row",
          null,
          searchRow("brave"),
        ],
      }),
    ).toEqual(["brave"]);
  });

  it("collapses duplicates to the first occurrence", () => {
    expect(
      parseWebSearchProviderCatalog({
        models: [searchRow("brave"), searchRow("brave"), searchRow("exa")],
      }),
    ).toEqual(["brave", "exa"]);
  });

  it("returns null when the catalog holds no usable row", () => {
    expect(parseWebSearchProviderCatalog({ models: [] })).toBeNull();
    expect(parseWebSearchProviderCatalog({ models: [{ provider: "web", kind: "chat", id: "x" }] })).toBeNull();
  });
});

describe("normalizeWebSearchOrder", () => {
  it("keeps only unique non-empty strings", () => {
    expect(normalizeWebSearchOrder(["brave", "brave", "", "exa"])).toEqual(["brave", "exa"]);
  });

  it("treats anything non-array as no order", () => {
    for (const value of [undefined, null, "brave", 3, { a: 1 }, ["", {}]]) {
      expect(normalizeWebSearchOrder(value)).toEqual([]);
    }
  });
});

describe("webSearchSelection", () => {
  it("reads an empty or junk order as Automatic", () => {
    for (const value of [[], undefined, ["", {}], "brave"]) {
      expect(webSearchSelection(value)).toEqual({ kind: "automatic" });
    }
  });

  it("reads one provider as that provider, duplicates included", () => {
    expect(webSearchSelection(["brave"])).toEqual({ kind: "provider", provider: "brave" });
    expect(webSearchSelection(["brave", "brave"])).toEqual({ kind: "provider", provider: "brave" });
  });

  it("reads a hand-written multi-order as custom", () => {
    expect(webSearchSelection(["brave", "exa"])).toEqual({
      kind: "custom",
      providers: ["brave", "exa"],
    });
  });
});

describe("webSearchOrderForOption", () => {
  it("clears the preference for Automatic and the custom placeholder", () => {
    expect(webSearchOrderForOption("")).toEqual([]);
    expect(webSearchOrderForOption(WEB_SEARCH_CUSTOM_OPTION)).toEqual([]);
  });

  it("writes exactly one provider first", () => {
    expect(webSearchOrderForOption("brave")).toEqual(["brave"]);
  });
});

describe("unknownWebSearchProviders", () => {
  it("keeps configured ids omp's published list lacks", () => {
    expect(unknownWebSearchProviders(["brave", "bogus", "exa"], ["brave", "exa"])).toEqual(["bogus"]);
    expect(unknownWebSearchProviders(["brave"], ["brave"])).toEqual([]);
  });

  it("keeps every configured id when nothing was discovered", () => {
    expect(unknownWebSearchProviders(["brave", "exa"], [])).toEqual(["brave", "exa"]);
  });
});
