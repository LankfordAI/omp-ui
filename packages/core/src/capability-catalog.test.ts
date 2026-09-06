import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getScopedCapabilities,
  matchSkillGlob,
  setScopedCapability,
} from "./capability-catalog";
import type { OmpConfigRunner } from "./omp-settings";

/**
 * The scoped capability catalogs (issue #383, ADR-0025). Everything runs on a
 * fake `config list` runner and a temp filesystem: no omp process, no network,
 * no HOME of the developer — the `mcp-config.ts` testing discipline, applied
 * to the skills/tools half of the viewer.
 */

const dirs: string[] = [];
const savedHome = process.env.HOME;

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

interface Maps {
  /** Values seen in the project cwd (effective). Defaults to the global map. */
  effective?: Record<string, unknown>;
  global?: Record<string, unknown>;
  pristine?: Record<string, unknown>;
  /** A read name whose spawn must reject with this message. */
  reject?: "effective" | "global" | "pristine";
}

function entry(value: unknown, type = "boolean"): unknown {
  return { value, type, description: "d" };
}

/** The published schema defaults of every catalog-relevant key. */
function configMap(over: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    "skills.enabled": entry(true),
    "skills.enableSkillCommands": entry(true),
    "skills.enableCodexUser": entry(false),
    "skills.enableClaudeUser": entry(false),
    "skills.enableClaudeProject": entry(true),
    "skills.enablePiUser": entry(true),
    "skills.enablePiProject": entry(true),
    "skills.enableAgentsUser": entry(true),
    "skills.enableAgentsProject": entry(true),
    "skills.customDirectories": entry([], "array"),
    "skills.ignoredSkills": entry([], "array"),
    "skills.includeSkills": entry([], "array"),
    "ask.enabled": entry(true),
    "astEdit.enabled": entry(true),
    "astGrep.enabled": entry(true),
    "bash.enabled": entry(true),
    "checkpoint.enabled": entry(true),
    "debug.enabled": entry(true),
    "generate_image.enabled": entry(true),
    "github.enabled": entry(true),
    "glob.enabled": entry(true),
    "goal.enabled": entry(false),
    "grep.enabled": entry(true),
    "lsp.enabled": entry(true),
    "security.enabled": entry(true),
    "speechgen.enabled": entry(false),
    "todo.enabled": entry(true),
    "web_search.enabled": entry(true),
  };
  return { ...base, ...over };
}

function fakeRunner(
  maps: Maps,
  projectCwd: string | null,
): OmpConfigRunner & { calls: string[][] } {
  const calls: string[][] = [];
  const run: OmpConfigRunner & { calls: string[][] } = async (args, opts) => {
    calls.push([...args]);
    if (args[0] === "--version") return "omp/18.1.10\n";
    if (!args.includes("--json")) return "";
    const which =
      maps.reject ??
      (args.length === 3 && opts.env.HOME !== process.env.HOME
        ? undefined
        : undefined);
    void which;
    if (maps.reject === "pristine" && opts.env.HOME !== process.env.HOME) {
      throw new Error("pristine boom");
    }
    if (maps.reject === "global" && opts.env.HOME === process.env.HOME && !(projectCwd !== null && opts.cwd === projectCwd)) {
      throw new Error("global boom");
    }
    if (maps.reject === "effective" && projectCwd !== null && opts.cwd === projectCwd) {
      throw new Error("effective boom");
    }
    if (opts.env.HOME !== process.env.HOME) return JSON.stringify(maps.pristine ?? maps.global ?? configMap());
    if (projectCwd !== null && opts.cwd === projectCwd) {
      return JSON.stringify(maps.effective ?? maps.global ?? configMap());
    }
    return JSON.stringify(maps.global ?? configMap());
  };
  run.calls = calls;
  return run;
}

function mkSkill(rootDir: string, dirName: string, frontmatter: string): string {
  const dir = path.join(rootDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "SKILL.md");
  fs.writeFileSync(file, `---\n${frontmatter}\n---\nbody\n`);
  return file;
}

