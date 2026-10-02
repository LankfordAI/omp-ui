import { describe, expect, it } from "vitest";
import {
  emptySessionRuntime,
  modelSupportsFastMode,
  parseQueuedMessages,
  parseSessionRuntime,
  type ModelInfo,
} from "./rpc-types";

const model = (patch: Partial<ModelInfo>): ModelInfo => ({
  id: "m",
  name: "M",
  provider: "test",
  ...patch,
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
