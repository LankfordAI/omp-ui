import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  formatModelRole,
  getOmpAgentDir,
  parseModelRole,
  readOmpAdvisorDefaults,
  readOmpModelRole,
} from "./omp-config";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-cfg-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseModelRole", () => {
  it("splits omp's :level thinking suffix off the model id", () => {
    expect(parseModelRole("openrouter/anthropic/claude-opus-5:high")).toEqual({
      model: "openrouter/anthropic/claude-opus-5",
      level: "high",
    });
  });

  it("keeps a bare selector whole", () => {
    expect(parseModelRole("openrouter/openai/gpt-5.6-luna")).toEqual({
      model: "openrouter/openai/gpt-5.6-luna",
    });
  });

  it("leaves a non-level colon suffix on the model id", () => {
    // OpenRouter ships ids like `model:exacto`; splitting it would resolve to a
    // different model, so only a bare alphabetic tail counts as a level.
    expect(parseModelRole("openrouter/openai/gpt-5:exacto-2")).toEqual({
      model: "openrouter/openai/gpt-5:exacto-2",
    });
  });

  it("treats an empty selector as unset", () => {
    expect(parseModelRole("   ")).toBeNull();
  });

  it("round-trips through formatModelRole", () => {
    for (const value of ["a/b:high", "a/b", "x/y:exacto-2"]) {
      expect(formatModelRole(parseModelRole(value)!)).toBe(value);
    }
  });
});

describe("getOmpAgentDir", () => {
  it("resolves the default profile's agent dir under $HOME", () => {
    expect(getOmpAgentDir({})).toBe(path.join(os.homedir(), ".omp", "agent"));
  });

  it("nests named profiles, ignoring PI_CODING_AGENT_DIR", () => {
    // Matches omp: the explicit agent-dir override applies to the DEFAULT
    // profile only, so a profile must not silently inherit it.
    expect(getOmpAgentDir({ OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/elsewhere" })).toBe(
      path.join(os.homedir(), ".omp", "profiles", "work", "agent"),
    );
  });

  it("honours PI_CODING_AGENT_DIR for the default profile", () => {
    expect(getOmpAgentDir({ PI_CODING_AGENT_DIR: "/custom/agent" })).toBe("/custom/agent");
  });
});

describe("readOmpAdvisorDefaults", () => {
  /** Lays out an agent dir the way omp does, and returns the env pointing at it. */
  function agentDir(config: string | null): NodeJS.ProcessEnv {
    const root = tmpDir();
    const agent = path.join(root, "agent");
    fs.mkdirSync(agent, { recursive: true });
    if (config !== null) fs.writeFileSync(path.join(agent, "config.yml"), config);
    return { PI_CODING_AGENT_DIR: agent };
  }

  it("reads advisor.enabled and modelRoles.advisor from the global config", () => {
    const env = agentDir(
      [
        "modelRoles: ",
        "  advisor: openrouter/anthropic/claude-opus-5:high",
        "  default: openrouter/anthropic/claude-opus-5:high",
        "symbolPreset: unicode",
        "advisor: ",
        "  enabled: true",
        "",
      ].join("\n"),
    );
    expect(readOmpAdvisorDefaults(tmpDir(), env)).toEqual({
      enabled: true,
      role: { model: "openrouter/anthropic/claude-opus-5", level: "high" },
    });
  });

  it("matches omp's own defaults when nothing is configured", () => {
    expect(readOmpAdvisorDefaults(tmpDir(), agentDir(null))).toEqual({
      enabled: false,
      role: null,
    });
  });

  it("lets the project config override the global advisor role", () => {
    const env = agentDir("modelRoles:\n  advisor: global/model\nadvisor:\n  enabled: true\n");
    const project = tmpDir();
    fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".omp", "config.yml"),
      "modelRoles:\n  advisor: project/model\n",
    );
    expect(readOmpAdvisorDefaults(project, env)).toEqual({
      // Project wins on the role but says nothing about `enabled`, which must
      // therefore survive from the global layer rather than reset to false.
      enabled: true,
      role: { model: "project/model" },
    });
  });

  it("ignores a same-named key nested under a different parent", () => {
    // `tier.advisor` is a real omp setting; reading it as the model role would
    // pin the advisor to a service-tier string.
    const env = agentDir("tier:\n  advisor: priority\nmodelRoles:\n  default: a/b\n");
    expect(readOmpAdvisorDefaults(tmpDir(), env).role).toBeNull();
  });

  it("strips comments and quotes from a scalar", () => {
    const env = agentDir('modelRoles:\n  advisor: "a/b:high"   # the reviewer\n');
    expect(readOmpAdvisorDefaults(tmpDir(), env).role).toEqual({ model: "a/b", level: "high" });
  });

  it("degrades to unset rather than throwing on an unreadable config", () => {
    // A directory where config.yml belongs: readFileSync throws EISDIR.
    const root = tmpDir();
    const agent = path.join(root, "agent");
    fs.mkdirSync(path.join(agent, "config.yml"), { recursive: true });
    expect(readOmpAdvisorDefaults(tmpDir(), { PI_CODING_AGENT_DIR: agent })).toEqual({
      enabled: false,
      role: null,
    });
  });
});

describe("readOmpModelRole", () => {
  function agentDir(config: string | null): NodeJS.ProcessEnv {
    const root = tmpDir();
    const agent = path.join(root, "agent");
    fs.mkdirSync(agent, { recursive: true });
    if (config !== null) fs.writeFileSync(path.join(agent, "config.yml"), config);
    return { PI_CODING_AGENT_DIR: agent };
  }

  it("takes the first role the config actually binds", () => {
    // `tiny` is unset, so the chain must fall through to `smol` rather than
    // stopping at the first name it was asked about.
    const env = agentDir("modelRoles:\n  smol: a/smol\n  default: a/default\n");
    expect(readOmpModelRole(tmpDir(), ["tiny", "commit", "smol"], env)).toEqual({
      model: "a/smol",
    });
  });

  it("prefers an earlier role over a later one", () => {
    const env = agentDir("modelRoles:\n  tiny: a/tiny:medium\n  smol: a/smol\n");
    expect(readOmpModelRole(tmpDir(), ["tiny", "commit", "smol"], env)).toEqual({
      model: "a/tiny",
      level: "medium",
    });
  });

  it("lets the project config override the global binding for the same role", () => {
    const env = agentDir("modelRoles:\n  tiny: global/tiny\n");
    const project = tmpDir();
    fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
    fs.writeFileSync(
      path.join(project, ".omp", "config.yml"),
      "modelRoles:\n  tiny: project/tiny\n",
    );
    expect(readOmpModelRole(project, ["tiny", "smol"], env)).toEqual({ model: "project/tiny" });
  });

  it("returns null when the config binds none of the roles", () => {
    const env = agentDir("modelRoles:\n  default: a/default\n");
    expect(readOmpModelRole(tmpDir(), ["tiny", "commit", "smol"], env)).toBeNull();
  });
});
