import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEWER,
  parseReviewDocument,
  readReviewRoster,
  serializeReviewDocument,
  setReviewRoster,
  type ReviewDocument,
} from "./review-config";

let root: string;
let env: NodeJS.ProcessEnv;
let home: string;
let agentDir: string;

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
const doc = (over: Partial<ReviewDocument> = {}): ReviewDocument => ({
  instructions: null,
  reviewers: [],
  ...over,
});
const entry = (name: string, over = {}) => ({
  name,
  model: null,
  instructions: null,
  targets: null,
  enabled: true,
  ...over,
});

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rv-")));
  home = path.join(root, "home");
  agentDir = path.join(home, ".omp", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  env = { ...process.env, PI_CODING_AGENT_DIR: agentDir };
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("discovery and precedence", () => {
  it("project overrides a same-named user entry wholesale; cwd beats ancestor", async () => {
    const repo = path.join(root, "repo");
    const sub = path.join(repo, "pkg");
    write(path.join(repo, ".git", "HEAD"), "");
    write(path.join(agentDir, "REVIEW.yml"), "reviewers:\n  - name: a\n    model: u/m\n  - name: b\n    model: u/b\n");
    write(path.join(repo, "REVIEW.yml"), "reviewers:\n  - name: a\n    model: anc/m\n  - name: c\n");
    write(path.join(sub, "REVIEW.yml"), "reviewers:\n  - name: c\n    model: cwd/c\n");
    const r = await readReviewRoster(sub, env, home);
    const by = Object.fromEntries(r.effective.map((e) => [e.name, e]));
    expect(r.effective.map((e) => e.name)).toEqual(["a", "b", "c"]);
    expect(by.a!.model).toBe("anc/m"); // whole-entry replace, no field merge
    expect(by.a!.sourceScope).toBe("project");
    expect(by.b!.model).toBe("u/b");
    expect(by.b!.sourceScope).toBe("user");
    expect(by.c!.model).toBe("cwd/c");
  });

  it("stops at a .git file", async () => {
    const repo = path.join(root, "wt");
    write(path.join(repo, ".git"), "gitdir: /elsewhere");
    write(path.join(root, "REVIEW.yml"), "reviewers:\n  - name: outside\n");
    write(path.join(repo, "REVIEW.yml"), "reviewers:\n  - name: inside\n");
    const r = await readReviewRoster(repo, env, home);
    expect(r.effective.map((e) => e.name)).toEqual(["inside"]);
  });

  it("the default roster answers when no file exists anywhere", async () => {
    const r = await readReviewRoster(path.join(root, "bare"), env, home);
    expect(r.effective).toHaveLength(1);
    expect(r.effective[0]!.name).toBe(DEFAULT_REVIEWER.name);
    expect(r.effective[0]!.model).toBeNull();
    expect(r.configWarnings).toEqual([]);
  });

  it("targets filtering keeps disabled entries visible but unlaunched", async () => {
    write(
      path.join(agentDir, "REVIEW.yml"),
      "reviewers:\n  - name: on-entry\n  - name: off-entry\n    enabled: false\n  - name: pr-only\n    targets: [pr]\n",
    );
    const r = await readReviewRoster(null, env, home);
    expect(r.effective.map((e) => e.name)).toEqual(["on-entry", "off-entry", "pr-only"]);
    expect(r.reviewers.map((e) => e.name)).toEqual(["on-entry", "pr-only"]);
    expect(r.effective[2]!.targets).toEqual(["pr"]);
  });

  it("a parse error is a warning, not a broken roster", async () => {
    write(path.join(agentDir, "REVIEW.yml"), "reviewers:\n  - name: good\n");
    const repo = path.join(root, "repo");
    write(path.join(repo, ".git", "HEAD"), "");
    write(path.join(repo, "REVIEW.yml"), "mystery: 1\n");
    const r = await readReviewRoster(repo, env, home);
    expect(r.effective.map((e) => e.name)).toEqual(["good"]);
    expect(r.configWarnings.join(" ")).toMatch(/unknown key "mystery"/);
  });

  it("later instructions win", async () => {
    const repo = path.join(root, "repo");
    write(path.join(repo, ".git", "HEAD"), "");
    write(path.join(agentDir, "REVIEW.yml"), "instructions: user\nreviewers: []\n");
    write(path.join(repo, "REVIEW.yml"), "instructions: project\n");
    const r = await readReviewRoster(repo, env, home);
    expect(r.instructions).toBe("project");
  });
});

describe("serialize / parse", () => {
  it("golden output", () => {
    const text = serializeReviewDocument(
      doc({
        instructions: "be thorough",
        reviewers: [
          entry("security", { model: "anthropic/claude-opus:high", targets: ["local", "pr"] }),
          entry("nitpicker", { enabled: false }),
          entry("silent"),
        ],
      }),
    );
    expect(text).toBe(
      'instructions: "be thorough"\n' +
        "reviewers:\n" +
        "  - name: security\n" +
        '    model: "anthropic/claude-opus:high"\n' +
        "    targets:\n" +
        "      - local\n" +
        "      - pr\n" +
        "  - name: nitpicker\n" +
        "    enabled: false\n" +
        "  - name: silent\n",
    );
  });

  it("round-trips", () => {
    const original = doc({
      instructions: "multi\nline\nguidance\n",
      reviewers: [entry("a", { instructions: "look at tests", model: "vllm/x:low" })],
    });
    const text = serializeReviewDocument(original);
    const { document, blocking } = parseReviewDocument(text, "REVIEW.yml");
    expect(blocking).toEqual([]);
    expect(document).toEqual(original);
  });

  it("blocks on syntax errors, non-mapping roots, unknown keys, bad entries and duplicate slugs", () => {
    expect(parseReviewDocument("\t bad: [", "f").blocking.join()).toMatch(/YAML syntax error/);
    expect(parseReviewDocument("- 1\n", "f").blocking.join()).toMatch(/not a mapping/);
    expect(parseReviewDocument("nope: 1\n", "f").blocking.join()).toMatch(/unknown key "nope"/);
    expect(parseReviewDocument("reviewers:\n  - model: x\n", "f").blocking.join()).toMatch(/needs a name/);
    expect(parseReviewDocument("reviewers:\n  - name: a\n    model: [1]\n", "f").blocking.join()).toMatch(/model must be/);
    expect(parseReviewDocument("reviewers:\n  - name: a\n    targets: [bogus]\n", "f").blocking.join()).toMatch(/targets must name/);
    expect(parseReviewDocument("reviewers:\n  - name: a\n  - name: A\n", "f").blocking.join()).toMatch(/duplicates/);
    expect(parseReviewDocument("reviewers:\n  - name: 9bad\n", "f").blocking.join()).toMatch(/\[a-z\]/);
  });

  it("accepts nulls and boolean enabled", () => {
    const { document, blocking } = parseReviewDocument(
      "reviewers:\n  - name: a\n    model: null\n    targets: null\n    enabled: true\n",
      "f",
    );
    expect(blocking).toEqual([]);
    expect(document.reviewers[0]).toEqual({ name: "a", model: null, instructions: null, targets: null, enabled: true });
  });
});

describe("setReviewRoster", () => {
  it("writes, rejects stale hash, and deletes on empty", async () => {
    const repo = path.join(root, "repo");
    write(path.join(repo, ".git", "HEAD"), "");
    const first = await setReviewRoster(
      { scopeCwd: repo, scope: "project", baseHash: null, document: doc({ reviewers: [entry("a", { model: "m/x" })] }) },
      env,
      home,
    );
    const target = path.join(repo, "REVIEW.yml");
    expect(fs.existsSync(target)).toBe(true);
    expect(first.effective[0]!.model).toBe("m/x");
    await expect(
      setReviewRoster({ scopeCwd: repo, scope: "project", baseHash: null, document: doc() }, env, home),
    ).rejects.toThrow(/changed on disk/);
    const reread = await readReviewRoster(repo, env, home);
    await setReviewRoster({ scopeCwd: repo, scope: "project", baseHash: reread.project!.hash, document: doc() }, env, home);
    expect(fs.existsSync(target)).toBe(false);
  });

  it("refuses bad requests and lossy files", async () => {
    const repo = path.join(root, "repo");
    write(path.join(repo, ".git", "HEAD"), "");
    await expect(setReviewRoster({ scopeCwd: null, scope: "project", baseHash: null, document: doc() }, env, home)).rejects.toThrow(
      /project directory/,
    );
    await expect(
      setReviewRoster(
        { scopeCwd: repo, scope: "project", baseHash: null, document: doc({ reviewers: [entry("a"), entry("A")] }) },
        env,
        home,
      ),
    ).rejects.toThrow(/duplicate/);
    write(path.join(repo, "REVIEW.yml"), "mystery: 1\n");
    const stale = await readReviewRoster(repo, env, home);
    await expect(
      setReviewRoster({ scopeCwd: repo, scope: "project", baseHash: stale.project!.hash, document: doc() }, env, home),
    ).rejects.toThrow(/refusing/);
    expect(fs.readFileSync(path.join(repo, "REVIEW.yml"), "utf8")).toBe("mystery: 1\n");
  });
});
