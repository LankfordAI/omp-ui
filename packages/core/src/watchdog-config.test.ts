import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getWatchdogRoster, parseWatchdogText, serializeWatchdog, setWatchdogRoster } from "./watchdog-config";
import { effectiveAdvisorTools } from "./watchdog";
import type { WatchdogDocument } from "./types";

let root: string;
let env: NodeJS.ProcessEnv;
let home: string;
let agentDir: string;

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const doc = (over: Partial<WatchdogDocument> = {}): WatchdogDocument => ({
  instructions: null, maxNotesPerUpdate: null, advisors: [], ...over,
});
const entry = (name: string, over = {}) => ({
  name, model: null, tools: null, instructions: null, enabled: null, maxNotesPerUpdate: null, ...over,
});

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "wd-")));
  home = path.join(root, "home");
  agentDir = path.join(home, ".omp", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, OMP_CODING_AGENT_DIR: agentDir };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

async function effective(cwd: string | null) {
  const r = await getWatchdogRoster(cwd, env, home);
  if (r.status !== "available") throw new Error(r.message);
  return r;
}

describe("discovery and precedence", () => {
  it("project overrides a same-named user entry wholesale; cwd beats ancestor; root file beats .omp", async () => {
    const repo = path.join(root, "repo");
    const sub = path.join(repo, "pkg");
    write(path.join(repo, ".git", "HEAD"), "");
    write(path.join(agentDir, "WATCHDOG.yml"), "advisors:\n  - name: a\n    model: u/m\n    tools: [read]\n  - name: b\n    model: u/b\n");
    write(path.join(repo, "WATCHDOG.yml"), "advisors:\n  - name: a\n    model: anc/m\n  - name: c\n    model: anc/c\n");
    write(path.join(sub, ".omp", "WATCHDOG.yml"), "advisors:\n  - name: c\n    model: omp/c\n");
    write(path.join(sub, "WATCHDOG.yml"), "advisors:\n  - name: c\n    model: root/c\n");
    const r = await effective(sub);
    const by = Object.fromEntries(r.effective.map((e) => [e.slug, e]));
    expect(r.effective.map((e) => e.slug)).toEqual(["a", "b", "c"]);
    expect(by.a!.model).toBe("anc/m");
    expect(by.a!.toolsExplicit).toBe(false); // whole-entry replace, no field merge
    expect(by.b!.model).toBe("u/b");
    expect(by.c!.model).toBe("root/c");
  });

  it("stops at a .git file and ignores dot-directory bases other than .omp", async () => {
    const repo = path.join(root, "wt");
    const sub = path.join(repo, ".hidden", "x");
    write(path.join(repo, ".git"), "gitdir: elsewhere");
    write(path.join(root, "WATCHDOG.yml"), "advisors:\n  - name: above\n");
    write(path.join(repo, ".hidden", "WATCHDOG.yml"), "advisors:\n  - name: hidden\n");
    write(path.join(repo, "WATCHDOG.yml"), "advisors:\n  - name: inrepo\n");
    fs.mkdirSync(sub, { recursive: true });
    const r = await effective(sub);
    expect(r.effective.map((e) => e.slug)).toEqual(["inrepo"]);
  });

  it("targets .yaml only when .yml is absent", async () => {
    const repo = path.join(root, "r");
    write(path.join(repo, ".git", "HEAD"), "");
    write(path.join(repo, "WATCHDOG.yaml"), "advisors:\n  - name: a\n");
    const r = await effective(repo);
    expect(r.project!.path).toBe(path.join(repo, "WATCHDOG.yaml"));
    write(path.join(repo, "WATCHDOG.yml"), "advisors:\n  - name: b\n");
    expect((await effective(repo)).project!.path).toBe(path.join(repo, "WATCHDOG.yml"));
  });

  it("null scope has no project view", async () => {
    expect((await effective(null)).project).toBeNull();
  });
});

describe("tools rule", () => {
  it("applies defaults, none, alias, dedupe and all-unknown fallback", () => {
    expect(effectiveAdvisorTools(null)).toEqual(["read", "grep", "glob", "recall"]);
    expect(effectiveAdvisorTools([])).toEqual([]);
    expect(effectiveAdvisorTools(["search", "grep", "read"])).toEqual(["grep", "read"]);
    expect(effectiveAdvisorTools(["nope"])).toEqual(["read", "grep", "glob", "recall"]);
  });
});

