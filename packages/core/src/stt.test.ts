import { describe, expect, it } from "vitest";
import {
  parseSttModelCatalog,
  parseSttSelector,
  readSttModels,
  resolveSttSelector,
  STT_ROUTES,
} from "./stt";
import type { OmpConfigRunner } from "./omp-settings";
import type { SttModelOption } from "./types";

/** Trimmed copy of real `omp models --kind stt --json` output (v18.2.11,
 *  with OPENAI_API_KEY set so the openai group appears). local/* rows kept:
 *  they must be dropped by the parser. */
const CATALOG = {
  models: [
    { provider: "local", kind: "stt", id: "whisper-base", selector: "local/whisper-base", name: "Whisper Base" },
    { provider: "local", kind: "stt", id: "whisper-large-v3-turbo", selector: "local/whisper-large-v3-turbo", name: "Whisper Large v3 Turbo" },
    { provider: "openai", kind: "stt", id: "gpt-4o-transcribe", selector: "openai/gpt-4o-transcribe", name: "GPT-4o Transcribe" },
    { provider: "openai", kind: "stt", id: "whisper-1", selector: "openai/whisper-1", name: "Whisper 1" },
    { provider: "openrouter", kind: "stt", id: "mai-transcribe-1.5", selector: "openrouter/microsoft/mai-transcribe-1.5", name: "MAI-Transcribe 1.5" },
    { provider: "openrouter", kind: "stt", id: "gpt-4o-transcribe", selector: "openrouter/openai/gpt-4o-transcribe", name: "GPT-4o Transcribe" },
    { provider: "openrouter", kind: "stt", id: "whisper-large-v3", selector: "openrouter/openai/whisper-large-v3", name: "Whisper Large v3" },
    { provider: "openrouter", kind: "stt", id: "whisper-1", selector: "openrouter/openai/whisper-1", name: "Whisper 1" },
    { provider: "groq", kind: "stt", id: "whisper-large-v3-turbo", selector: "groq/whisper-large-v3-turbo", name: "Whisper Large v3 Turbo" },
  ],
};

const hasKey = (env: string): boolean => env === "OPENAI_API_KEY";
const row = (selector: string, callable: boolean): SttModelOption => ({
  selector,
  provider: selector.slice(0, selector.indexOf("/")),
  name: selector,
  callable,
});

describe("parseSttSelector", () => {
  it("keeps slash-bearing model slugs whole after the provider segment", () => {
    expect(parseSttSelector("openrouter/openai/whisper-large-v3")).toEqual({
      provider: "openrouter",
      model: "openai/whisper-large-v3",
    });
    expect(parseSttSelector("openrouter/microsoft/mai-transcribe-1.5")).toEqual({
      provider: "openrouter",
      model: "microsoft/mai-transcribe-1.5",
    });
    expect(parseSttSelector("openai/whisper-1")).toEqual({
      provider: "openai",
      model: "whisper-1",
    });
  });

  it("rejects selectors with no routable provider prefix", () => {
    expect(parseSttSelector("local/whisper-base")).toBeNull();
    expect(parseSttSelector("groq/whisper-large-v3-turbo")).toBeNull();
    expect(parseSttSelector("whisper-1")).toBeNull();
    expect(parseSttSelector("openrouter/")).toBeNull();
    expect(parseSttSelector("")).toBeNull();
  });

  it("routes exactly the STT_ROUTES providers", () => {
    for (const provider of Object.keys(STT_ROUTES)) {
      expect(parseSttSelector(`${provider}/x/y`)?.provider).toBe(provider);
    }
  });
});

describe("parseSttModelCatalog", () => {
  it("drops omp's local sherpa-onnx rows and marks callable per credential", () => {
    const models = parseSttModelCatalog(CATALOG, hasKey);
    expect(models).not.toBeNull();
    expect(models!.every((m) => m.provider !== "local")).toBe(true);
    expect(models!.find((m) => m.selector === "openai/whisper-1")?.callable).toBe(true);
    // groq is in omp's catalog but omp-ui has no direct route for it.
    expect(models!.find((m) => m.selector === "groq/whisper-large-v3-turbo")?.callable).toBe(false);
    expect(models!.find((m) => m.selector === "openrouter/openai/whisper-large-v3")?.callable).toBe(
      false,
    );
  });

  it("rejects unparseable shapes", () => {
    expect(parseSttModelCatalog(null, hasKey)).toBeNull();
    expect(parseSttModelCatalog({}, hasKey)).toBeNull();
    expect(parseSttModelCatalog({ models: "no" }, hasKey)).toBeNull();
    expect(parseSttModelCatalog({ models: [null, 7] }, hasKey)).toEqual([]);
  });

  it("keeps name-free rows selectable by selector", () => {
    const models = parseSttModelCatalog(
      { models: [{ provider: "openai", kind: "stt", selector: "openai/whisper-1" }] },
      () => true,
    );
    expect(models).toEqual([
      { selector: "openai/whisper-1", provider: "openai", name: "openai/whisper-1", callable: true },
    ]);
  });
});

describe("resolveSttSelector", () => {
  it("prefers the documented discovery order over catalog order", () => {
    const models = [
      row("openrouter/openai/whisper-1", true),
      row("openrouter/openai/whisper-large-v3-turbo", true),
      row("openrouter/openai/whisper-large-v3", true),
    ];
    expect(resolveSttSelector(models)).toBe("openrouter/openai/whisper-large-v3-turbo");
  });

  it("falls back to any callable row, then null", () => {
    expect(resolveSttSelector([row("groq/x", false), row("openrouter/x", true)])).toBe(
      "openrouter/x",
    );
    expect(resolveSttSelector([row("openai/whisper-1", false)])).toBeNull();
    expect(resolveSttSelector([])).toBeNull();
  });
});

describe("readSttModels", () => {
  it("reports a missing binary without throwing", async () => {
    await expect(readSttModels({ ompPath: null })).resolves.toEqual({
      models: [],
      discovered: false,
      error: "omp binary not found",
    });
  });

  it("parses the probe's JSON under the live environment", async () => {
    process.env.OPENAI_API_KEY = "probe-key";
    try {
      const run: OmpConfigRunner = async (args) => {
        expect(args).toEqual(["models", "--kind", "stt", "--json"]);
        return JSON.stringify(CATALOG);
      };
      const snapshot = await readSttModels({ ompPath: "/bin/omp" }, run);
      expect(snapshot.discovered).toBe(true);
      expect(snapshot.error).toBeNull();
      expect(snapshot.models.find((m) => m.selector === "openai/whisper-1")?.callable).toBe(true);
      expect(snapshot.models.some((m) => m.provider === "local")).toBe(false);
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("degrades to discovered:false on bad JSON and on probe failure", async () => {
    const bad: OmpConfigRunner = async () => "not json";
    await expect(readSttModels({ ompPath: "/bin/omp" }, bad)).resolves.toMatchObject({
      models: [],
      discovered: false,
    });
    const failing: OmpConfigRunner = async () => {
      throw new Error("omp: unknown command models");
    };
    const snapshot = await readSttModels({ ompPath: "/bin/omp" }, failing);
    expect(snapshot.discovered).toBe(false);
    expect(snapshot.error).toContain("unknown command");
  });
});
