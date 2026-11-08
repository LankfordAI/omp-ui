import { describe, expect, it } from "vitest";
import { telemetryModelDimensions } from "./telemetry-models";

const OTHER = "custom/other";

describe("telemetryModelDimensions", () => {
  it.each([
    ["openai", "gpt-4o"],
    ["anthropic", "claude-sonnet-4-5"],
    ["openrouter", "anthropic/claude-sonnet-4.5"],
    ["openrouter", "deepseek/deepseek-r1"],
    ["google", "gemini-2.5-pro"],
    ["openai-codex", "gpt-5.1-codex"],
    ["xai-oauth", "grok-4"],
    ["amazon-bedrock", "amazon.nova-pro-v1:0"],
  ])("preserves exact bundled public identifiers for %s/%s", (provider, model) => {
    expect(telemetryModelDimensions(provider, model)).toEqual({ provider, model });
  });

  it.each([
    "private-deployment",
    "gpt-4o-company-secret",
    "gpt-4o:private-deployment",
    "gpt-4o@private-route",
    "gpt-4o/private-route",
    "anthropic/claude-sonnet-4.5@private-route",
    "anthropic/claude-sonnet-4.5:company-only",
    "/home/private/models/gpt-4o",
    "https://private.example/v1/gpt-4o?api_key=secret",
    "GPT-4O",
    " gpt-4o",
    "gpt-4o\n",
    "gpt-4o\0private",
    "__proto__",
    "constructor",
    "",
  ])("buckets unknown models without leaking public-looking suffixes: %s", (model) => {
    expect(telemetryModelDimensions("openrouter", model)).toEqual({ provider: "openrouter", model: OTHER });
  });

  it.each([
    "company-internal",
    "openai-private",
    "openai@private-route",
    "openrouter/private-route",
    "https://private.example/v1",
    "/home/private/provider",
    "OPENAI",
    " openai",
    "openai\n",
    "__proto__",
    "constructor",
    "",
  ])("buckets both dimensions for an unknown provider even with a public model: %s", (provider) => {
    expect(telemetryModelDimensions(provider, "gpt-4o")).toEqual({ provider: OTHER, model: OTHER });
  });

  it("preserves recognized public routes even when a private deployment model is unknown", () => {
    expect(telemetryModelDimensions("azure", "company-production-chatgpt")).toEqual({ provider: "azure", model: OTHER });
    expect(telemetryModelDimensions("github-copilot", "company-secret-model")).toEqual({ provider: "github-copilot", model: OTHER });
    expect(telemetryModelDimensions("xai-oauth", "grok-4-private")).toEqual({ provider: "xai-oauth", model: OTHER });
  });

  it("does not treat a search-only credential provider as a model route", () => {
    expect(telemetryModelDimensions("tinyfish", "gpt-4o")).toEqual({ provider: OTHER, model: OTHER });
  });
});
