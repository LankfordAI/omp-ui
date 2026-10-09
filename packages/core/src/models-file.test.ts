import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseModelsFileProviders, readModelsFileModelProviders } from "./models-file";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-models-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** An agent dir holding `models.yml` with the given text (null = no file). */
function agentDir(models: string | null): { env: NodeJS.ProcessEnv; dir: string } {
  const root = tmpDir();
  const dir = path.join(root, "agent");
  fs.mkdirSync(dir, { recursive: true });
  if (models !== null) fs.writeFileSync(path.join(dir, "models.yml"), models);
  return { env: { PI_CODING_AGENT_DIR: dir }, dir };
}

describe("parseModelsFileProviders", () => {
  it("recognises the issue's litellm gateway shape", () => {
    // The configuration from issue #814: inline apiKey plus discovery and
    // modelOverrides with a nested compat block.
    const text = [
      "providers:",
      "  litellm:",
      "    baseUrl: https://gateway.example.com",
      "    apiKey: sk-fake-secret-value",
      "    api: openai-completions",
      "    discovery:",
      "      type: litellm",
      "    modelOverrides:",
      "      gateway/claude:",
      "        compat:",
      "          supportsTools: true",
    ].join("\n");
    expect(parseModelsFileProviders(text, {})).toEqual(["litellm"]);
  });

  it("counts apiKeyEnv only when the named variable is non-empty in env", () => {
    const text = [
      "providers:",
      "  gateway:",
      "    baseUrl: https://gateway.example.com",
      "    apiKeyEnv: LITELLM_API_KEY",
    ].join("\n");
    expect(parseModelsFileProviders(text, { LITELLM_API_KEY: "set" })).toEqual(["gateway"]);
    // Unset and empty both count as unconfigured.
    expect(parseModelsFileProviders(text, {})).toEqual([]);
    expect(parseModelsFileProviders(text, { LITELLM_API_KEY: "" })).toEqual([]);
  });

  it("counts a baseUrl-only provider and rejects one with neither key nor baseUrl", () => {
    const text = [
      "providers:",
      "  local:",
      "    baseUrl: http://localhost:8000/v1",
      "  placeholder:",
      "    api: openai-completions",
    ].join("\n");
    expect(parseModelsFileProviders(text, {})).toEqual(["local"]);
  });

  it("treats an empty apiKey or baseUrl value as absent", () => {
    const text = [
      "providers:",
      "  empty:",
      "    apiKey:",
      "    baseUrl:",
    ].join("\n");
    expect(parseModelsFileProviders(text, {})).toEqual([]);
  });

  it("ignores credentials nested deeper than the provider's own keys", () => {
    const text = [
      "providers:",
      "  p:",
      "    baseUrl: http://localhost:1234/v1",
      "    modelOverrides:",
      "      p/some-model:",
      "        apiKey: sk-deep-should-be-ignored",
      "  q:",
      "    models:",
      "      q/one:",
      "        apiKey: sk-deeper-should-be-ignored",
    ].join("\n");
    // p stays usable via its own baseUrl and keeps its name; q's nested apiKey
    // must not mark it usable.
    expect(parseModelsFileProviders(text, {})).toEqual(["p"]);
  });

  it("strips quotes from ids and trailing comments from values", () => {
    const text = [
      "providers:",
      '  "litellm": # gateway provider',
      "    apiKey: 'sk-quoted' # inline comment",
      "  blank:",
      "    baseUrl: # comment only, so no value",
      "    apiKey:",
    ].join("\n");
    expect(parseModelsFileProviders(text, {})).toEqual(["litellm"]);
  });

  it("merges a later top-level providers: block after dedent, deduped by id", () => {
    const text = [
      "providers:",
      "  first:",
      "    apiKey: sk-one",
      "other:",
      "  nested: yes",
      "providers:",
      "  first:",
      "    baseUrl: http://again.example.com",
      "  second:",
      "    baseUrl: http://two.example.com",
    ].join("\n");
    // `first` appears twice but once in the result, in file order.
    expect(parseModelsFileProviders(text, {})).toEqual(["first", "second"]);
  });

  it("skips a comment-only line without ending the block", () => {
    const text = [
      "providers:",
      "  a:",
      "    apiKey: sk-a",
      "  # just a divider",
      "  b:",
      "    baseUrl: http://b.example.com",
    ].join("\n");
    expect(parseModelsFileProviders(text, {})).toEqual(["a", "b"]);
  });

  it("returns [] for flow style, empty text, and garbage", () => {
    expect(parseModelsFileProviders("providers: {}\n", {})).toEqual([]);
    expect(parseModelsFileProviders("providers:\n", {})).toEqual([]);
    expect(parseModelsFileProviders("", {})).toEqual([]);
    expect(parseModelsFileProviders(":::not yaml at all\x00\x01\n\t{[", {})).toEqual([]);
  });
});

describe("readModelsFileModelProviders", () => {
  it("reads the providers block from the agent dir's models.yml", () => {
    const { env, dir } = agentDir(
      ["providers:", "  litellm:", "    apiKey: sk-file-test", "    baseUrl: https://g.example"].join("\n"),
    );
    expect(readModelsFileModelProviders(env, dir)).toEqual(["litellm"]);
  });

  it("honours the env default for the agent dir", () => {
    const { env } = agentDir(["providers:", "  vllm:", "    baseUrl: http://localhost:8000/v1"].join("\n"));
    expect(readModelsFileModelProviders({ ...env })).toEqual(["vllm"]);
  });

  it("returns [] for a missing file or nonexistent dir without throwing", () => {
    const missing = path.join(tmpDir(), "nope");
    expect(() => readModelsFileModelProviders({}, missing)).not.toThrow();
    expect(readModelsFileModelProviders({}, missing)).toEqual([]);

    const { env, dir } = agentDir(null);
    expect(readModelsFileModelProviders(env, dir)).toEqual([]);
  });

  it("returns ids only: no apiKey or baseUrl material leaks out", () => {
    const { env, dir } = agentDir(
      [
        "providers:",
        "  litellm:",
        "    apiKey: sk-must-not-leak",
        "    baseUrl: https://secret-host.example.com/v1",
      ].join("\n"),
    );
    const result = readModelsFileModelProviders(env, dir);
    const json = JSON.stringify(result);
    expect(result).toEqual(["litellm"]);
    expect(json).not.toContain("sk-must-not-leak");
    expect(json).not.toContain("secret-host.example.com");
  });
});
