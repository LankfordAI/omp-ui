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
});
