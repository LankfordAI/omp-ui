import { describe, expect, it } from "vitest";
import { modelSupportsFastMode, type ModelInfo } from "./rpc-types";

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