/** A whole scope fixture: HOME, agent dir, project cwd, all initially empty. */
function fixture(): { home: string; agent: string; cwd: string; env: NodeJS.ProcessEnv } {
  const home = tmp("omp-ui-cat-home-");
  const agent = tmp("omp-ui-cat-agent-");
  const cwd = tmp("omp-ui-cat-cwd-");
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  return { home, agent, cwd, env: { PI_CODING_AGENT_DIR: agent } };
}

function withHome(home: string, runTest: () => Promise<void>): Promise<void> {
  process.env.HOME = home;
  return runTest().finally(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
  });
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("matchSkillGlob", () => {
  it("matches the skill-name subset of omp's glob syntax", () => {
    expect(matchSkillGlob("web-*", "web-design")).toBe(true);
    expect(matchSkillGlob("web-*", "webdesign")).toBe(false);
    expect(matchSkillGlob("web-*", "a/web-design")).toBe(false);
    expect(matchSkillGlob("**/design", "a/b/design")).toBe(true);
    expect(matchSkillGlob("sk?ll", "skill")).toBe(true);
    expect(matchSkillGlob("a.b", "axb")).toBe(false);
    expect(matchSkillGlob("*", "anything")).toBe(true);
  });
});

describe("getScopedCapabilities — skills catalog", () => {
  it("lists real roots and rows at project scope with omp's gates", async () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.cwd, ".omp", "skills"), { recursive: true });
    fs.mkdirSync(path.join(f.agent, "skills"), { recursive: true });
    mkSkill(path.join(f.cwd, ".omp", "skills"), "deploy", "name: deploy\ndescription: from the project");
    mkSkill(path.join(f.agent, "skills"), "managed-like", "name: managed-like");
    mkSkill(path.join(f.home, ".claude", "skills"), "unique", "name: unique");
    await withHome(f.home, async () => {
      const result = await getScopedCapabilities(f.cwd, "/bin/omp", f.env, fakeRunner({}, f.cwd));
      expect(result.ompVersion).toBe("18.1.10");
      expect(result.skills.status).toBe("available");
      if (result.skills.status !== "available") return;
      const names = result.skills.items.map((i) => i.name).sort();
      expect(names).toEqual(["deploy", "managed-like", "unique"]);
      const unique = result.skills.items.find((i) => i.name === "unique")!;
      // omp 18.1.10 defaults skills.enableClaudeUser to FALSE: the row lists
      // with its gate off, never silently dropped.
      expect(unique.gateEnabled).toBe(false);
      expect(unique.gateKey).toBe("skills.enableClaudeUser");
      const roots = result.skills.roots.map((r) => r.path);
      expect(roots).toContain(path.join(f.cwd, ".omp", "skills"));
      expect(roots).toContain(path.join(f.home, ".claude", "skills"));
      expect(result.skills.note).toBe("bundles-not-listed");
    });
  });

  it("skips project roots at global scope", async () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.cwd, ".omp", "skills"), { recursive: true });
    mkSkill(path.join(f.cwd, ".omp", "skills"), "proj-only", "name: proj-only");
    await withHome(f.home, async () => {
      const result = await getScopedCapabilities(null, "/bin/omp", f.env, fakeRunner({}, null));
      if (result.skills.status !== "available") throw new Error("unreachable");
      expect(result.skills.items.map((i) => i.name)).not.toContain("proj-only");
      expect(result.skills.roots.some((r) => r.path.startsWith(f.cwd))).toBe(false);
    });
  });

  it("shadows by omp precedence, and a disabled winner shadows nothing", async () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.cwd, ".omp", "skills"), { recursive: true });
    fs.mkdirSync(path.join(f.home, ".claude", "skills"), { recursive: true });
    mkSkill(path.join(f.cwd, ".omp", "skills"), "deploy", "name: deploy");
    mkSkill(path.join(f.home, ".claude", "skills"), "deploy", "name: deploy");
    // Second collision where the winner's ROOT is gated off: omp dedupes
    // authored skills after source toggles, so the enabled lower root loads.
    fs.mkdirSync(path.join(f.cwd, ".claude", "skills"), { recursive: true });
    fs.mkdirSync(path.join(f.cwd, ".agents", "skills"), { recursive: true });
    mkSkill(path.join(f.cwd, ".claude", "skills"), "gated", "name: gated");
    mkSkill(path.join(f.cwd, ".agents", "skills"), "gated", "name: gated");
    await withHome(f.home, async () => {
      const result = await getScopedCapabilities(
        f.cwd,
        "/bin/omp",
        f.env,
        fakeRunner({ global: configMap({ "skills.enableClaudeProject": entry(false) }) }, f.cwd),
      );
      if (result.skills.status !== "available") throw new Error("unreachable");
      const deploy = result.skills.items.filter((i) => i.name === "deploy");
      expect(deploy).toHaveLength(2);
      const loser = deploy.find((i) => i.origin === "claude" && i.scope === "user")!;
      expect(loser.shadowedBy).toContain("pi:");
      expect(deploy.find((i) => i.origin === "pi")!.shadowedBy).toBeNull();

      const gated = result.skills.items.filter((i) => i.name === "gated");
      const claudeGated = gated.find((i) => i.origin === "claude")!;
      const agentsGated = gated.find((i) => i.origin === "agents")!;
      expect(claudeGated.shadowedBy).toBeNull();
      expect(claudeGated.gateEnabled).toBe(false);
      // The gated claude entry claimed nothing: agents loads unshadowed.
      expect(agentsGated.shadowedBy).toBeNull();
    });
  });

  it("applies ignored/include globs and custom-directory override", async () => {
    const f = fixture();
    const custom = tmp("omp-ui-cat-custom-");
    fs.mkdirSync(path.join(f.cwd, ".omp", "skills"), { recursive: true });
    mkSkill(path.join(f.cwd, ".omp", "skills"), "skip-me", "name: skip-me");
    mkSkill(path.join(f.cwd, ".omp", "skills"), "keep-me", "name: keep-me");
    mkSkill(custom, "override", "name: keep-me\ndescription: from custom");
    await withHome(f.home, async () => {
      const result = await getScopedCapabilities(
        f.cwd,
        "/bin/omp",
        f.env,
        fakeRunner(
          {
            global: configMap({
              "skills.ignoredSkills": entry(["skip-*"], "array"),
              "skills.customDirectories": entry([custom], "array"),
            }),
          },
          f.cwd,
        ),
      );
      if (result.skills.status !== "available") throw new Error("unreachable");
      const skip = result.skills.items.find((i) => i.name === "skip-me")!;
      expect(skip.ignored).toBe(true);
      // custom wins the name by omp's rule (issue #7190): the authored row is
      // the shadowed loser now, not the winner.
      const keep = result.skills.items.filter((i) => i.name === "keep-me");
      expect(keep.find((i) => i.origin === "custom")!.shadowedBy).toBeNull();
      expect(keep.find((i) => i.origin === "pi")!.shadowedBy).toContain("custom:");
    });
  });

  it("lists rows under a disabled master gate with switches locked downstream", async () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.cwd, ".omp", "skills"), { recursive: true });
    mkSkill(path.join(f.cwd, ".omp", "skills"), "listed", "name: listed");
    await withHome(f.home, async () => {
      const result = await getScopedCapabilities(
        f.cwd,
        "/bin/omp",
        f.env,
        fakeRunner({ global: configMap({ "skills.enabled": entry(false) }) }, f.cwd),
      );
      if (result.skills.status !== "available") throw new Error("unreachable");
      expect(result.skills.masterEnabled).toBe(false);
      expect(result.skills.items.map((i) => i.name)).toEqual(["listed"]);
    });
  });

  it("reads frontmatter state: disabled in file, hide, name fallback", async () => {
    const f = fixture();
    fs.mkdirSync(path.join(f.cwd, ".omp", "skills"), { recursive: true });
    mkSkill(path.join(f.cwd, ".omp", "skills"), "off", "name: off\nenabled: false");
    mkSkill(path.join(f.cwd, ".omp", "skills"), "hid", "name: hid\nhide: true");
    mkSkill(path.join(f.cwd, ".omp", "skills"), "dirnamed", "description: no name field");
    await withHome(f.home, async () => {
      const result = await getScopedCapabilities(f.cwd, "/bin/omp", f.env, fakeRunner({}, f.cwd));
      if (result.skills.status !== "available") throw new Error("unreachable");
      expect(result.skills.items.find((i) => i.name === "off")!.disabledInFile).toBe(true);
      expect(result.skills.items.find((i) => i.name === "hid")!.hidden).toBe(true);
      // omp's scan: no frontmatter name → the directory name is the skill name.
      expect(result.skills.items.map((i) => i.name)).toContain("dirnamed");
    });
  });

  it("skips a symlinked duplicate of the loaded winner", async () => {
    const f = fixture();
    const root = path.join(f.cwd, ".omp", "skills");
    fs.mkdirSync(root, { recursive: true });
    mkSkill(root, "real", "name: dup");
    fs.symlinkSync(path.join(root, "real"), path.join(root, "mirror"), "dir");
    await withHome(f.home, async () => {
      const result = await getScopedCapabilities(f.cwd, "/bin/omp", f.env, fakeRunner({}, f.cwd));
      if (result.skills.status !== "available") throw new Error("unreachable");
      expect(result.skills.items.filter((i) => i.name === "dup")).toHaveLength(1);
    });
  });

  it("caps the walk at 500 files and says so", async () => {
    const f = fixture();
    const root = path.join(f.cwd, ".omp", "skills");
    fs.mkdirSync(root, { recursive: true });
    for (let i = 0; i < 505; i += 1) mkSkill(root, `s${i}`, `name: s${i}`);
    await withHome(f.home, async () => {
      const result = await getScopedCapabilities(f.cwd, "/bin/omp", f.env, fakeRunner({}, f.cwd));
      if (result.skills.status !== "available") throw new Error("unreachable");
      expect(result.skills.truncated).toBe(true);
      expect(result.skills.items.length).toBeLessThanOrEqual(500);
    });
  }, 30_000);
});

