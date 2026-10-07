import { describe, expect, it } from "vitest";
import {
  emptySessionRuntime,
  modelFastTier,
  modelSupportsFastMode,
  parseModelInfo,
  parseQueuedMessages,
  parseSessionRuntime,
  parseUsageLimit,
  parseSubagents,
  type ModelInfo,
} from "./rpc-types";

const model = (patch: Partial<ModelInfo>): ModelInfo => ({
  id: "m",
  name: "M",
  provider: "test",
  ...patch,
});

describe("parseModelInfo service tiers", () => {
  it("keeps a non-empty wire serviceTiers array", () => {
    expect(
      parseModelInfo({ id: "m", name: "M", provider: "openai", serviceTiers: ["priority", "ultrafast"] })
        ?.serviceTiers,
    ).toEqual(["priority", "ultrafast"]);
  });

  it("filters non-string serviceTiers entries", () => {
    expect(
      parseModelInfo({
        id: "m",
        serviceTiers: ["priority", 2, null, { name: "ultrafast" }, "ultrafast"],
      })?.serviceTiers,
    ).toEqual(["priority", "ultrafast"]);
  });

  it.each([
    ["absent", {}],
    ["empty", { serviceTiers: [] }],
    ["filtered empty", { serviceTiers: [2, null, {}] }],
  ])("leaves serviceTiers undefined when the wire array is %s", (_label, tiers) => {
    const parsed = parseModelInfo({ id: "m", name: "M", provider: "openai", ...tiers });
    expect(parsed).toEqual({
      id: "m",
      name: "M",
      provider: "openai",
      api: undefined,
      reasoning: undefined,
      input: [],
      cost: undefined,
      contextWindow: undefined,
      maxTokens: undefined,
      thinking: null,
      supportsComputerUse: undefined,
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.serviceTiers).toBeUndefined();
  });
});

describe("modelFastTier", () => {
  it("returns null for a null model", () => {
    expect(modelFastTier(null)).toBeNull();
  });

  it("lets an advertised ultrafast tier win over the fast-mode family gate", () => {
    const unsupported = model({ provider: "anthropic", serviceTiers: ["priority", "ultrafast"] });
    expect(modelSupportsFastMode(unsupported)).toBe(false);
    expect(modelFastTier(unsupported)).toBe("ultrafast");
    expect(modelFastTier(model({ provider: "openai", serviceTiers: ["ultrafast"] }))).toBe("ultrafast");
  });

  it.each([
    ["openai", ["priority"], "priority"],
    ["anthropic", ["priority"], null],
    ["openai", undefined, "priority"],
    ["anthropic", undefined, null],
    ["openai", ["constructor"], "priority"],
    ["anthropic", ["constructor"], null],
  ])(
    "uses the family gate for provider %s with serviceTiers %j",
    (provider, serviceTiers, expected) => {
      expect(modelFastTier(model({ provider, serviceTiers }))).toBe(expected);
    },
  );
});

describe("modelSupportsFastMode", () => {
  it("says no for a null model (not yet resolved)", () => {
    expect(modelSupportsFastMode(null)).toBe(false);
  });

  it("says yes for the OpenAI family providers", () => {
    expect(modelSupportsFastMode(model({ provider: "openai" }))).toBe(true);
    expect(modelSupportsFastMode(model({ provider: "openai-codex" }))).toBe(true);
  });

  it("says yes for Anthropic and for a gateway row carrying the family api", () => {
    expect(
      modelSupportsFastMode(model({ provider: "anthropic", api: "anthropic-messages" })),
    ).toBe(true);
    // The wire's `api` is what the Anthropic transport speaks, whoever hosts
    // the row — a gateway whose provider name says nothing about the family.
    expect(modelSupportsFastMode(model({ provider: "gateway-x", api: "anthropic-messages" }))).toBe(
      true,
    );
  });

  it("excludes Fireworks even with a family api: its tier is provider-scoped", () => {
    expect(
      modelSupportsFastMode(model({ provider: "fireworks", api: "anthropic-messages" })),
    ).toBe(false);
  });

  it("excludes Copilot even with a family api: no session tier exists", () => {
    expect(
      modelSupportsFastMode(model({ provider: "github-copilot", api: "anthropic-messages" })),
    ).toBe(false);
  });

  it("says no for families with no wire-decidable tier", () => {
    expect(modelSupportsFastMode(model({ provider: "openrouter" }))).toBe(false);
    expect(modelSupportsFastMode(model({ provider: "google" }))).toBe(false);
    expect(modelSupportsFastMode(model({ provider: "test" }))).toBe(false);
  });

  it("never reads a prototype-chain key as support", () => {
    expect(modelSupportsFastMode(model({ provider: "constructor" }))).toBe(false);
    expect(modelSupportsFastMode(model({ provider: "test", api: "constructor" }))).toBe(false);
  });

  it("reads OpenRouter rows by slug family", () => {
    expect(modelSupportsFastMode(model({ provider: "openrouter", id: "openai/gpt-5.2" }))).toBe(true);
    expect(modelSupportsFastMode(model({ provider: "openrouter", id: "openai/gpt-5.6:high" }))).toBe(true);
    expect(
      modelSupportsFastMode(model({ provider: "openrouter", id: "google/gemini-2.5-pro" })),
    ).toBe(true);
    expect(
      modelSupportsFastMode(model({ provider: "openrouter", id: "~google/gemini-flash-latest" })),
    ).toBe(true);
    // Anthropic fast serving via OpenRouter is the separate `-fast` sibling slug;
    // the tier itself is ignored in transit, so the toggle would never go active.
    expect(
      modelSupportsFastMode(model({ provider: "openrouter", id: "anthropic/claude-opus-5" })),
    ).toBe(false);
    // Not OpenAI- or Gemini-class despite the prefix look.
    expect(modelSupportsFastMode(model({ provider: "openrouter", id: "x-ai/grok-4-fast" }))).toBe(false);
    expect(modelSupportsFastMode(model({ provider: "openrouter", id: "google/gemma-3-4b-it" }))).toBe(false);
    // A routing colon (`:exacto`) is not a level suffix and must not be stripped
    // into a match — the tail check only removes known levels.
    expect(
      modelSupportsFastMode(model({ provider: "openrouter", id: "x-ai/grok-4:exacto" })),
    ).toBe(false);
  });
});

describe("queued messages in session state", () => {
  const previous = {
    ...emptySessionRuntime(),
    queuedMessages: { steering: ["old steer"], followUp: ["old follow-up"] },
  };

  it("takes queue-chip text from a get_state payload", () => {
    const next = parseSessionRuntime(
      { queuedMessages: { steering: ["s1"], followUp: ["f1", "f2"] } },
      previous,
    );
    expect(next.queuedMessages).toEqual({ steering: ["s1"], followUp: ["f1", "f2"] });
  });

  it("keeps the previous list when the key is absent (older omp, partial frames)", () => {
    expect(parseSessionRuntime({ messageCount: 3 }, previous).queuedMessages).toEqual(
      previous.queuedMessages,
    );
  });

  it("keeps the previous list when the payload is malformed", () => {
    const next = parseSessionRuntime(
      { queuedMessages: { steering: ["s1"], followUp: "f1" } },
      previous,
    );
    expect(next.queuedMessages).toEqual(previous.queuedMessages);
  });

  it("drops non-string entries but keeps the rest", () => {
    expect(
      parseQueuedMessages({ steering: ["s1", 2, null], followUp: [{ text: "x" }, "f1"] }),
    ).toEqual({ steering: ["s1"], followUp: ["f1"] });
  });
});

describe("usageLimit in session state", () => {
  const previous = {
    ...emptySessionRuntime(),
    usageLimit: { stage: "low_priority" as const, resetsAtSec: 1, allowanceLeftPercent: 40, extraUsage: false },
  };

  it("parses usageLimit from a full get_state payload", () => {
    const next = parseSessionRuntime(
      {
        usageLimit: { stage: "wrap_up", resetsAtSec: 1_800, extraUsage: true },
      },
      emptySessionRuntime(),
    );
    expect(next.usageLimit).toEqual({
      stage: "wrap_up",
      resetsAtSec: 1_800,
      allowanceLeftPercent: null,
      extraUsage: true,
    });
  });

  it("keeps previous values when the keys are absent (older omp, partial frames)", () => {
    const next = parseSessionRuntime({ messageCount: 3 }, previous);
    expect(next.usageLimit).toEqual(previous.usageLimit);
  });

  it("reads an unknown stage and a missing stage as null", () => {
    expect(parseUsageLimit({ stage: "sunset", resetsAtSec: 5 })).toBeNull();
    expect(parseUsageLimit({ resetsAtSec: 5 })).toBeNull();
    expect(parseUsageLimit(null)).toBeNull();
    expect(parseUsageLimit("low_priority")).toBeNull();
  });

  it("never reads a prototype-chain stage as a stage", () => {
    expect(parseUsageLimit({ stage: "constructor" })).toBeNull();
    expect(parseUsageLimit({ stage: "toString" })).toBeNull();
  });

  it("an unparseable usageLimit keeps the previous stage, not a reset to null", () => {
    const next = parseSessionRuntime({ usageLimit: { stage: "bogus" } }, previous);
    expect(next.usageLimit).toEqual(previous.usageLimit);
  });
});

describe("parseSubagents", () => {
  it("reads status and completionPercent from the nested progress object", () => {
    const [entry] = parseSubagents({
      subagents: [{ id: "a1", progress: { status: "running", completionPercent: 42 } }],
    });
    expect(entry.status).toBe("running");
    expect(entry.completionPercent).toBe(42);
  });

  it("reads completionPercent from the top level", () => {
    const [entry] = parseSubagents({
      subagents: [{ id: "a1", status: "running", completionPercent: 30 }],
    });
    expect(entry.completionPercent).toBe(30);
  });

  it("leaves completionPercent undefined when the field is absent", () => {
    const [entry] = parseSubagents({ subagents: [{ id: "a1", status: "running" }] });
    expect(entry.completionPercent).toBeUndefined();
  });

  it("drops malformed completionPercent values", () => {
    const [quoted] = parseSubagents({
      subagents: [{ id: "a1", progress: { status: "running", completionPercent: "70" } }],
    });
    const [nan] = parseSubagents({
      subagents: [{ id: "a1", status: "running", completionPercent: NaN }],
    });
    const [nul] = parseSubagents({
      subagents: [{ id: "a1", status: "running", completionPercent: null }],
    });
    expect(quoted.completionPercent).toBeUndefined();
    expect(nan.completionPercent).toBeUndefined();
    expect(nul.completionPercent).toBeUndefined();
  });

  it("clamps completionPercent to the 0-100 range", () => {
    const [high] = parseSubagents({
      subagents: [{ id: "a1", status: "running", completionPercent: 140 }],
    });
    const [low] = parseSubagents({
      subagents: [{ id: "a1", progress: { status: "running", completionPercent: -5 } }],
    });
    expect(high.completionPercent).toBe(100);
    expect(low.completionPercent).toBe(0);
  });

  it("takes status from nested progress when there is no top-level status", () => {
    const [entry] = parseSubagents({
      subagents: [{ id: "a1", progress: { status: "idle" } }],
    });
    expect(entry.status).toBe("idle");
  });
});
