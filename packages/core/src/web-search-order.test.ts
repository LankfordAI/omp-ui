import { describe, expect, it } from "vitest";
import {
  normalizeWebSearchOrder,
  parseWebSearchProviderList,
  unknownWebSearchProviders,
  WEB_SEARCH_AUTO_CHOICE,
  WEB_SEARCH_CUSTOM_OPTION,
  webSearchOrderForOption,
  webSearchSelection,
} from "./web-search-order";

/** omp 18.1.10's own rejection line for `omp search --provider=<sentinel>`. */
const STDERR_18_1_10 =
  'error: Expected --provider to be one of: auto, perplexity, gemini, anthropic, codex, ' +
  "xai, zai, exa, tinyfish, jina, kagi, tavily, firecrawl, brave, kimi, parallel, synthetic, " +
  'searxng, startpage, duckduckgo, ecosia, google, mojeek, public; got "omp-ui-provider-probe"';

describe("parseWebSearchProviderList", () => {
  it("reads omp's ids in omp's order and drops the auto sentinel", () => {
    const providers = parseWebSearchProviderList(STDERR_18_1_10);
    expect(providers).not.toBeNull();
    expect(providers).toHaveLength(23);
    expect(providers?.[0]).toBe("perplexity");
    expect(providers).toContain("brave");
    expect(providers?.[providers.length - 1]).toBe("public");
    expect(providers).not.toContain(WEB_SEARCH_AUTO_CHOICE);
  });

  it("returns null when omp reword the message", () => {
    expect(parseWebSearchProviderList("error: invalid --provider value")).toBeNull();
  });

  it("returns null for a list that carries nothing but the sentinel", () => {
    expect(parseWebSearchProviderList("Expected --provider to be one of: auto; got x")).toBeNull();
  });

  it("collapses duplicates and blank members", () => {
    expect(parseWebSearchProviderList("Expected --provider to be one of: brave, brave, , exa ; got x")).toEqual(
      ["brave", "exa"],
    );
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