describe("getScopedCapabilities — tools catalog and errors", () => {
  it("maps the published gates with their effective layers", async () => {
    const f = fixture();
    const result = await getScopedCapabilities(
      f.cwd,
      "/bin/omp",
      f.env,
      fakeRunner(
        {
          global: configMap({ "bash.enabled": entry(true) }),
          pristine: configMap({ "bash.enabled": entry(true) }),
          effective: configMap({ "bash.enabled": entry(false), "grep.enabled": entry(false) }),
        },
        f.cwd,
      ),
    );
    expect(result.tools.status).toBe("available");
    if (result.tools.status !== "available") return;
    const bash = result.tools.items.find((i) => i.tool === "bash")!;
    expect(bash).toEqual({ tool: "bash", key: "bash.enabled", enabled: false, layer: "project" });
    const globalOn = result.tools.items.find((i) => i.tool === "web_search")!;
    expect(globalOn.layer).toBe("default");
    // The table's hidden goal tool keeps its own key.
    expect(result.tools.items.find((i) => i.tool === "goal")!.enabled).toBe(false);
  });

  it("drops a key omp no longer publishes and keeps an odd value as null", async () => {
    const global = configMap();
    delete global["todo.enabled"];
    global["glob.enabled"] = { value: "not-a-bool", type: "string", description: "" };
    const result = await getScopedCapabilities(null, "/bin/omp", {}, fakeRunner({ global }, null));
    if (result.tools.status !== "available") throw new Error("unreachable");
    expect(result.tools.items.map((i) => i.tool)).not.toContain("todo");
    expect(result.tools.items.find((i) => i.tool === "glob")!.enabled).toBeNull();
  });

  it("answers per-section errors when the settings read fails or omp is missing", async () => {
    const missing = await getScopedCapabilities(null, null, {}, fakeRunner({}, null));
    expect(missing.skills).toEqual({ status: "error", message: "omp binary not found" });
    expect(missing.tools).toEqual({ status: "error", message: "omp binary not found" });

    const rejected = await getScopedCapabilities(
      null,
      "/bin/omp",
      {},
      fakeRunner({ reject: "global" }, null),
    );
    expect(rejected.skills).toEqual({ status: "error", message: "global boom" });
  });
});