describe("serialize / parse", () => {
  it("golden output", () => {
    const text = serializeWatchdog(
      doc({
        instructions: "line one\nline two\n",
        maxNotesPerUpdate: 3,
        advisors: [
          entry("Sec Bot", { model: "openai/gpt-5", tools: [], instructions: "  indented\nx", enabled: false }),
          entry("yes", { tools: ["read", "write"], maxNotesPerUpdate: 2 }),
        ],
      }),
    );
    expect(text).toBe(
      [
        "instructions: |2",
        "  line one",
        "  line two",
        "maxNotesPerUpdate: 3",
        "advisors:",
        '  - name: "Sec Bot"',
        "    model: openai/gpt-5",
        "    tools: []",
        '    instructions: "  indented\\nx"',
        "    enabled: false",
        '  - name: "yes"',
        "    tools:",
        "      - read",
        "      - write",
        "    maxNotesPerUpdate: 2",
        "",
      ].join("\n"),
    );
    expect(serializeWatchdog(doc())).toBe("");
  });

  it("round-trips all chomping headers", () => {
    for (const ins of ["a\nb", "a\nb\n", "a\nb\n\n\n", "plain"]) {
      const d = doc({ instructions: ins, advisors: [entry("x", { instructions: ins })] });
      const parsed = parseWatchdogText(serializeWatchdog(d), "f");
      expect(parsed.blocking).toEqual([]);
      expect(parsed.document).toEqual(d);
    }
  });

  it("blocks on syntax errors, non-mapping roots, unknown keys, bad entries and duplicate slugs", () => {
    expect(parseWatchdogText("a: [", "f").blocking).toHaveLength(1);
    expect(parseWatchdogText("- x", "f").blocking).toHaveLength(1);
    expect(parseWatchdogText("foo: 1", "f").blocking[0]).toContain("unknown key");
    expect(parseWatchdogText("advisors:\n  - name: a\n    bar: 1", "f").blocking[0]).toContain("unknown key");
    expect(parseWatchdogText("advisors:\n  - name: a\n    enabled: maybe", "f").blocking[0]).toContain("boolean");
    expect(parseWatchdogText("advisors:\n  - name: 'Sec Bot'\n  - name: sec-bot", "f").blocking[0]).toContain("duplicates");
    expect(parseWatchdogText("maxNotesPerUpdate: 0", "f").blocking).toHaveLength(1);
    expect(parseWatchdogText("# hi\nadvisors:\n  - name: a", "f").notices[0]).toContain("Comments");
  });
});

describe("setWatchdogRoster", () => {
  const userReq = (d: WatchdogDocument, baseHash: string | null = null) => ({
    scopeCwd: null, scope: "user" as const, baseHash, document: d,
  });

  it("writes, rejects stale hash, and deletes on empty", async () => {
    const file = path.join(agentDir, "WATCHDOG.yml");
    const r1 = await setWatchdogRoster(userReq(doc({ advisors: [entry("a")] })), env, home);
    expect(fs.readFileSync(file, "utf8")).toBe("advisors:\n  - name: a\n");
    if (r1.status !== "available") throw new Error("x");
    await expect(setWatchdogRoster(userReq(doc(), "stale"), env, home)).rejects.toThrow(/changed on disk/);
    await setWatchdogRoster(userReq(doc(), r1.user.hash), env, home);
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuses bad requests and lossy files", async () => {
    await expect(
      setWatchdogRoster({ scopeCwd: null, scope: "project", baseHash: null, document: doc() }, env, home),
    ).rejects.toThrow(/project directory/);
    await expect(
      setWatchdogRoster(userReq(doc({ advisors: [entry("Sec Bot"), entry("sec-bot")] })), env, home),
    ).rejects.toThrow(/duplicate/);
    await expect(
      setWatchdogRoster(userReq(doc({ advisors: [entry("a", { tools: ["bogus"] })] })), env, home),
    ).rejects.toThrow(/unknown tool/);
    const file = path.join(agentDir, "WATCHDOG.yml");
    write(file, "mystery: 1\n");
    const r = await effective(null);
    await expect(setWatchdogRoster(userReq(doc(), r.user.hash), env, home)).rejects.toThrow(/refusing/);
    expect(fs.readFileSync(file, "utf8")).toBe("mystery: 1\n");
  });
});
