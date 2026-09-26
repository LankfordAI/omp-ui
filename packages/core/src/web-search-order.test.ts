import { describe, expect, it } from "vitest";
import {
  mergeWebSearchRole,
  normalizeWebSearchOrder,
  parseWebSearchProviderCatalog,
  unknownWebSearchProviders,
  WEB_SEARCH_CUSTOM_OPTION,
  webSearchOrderForOption,
  webSearchRoleLayer,
  webSearchRoleSelection,
  webSearchSelectorForOption,
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

describe("webSearchRoleSelection", () => {
  it("reads an absent, empty, or non-string web role as automatic", () => {
    expect(webSearchRoleSelection({})).toEqual({ kind: "automatic" });
    expect(webSearchRoleSelection({ advisor: "x/adv" })).toEqual({ kind: "automatic" });
    expect(webSearchRoleSelection({ web: "" })).toEqual({ kind: "automatic" });
    // A hand-edit left junk under the key; a clean pick replaces it.
    expect(webSearchRoleSelection({ web: ["web/brave"] })).toEqual({ kind: "automatic" });
    expect(webSearchRoleSelection({ web: 7 })).toEqual({ kind: "automatic" });
  });

  it("reads a web/<id> selector as that provider id verbatim", () => {
    expect(webSearchRoleSelection({ web: "web/brave" })).toEqual({
      kind: "provider",
      provider: "brave",
    });
    // No level-stripping: the id round-trips, even when the catalog lacks it.
    expect(webSearchRoleSelection({ web: "web/brave:high" })).toEqual({
      kind: "provider",
      provider: "brave:high",
    });
  });

  it("shows any other non-empty string as the raw selector state", () => {
    // "web/" is prefix-with-no-id, not a provider.
    expect(webSearchRoleSelection({ web: "web/" })).toEqual({
      kind: "selector",
      selector: "web/",
    });
    expect(webSearchRoleSelection({ web: "*" })).toEqual({ kind: "selector", selector: "*" });
    expect(webSearchRoleSelection({ web: "@role" })).toEqual({
      kind: "selector",
      selector: "@role",
    });
    expect(webSearchRoleSelection({ web: "brave" })).toEqual({
      kind: "selector",
      selector: "brave",
    });
  });
});

describe("webSearchSelectorForOption", () => {
  it("maps Automatic and the display-only option to key omission", () => {
    expect(webSearchSelectorForOption("")).toBeNull();
    expect(webSearchSelectorForOption(WEB_SEARCH_CUSTOM_OPTION)).toBeNull();
  });

  it("prefixes a chosen provider id", () => {
    expect(webSearchSelectorForOption("brave")).toBe("web/brave");
  });
});

describe("mergeWebSearchRole", () => {
  it("keeps every sibling of the global record untouched", () => {
    const global = { default: "a/b", advisor: "c/d", tiny: "e/f" };
    expect(mergeWebSearchRole(global, "web/brave")).toEqual({
      default: "a/b",
      advisor: "c/d",
      tiny: "e/f",
      web: "web/brave",
    });
    expect(global).toEqual({ default: "a/b", advisor: "c/d", tiny: "e/f" });
  });

  it("deletes the web key for a null selector", () => {
    expect(mergeWebSearchRole({ advisor: "c/d", web: "web/brave" }, null)).toEqual({
      advisor: "c/d",
    });
  });

  it("degrades a non-object globalValue to a record holding only the web role", () => {
    expect(mergeWebSearchRole(undefined, "web/brave")).toEqual({ web: "web/brave" });
    expect(mergeWebSearchRole(["web/brave"], "web/brave")).toEqual({ web: "web/brave" });
    expect(mergeWebSearchRole("junk", "web/brave")).toEqual({ web: "web/brave" });
    expect(mergeWebSearchRole(undefined, null)).toEqual({});
    expect(mergeWebSearchRole(null, null)).toEqual({});
  });
});

describe("webSearchRoleLayer", () => {
  it("is global when the global record carries the effective web role", () => {
    expect(webSearchRoleLayer({ web: "web/brave" }, { web: "web/brave" })).toBe("global");
  });

  it("is default when neither layer carries a web role", () => {
    expect(webSearchRoleLayer({}, {})).toBe("default");
    expect(webSearchRoleLayer(undefined, undefined)).toBe("default");
    expect(webSearchRoleLayer({ advisor: "p/a" }, { advisor: "g/a" })).toBe("default");
  });

  it("is project when the effective web role differs from or exceeds the global one", () => {
    expect(webSearchRoleLayer({ web: "web/exa" }, { web: "web/brave" })).toBe("project");
    expect(webSearchRoleLayer({ web: "web/exa" }, {})).toBe("project");
    expect(webSearchRoleLayer({ web: "web/exa" }, undefined)).toBe("project");
  });

  it("ignores an unrelated sibling that differs while the web role matches", () => {
    // The per-key point: entry.layer would say "project" for the advisor alone.
    expect(
      webSearchRoleLayer({ advisor: "proj/adv", web: "web/brave" }, { advisor: "glob/adv", web: "web/brave" }),
    ).toBe("global");
    expect(webSearchRoleLayer({ advisor: "proj/adv" }, { advisor: "glob/adv" })).toBe("default");
  });
});
