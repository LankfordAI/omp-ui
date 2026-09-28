import { describe, expect, it } from "vitest";
import { parseJudgeModelCatalog, readJudgeModels } from "./judge-models";
import type { OmpConfigRunner } from "./omp-settings";

/** Trimmed copy of real `omp models --kind judge --json` output (v18.4.0,
 *  with OPENROUTER_API_KEY set). The judge rows carry `thinking: null`; a
 *  local row is kept to pin that the judge parser drops nothing per provider
 *  (issue #669). */
const CATALOG = {
  models: [
    { provider: "openrouter", kind: "judge", id: "typesafe/jev-1.13", selector: "openrouter/typesafe/jev-1.13", name: "Jev 1.13", thinking: null },
    { provider: "openrouter", kind: "judge", id: "anthropic/claude-sonnet-4", selector: "openrouter/anthropic/claude-sonnet-4", name: "Claude Sonnet 4", thinking: null },
    { provider: "local", kind: "judge", id: "jev-mini", selector: "local/jev-mini", name: "Jev Mini", thinking: null },
  ],
};

describe("parseJudgeModelCatalog", () => {
  it("keeps catalog order, every provider, and both name fields", () => {
    expect(parseJudgeModelCatalog(CATALOG)).toEqual([
      { selector: "openrouter/typesafe/jev-1.13", name: "Jev 1.13" },
      { selector: "openrouter/anthropic/claude-sonnet-4", name: "Claude Sonnet 4" },
      { selector: "local/jev-mini", name: "Jev Mini" },
    ]);
  });

  it("drops non-judge rows and rows without a usable selector", () => {
    const models = parseJudgeModelCatalog({
      models: [
        { provider: "openrouter", kind: "stt", selector: "openrouter/whisper-1", name: "Whisper" },
        { provider: "openrouter", kind: "judge", name: "No Selector" },
        { provider: "openrouter", kind: "judge", selector: "", name: "Empty" },
        { provider: "openrouter", kind: "judge", selector: 42 },
        "garbage",
        null,
        { provider: "openrouter", kind: "judge", selector: "openrouter/typesafe/jev-1.13" },
      ],
    });
    expect(models).toEqual([{ selector: "openrouter/typesafe/jev-1.13", name: "openrouter/typesafe/jev-1.13" }]);
  });

  it("collapses duplicate selectors to the first row", () => {
    const models = parseJudgeModelCatalog({
      models: [
        { provider: "openrouter", kind: "judge", selector: "openrouter/x", name: "X" },
        { kind: "judge", selector: "openrouter/x", name: "X again" },
      ],
    });
    expect(models).toEqual([{ selector: "openrouter/x", name: "X" }]);
  });

  it("rejects unparseable shapes", () => {
    expect(parseJudgeModelCatalog(null)).toBeNull();
    expect(parseJudgeModelCatalog({})).toBeNull();
    expect(parseJudgeModelCatalog({ models: "nope" })).toBeNull();
    expect(parseJudgeModelCatalog([])).toBeNull();
  });
});

describe("readJudgeModels", () => {
  it("reports a missing binary without throwing", async () => {
    await expect(readJudgeModels({ ompPath: null })).resolves.toEqual({
      models: [],
      discovered: false,
      error: "omp binary not found",
    });
  });

  it("probes the judge kind under the live environment", async () => {
    const run: OmpConfigRunner = async (args) => {
      expect(args).toEqual(["models", "--kind", "judge", "--json"]);
      return JSON.stringify(CATALOG);
    };
    const snapshot = await readJudgeModels({ ompPath: "/bin/omp" }, run);
    expect(snapshot.discovered).toBe(true);
    expect(snapshot.error).toBeNull();
    expect(snapshot.models.map((m) => m.selector)).toEqual([
      "openrouter/typesafe/jev-1.13",
      "openrouter/anthropic/claude-sonnet-4",
      "local/jev-mini",
    ]);
  });

  it("degrades to discovered:false on bad JSON and on probe failure", async () => {
    const bad: OmpConfigRunner = async () => "not json";
    await expect(readJudgeModels({ ompPath: "/bin/omp" }, bad)).resolves.toEqual({
      models: [],
      discovered: false,
      error: "omp did not return a model list",
    });
    const failing: OmpConfigRunner = async () => {
      throw new Error("  omp: command models not found for kind judge  ");
    };
    const snapshot = await readJudgeModels({ ompPath: "/bin/omp" }, failing);
    expect(snapshot.models).toEqual([]);
    expect(snapshot.discovered).toBe(false);
    expect(snapshot.error).toBe("omp: command models not found for kind judge");
  });
});