describe("setScopedCapability", () => {
  it("validates before touching a process or a file", async () => {
    const run = fakeRunner({}, null);
    await expect(
      setScopedCapability({ scopeCwd: null, kind: "tool", tool: "rm_rf", enabled: true }, "/bin/omp", {}, run),
    ).rejects.toThrow(/unknown tool gate/);
    await expect(
      setScopedCapability({ scopeCwd: null, kind: "skill-gate", key: "model", enabled: true }, "/bin/omp", {}, run),
    ).rejects.toThrow(/non-gate skills setting/);
    await expect(
      setScopedCapability({ scopeCwd: null, kind: "skill-ignore", name: " ", ignored: true }, "/bin/omp", {}, run),
    ).rejects.toThrow(/unnamed skill/);
    expect(run.calls.filter((args) => args[0] === "config" && args[1] === "set")).toHaveLength(0);
    await expect(
      setScopedCapability({ scopeCwd: null, kind: "tool", tool: "bash", enabled: false }, null, {}, run),
    ).rejects.toThrow("omp binary not found");
  });

  it("writes global booleans through omp config set and answers refreshed", async () => {
    const run = fakeRunner({}, null);
    const result = await setScopedCapability(
      { scopeCwd: null, kind: "tool", tool: "web_search", enabled: false },
      "/bin/omp",
      {},
      run,
    );
    expect(run.calls).toContainEqual(["config", "set", "web_search.enabled", "false", "--json"]);
    expect(result.tools.status).toBe("available");
    expect(result.skills.status).toBe("available");
  });

  it("rewrites the global ignore list from its current value", async () => {
    const run = fakeRunner(
      { global: configMap({ "skills.ignoredSkills": entry(["a"], "array") }) },
      null,
    );
    await setScopedCapability(
      { scopeCwd: null, kind: "skill-ignore", name: "new", ignored: true },
      "/bin/omp",
      {},
      run,
    );
    expect(run.calls).toContainEqual([
      "config",
      "set",
      "skills.ignoredSkills",
      JSON.stringify(["a", "new"]),
      "--json",
    ]);
    const run2 = fakeRunner(
      { global: configMap({ "skills.ignoredSkills": entry(["a", "new"], "array") }) },
      null,
    );
    await setScopedCapability(
      { scopeCwd: null, kind: "skill-ignore", name: "new", ignored: false },
      "/bin/omp",
      {},
      run2,
    );
    expect(run2.calls).toContainEqual([
      "config",
      "set",
      "skills.ignoredSkills",
      JSON.stringify(["a"]),
      "--json",
    ]);
  });

  it("writes project scopes into .omp/config.yml, never through omp", async () => {
    const cwd = tmp("omp-ui-cat-proj-");
    fs.mkdirSync(path.join(cwd, ".omp"));
    const file = path.join(cwd, ".omp", "config.yml");
    fs.writeFileSync(file, "# mine\nbash:\n  enabled: true\n");
    const run = fakeRunner({}, cwd);
    await setScopedCapability(
      { scopeCwd: cwd, kind: "tool", tool: "bash", enabled: false },
      "/bin/omp",
      {},
      run,
    );
    expect(fs.readFileSync(file, "utf8")).toBe("# mine\nbash:\n  enabled: false\n");
    expect(run.calls.filter((args) => args[1] === "set")).toHaveLength(0);
  });

  it("read-modify-writes the project ignore list from the project file", async () => {
    const cwd = tmp("omp-ui-cat-proj-");
    fs.mkdirSync(path.join(cwd, ".omp"));
    const file = path.join(cwd, ".omp", "config.yml");
    fs.writeFileSync(file, "skills:\n  ignoredSkills:\n    - one\n");
    await setScopedCapability(
      { scopeCwd: cwd, kind: "skill-ignore", name: "two", ignored: true },
      "/bin/omp",
      {},
      fakeRunner({}, cwd),
    );
    expect(fs.readFileSync(file, "utf8")).toBe(
      "skills:\n  ignoredSkills:\n    - one\n    - two\n",
    );
  });

  it("refuses a project file whose grammar it cannot see, file untouched", async () => {
    const cwd = tmp("omp-ui-cat-proj-");
    fs.mkdirSync(path.join(cwd, ".omp"));
    const file = path.join(cwd, ".omp", "config.yml");
    fs.writeFileSync(file, "skills: {ignoredSkills: []}\n");
    const before = fs.readFileSync(file, "utf8");
    await expect(
      setScopedCapability(
        { scopeCwd: cwd, kind: "skill-ignore", name: "x", ignored: true },
        "/bin/omp",
        {},
        fakeRunner({}, cwd),
      ),
    ).rejects.toThrow(/config\.yml/);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });
});

