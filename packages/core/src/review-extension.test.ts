import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as module from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import ts from "@typescript/typescript6";
import { afterEach, describe, expect, it } from "vitest";
import { CODE_REVIEW_COMMAND, CODE_REVIEW_TOOL } from "./review";
import type { ReviewDocument } from "./review-config";
import { reviewExtensionPath, writeReviewExtension } from "./review-extension";
import { writeReviewRosterSnapshot } from "./review-roster-snapshot";
import { typecheckGeneratedExtension } from "./generated-extension-test-utils";

const nodeRequire = module.createRequire(import.meta.url);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

type TextResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

interface ToolDefinition {
  name: string;
  description: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: Record<string, unknown> | undefined,
  ) => Promise<TextResult>;
}

interface Harness {
  dir: string;
  commands: Map<string, (args: string, ctx: Record<string, unknown>) => Promise<void>>;
  tool: ToolDefinition;
  sends: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }>;
}

function harness(options: { sendThrows?: boolean; withoutSend?: boolean } = {}): Harness {
  const dir = tempDir("omp-ui-review-ext-");
  const file = writeReviewExtension(dir);
  expect(file).toBe(reviewExtensionPath(dir));
  typecheckGeneratedExtension(file);
  const source = fs.readFileSync(file, "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  });
  const loaded = { exports: {} as { default?: (api: unknown) => void } };
  Function("module", "exports", "require", outputText)(loaded, loaded.exports, nodeRequire);
  const factory = loaded.exports.default;
  if (!factory) throw new Error("generated code-review extension has no default factory");

  const sends: Harness["sends"] = [];
  const commands = new Map<string, (args: string, ctx: Record<string, unknown>) => Promise<void>>();
  let tool: ToolDefinition | null = null;
  const z: unknown = new Proxy(() => z, { get: () => z, apply: () => z });

  factory({
    cwd: process.cwd(),
    zod: { object: () => z, string: () => z },
    registerCommand: (name: string, opts: { handler: (args: string, ctx: Record<string, unknown>) => Promise<void> }) => {
      commands.set(name, opts.handler);
    },
    registerTool: (def: ToolDefinition) => {
      tool = def;
    },
    sendMessage: options.withoutSend
      ? undefined
      : async (message: Record<string, unknown>, opts: Record<string, unknown>): Promise<void> => {
          if (options.sendThrows) throw new Error("send exploded");
          sends.push({ message, options: opts });
        },
  });
  if (tool === null) throw new Error("generated code-review extension registered no tool");
  return { dir, commands, tool, sends };
}

const DEFAULT_ROSTER: ReviewDocument = {
  instructions: "find bugs",
  reviewers: [
    { name: "sec", model: "vllm/gemma-4-31b-it", instructions: null, targets: null, enabled: true },
    { name: "nit", model: null, instructions: null, targets: null, enabled: false },
  ],
};

/** Snapshots the document the way main does at spawn: project scope, no global. */
async function loadRoster(h: Harness, roster: ReviewDocument = DEFAULT_ROSTER): Promise<void> {
  await writeReviewRosterSnapshot(h.dir, null, roster);
}

const GIT_ID = ["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false"];

function git(repo: string, ...args: string[]): string {
  return childProcess.execFileSync("git", [...GIT_ID, "-C", repo, ...args], { encoding: "utf8" }).trim();
}

function commitFile(repo: string, name: string, content: string): string {
  fs.writeFileSync(path.join(repo, name), content);
  git(repo, "add", name);
  git(repo, "commit", "-q", "-m", `add ${name}`);
  return git(repo, "rev-parse", "HEAD");
}

/** A repo on branch `work` (not a base candidate) with one root commit. */
function makeRepo(): string {
  const repo = path.join(tempDir("omp-ui-review-repo-"), "repo");
  fs.mkdirSync(repo, { recursive: true });
  childProcess.execFileSync("git", ["init", "-q", "-b", "work", repo]);
  commitFile(repo, "f.txt", "hello\n");
  return repo;
}

/** Adds a bare `origin`, pushes `work`, and tracks origin/work from `work`. */
function addOrigin(repo: string): void {
  const origin = path.join(path.dirname(repo), "origin.git");
  childProcess.execFileSync("git", ["init", "-q", "--bare", origin]);
  git(repo, "remote", "add", "origin", origin);
  git(repo, "push", "-q", "-u", "origin", "work");
}

async function runCommand(h: Harness, args: string, cwd: string): Promise<{ text: string; level: string }> {
  const notes: Array<{ text: string; level: string }> = [];
  await h.commands.get(CODE_REVIEW_COMMAND)!(args, {
    cwd,
    ui: { notify: (text: string, level: string) => notes.push({ text, level }) },
  });
  expect(notes).toHaveLength(1);
  return notes[0]!;
}

function runTool(h: Harness, target: unknown, cwd: string, signal?: AbortSignal): Promise<TextResult> {
  return h.tool.execute("id", target === undefined ? {} : { target }, signal, undefined, { cwd });
}

/** The fenced batch JSON the launch prompt carries, backreference-matched. */
function batchJson(h: Harness): { context: string; tasks: Array<Record<string, unknown>> } {
  expect(h.sends).toHaveLength(1);
  const content = String(h.sends[0]!.message.content);
  const match = /(`{3,})json\n([\s\S]*?)\n\1/.exec(content);
  if (match === null) throw new Error("no fenced batch JSON in:\n" + content);
  return JSON.parse(match[2]!) as { context: string; tasks: Array<Record<string, unknown>> };
}

function brief(h: Harness): string {
  return String(batchJson(h).tasks[0]!.task);
}

const emptyTree = (repo: string): string =>
  childProcess.execFileSync("git", ["-C", repo, "hash-object", "-t", "tree", "--stdin"], { input: "", encoding: "utf8" }).trim();

describe("generated code-review extension", () => {
  it("registers the command and the namespaced tool", () => {
    const h = harness();
    expect(h.commands.has(CODE_REVIEW_COMMAND)).toBe(true);
    expect(h.tool.name).toBe(CODE_REVIEW_TOOL);
  });

  it("launches one batch through pi.sendMessage with the snapshot roster", async () => {
    const h = harness();
    const repo = makeRepo();
    await loadRoster(h);
    const result = await runTool(h, { kind: "commit", value: "HEAD" }, repo);
    expect(result.isError).toBeUndefined();
    const send = h.sends[0]!;
    expect(send.options).toEqual({ deliverAs: "nextTurn", triggerTurn: true });
    expect(send.message.customType).toBe("omp-ui-code-review-launch");
    expect(send.message.display).toBe(false);
    const json = batchJson(h);
    expect(json.context).toContain("find bugs");
    expect(json.tasks.map((t) => t.name)).toEqual(["review-sec"]); // nit is disabled
    expect(json.tasks[0]!.model).toBe("vllm/gemma-4-31b-it");
    expect(brief(h)).toContain(`Review commit ${git(repo, "rev-parse", "HEAD")} (\`HEAD\`)`);
  });

  it("launches exactly what a Settings-written roster holds", async () => {
    const h = harness();
    const repo = makeRepo();
    await loadRoster(h, {
      instructions: "Top line\nsecond",
      reviewers: [{ name: "sec", model: "a/b:high", instructions: "Line one\nLine two", targets: null, enabled: true }],
    });
    await runTool(h, undefined, repo);
    const json = batchJson(h);
    expect(json.tasks.map((t) => t.name)).toEqual(["review-sec"]);
    expect(json.tasks[0]!.model).toBe("a/b:high");
    expect(String(json.tasks[0]!.task)).toContain("Line one\nLine two");
    expect(json.context).toContain("Top line\nsecond");
  });

  it("drops entries app state cannot hold cleanly, and their warnings ride the status", async () => {
    const h = harness();
    const repo = makeRepo();
    const roster: ReviewDocument = {
      instructions: null,
      reviewers: [
        { name: "ok", model: "x/y:high", instructions: null, targets: null, enabled: true },
        { name: "off", model: null, instructions: null, targets: null, enabled: false },
        { name: "c", model: null, instructions: null, targets: null, enabled: true },
        { name: "C", model: null, instructions: null, targets: null, enabled: true },
        { name: "!!", model: null, instructions: null, targets: null, enabled: true },
      ],
    };
    await loadRoster(h, roster);
    const result = await runTool(h, undefined, repo);
    expect(result.isError).toBeUndefined();
    expect(result.content[0]!.text).toMatch(/Config warnings/);
    const json = batchJson(h);
    expect(json.tasks.map((t) => t.name)).toEqual(["review-ok", "review-c"]);
    expect(json.tasks.find((t) => t.name === "review-ok")!.model).toBe("x/y:high");
  });

  describe("targets", () => {
    it("a pr-only reviewer sits out a local review", async () => {
      const h = harness();
      const repo = makeRepo();
      await loadRoster(h, {
        instructions: null,
        reviewers: [
          { name: "gh-only", model: null, instructions: null, targets: ["pr"], enabled: true },
          { name: "all", model: null, instructions: null, targets: null, enabled: true },
        ],
      });
      await runTool(h, undefined, repo);
      expect(batchJson(h).tasks.map((t) => t.name)).toEqual(["review-all"]);
    });

    it("refuses when no reviewer covers the kind, or none is enabled", async () => {
      const h = harness();
      const repo = makeRepo();
      await loadRoster(h, {
        instructions: null,
        reviewers: [
          { name: "gh-only", model: null, instructions: null, targets: ["pr"], enabled: true },
          { name: "none", model: null, instructions: null, targets: [], enabled: true },
        ],
      });
      const uncovered = await runTool(h, undefined, repo);
      expect(uncovered.isError).toBe(true);
      expect(uncovered.content[0]!.text).toMatch(/covers local/);
      await loadRoster(h, {
        instructions: null,
        reviewers: [{ name: "only", model: null, instructions: null, targets: null, enabled: false }],
      });
      const empty = await runTool(h, undefined, repo);
      expect(empty.isError).toBe(true);
      expect(empty.content[0]!.text).toMatch(/roster is empty/);
      expect(h.sends).toHaveLength(0);
    });
  });

  describe("range", () => {
    function featureRepo(): { repo: string; work: string; feature: string } {
      const repo = makeRepo();
      const work = git(repo, "rev-parse", "HEAD");
      git(repo, "checkout", "-q", "-b", "feature");
      commitFile(repo, "g1.txt", "one\n");
      const feature = commitFile(repo, "g2.txt", "two\n");
      git(repo, "checkout", "-q", "work");
      return { repo, work, feature };
    }

    it("hands reviewers a three-dot diff that git runs", async () => {
      const h = harness();
      const { repo, work, feature } = featureRepo();
      await loadRoster(h);
      const result = await runTool(h, { kind: "commit", value: "work..feature" }, repo);
      expect(result.isError).toBeUndefined();
      const text = brief(h);
      expect(text).toContain(`git diff ${work}...${feature}`);
      const range = /`git diff ([0-9a-f]+\.\.\.[0-9a-f]+)`/.exec(text)![1]!;
      const names = childProcess.execFileSync("git", ["-C", repo, "diff", "--name-only", range], { encoding: "utf8" });
      expect(names.split("\n")).toEqual(expect.arrayContaining(["g1.txt", "g2.txt"]));
    });

    it("refuses empty, unknown, and three-dot ranges", async () => {
      const h = harness();
      const { repo } = featureRepo();
      await loadRoster(h);
      const backwards = await runTool(h, { kind: "commit", value: "feature..work" }, repo);
      expect(backwards.content[0]!.text).toMatch(/carries no commits/);
      const unknown = await runTool(h, { kind: "commit", value: "work..nope" }, repo);
      expect(unknown.content[0]!.text).toMatch(/Not a commit in this repository: nope/);
      const threeDot = await runCommand(h, "work...feature", repo);
      expect(threeDot.text).toMatch(/^usage:/);
      expect(threeDot.level).toBe("error");
      expect(h.sends).toHaveLength(0);
    });
  });

  describe("local base", () => {
    it("diffs the upstream merge-base against the working tree", async () => {
      const h = harness();
      const repo = makeRepo();
      addOrigin(repo);
      const base = git(repo, "rev-parse", "HEAD");
      git(repo, "checkout", "-q", "-b", "topic");
      git(repo, "branch", "-q", "--set-upstream-to=origin/work", "topic");
      commitFile(repo, "h.txt", "new\n");
      fs.writeFileSync(path.join(repo, "f.txt"), "edited\n");
      await loadRoster(h);
      const result = await runTool(h, undefined, repo);
      expect(result.content[0]!.text).toContain(`against the merge-base with origin/work (${base.slice(0, 8)})`);
      const text = brief(h);
      expect(/The base is commit ([0-9a-f]+)/.exec(text)![1]).toBe(base);
      expect(git(repo, "diff", "--name-only", base).split("\n")).toEqual(expect.arrayContaining(["f.txt", "h.txt"]));
    });

    it("an upstream with no shared history falls back to HEAD's parent", async () => {
      const h = harness();
      const repo = makeRepo();
      const unrelated = git(repo, "rev-parse", "HEAD");
      git(repo, "checkout", "-q", "--orphan", "lone");
      git(repo, "rm", "-rqf", ".");
      const parent = commitFile(repo, "o1.txt", "one\n");
      commitFile(repo, "o2.txt", "two\n");
      git(repo, "branch", "-q", "--set-upstream-to=work", "lone");
      await loadRoster(h);
      await runTool(h, undefined, repo);
      const text = brief(h);
      expect(text).toContain(`the base is HEAD's parent ${parent}`);
      expect(text).not.toContain(unrelated);
    });

    it("a root commit diffs against the empty tree, staged work included", async () => {
      const h = harness();
      const repo = makeRepo();
      fs.writeFileSync(path.join(repo, "s.txt"), "staged\n");
      git(repo, "add", "s.txt");
      await loadRoster(h);
      await runTool(h, undefined, repo);
      expect(brief(h)).toContain(`the base is the empty tree ${emptyTree(repo)}`);
    });

    it("a clean tree at the upstream tip has nothing to review; an untracked file does", async () => {
      const h = harness();
      const repo = makeRepo();
      addOrigin(repo);
      await loadRoster(h);
      const clean = await runTool(h, undefined, repo);
      expect(clean.isError).toBe(true);
      expect(clean.content[0]!.text).toMatch(/^Nothing to review: no changes against the merge-base with origin\/work/);
      expect(h.sends).toHaveLength(0);
      fs.writeFileSync(path.join(repo, "u.txt"), "untracked\n");
      const untracked = await runTool(h, undefined, repo);
      expect(untracked.isError).toBeUndefined();
      expect(h.sends).toHaveLength(1);
    });
  });

  it.skipIf(process.platform === "win32")("pr asks gh once, read-only, and refuses on a gh failure", async () => {
    const h = harness();
    const repo = makeRepo();
    await loadRoster(h);
    const bin = tempDir("omp-ui-review-gh-");
    const gh = path.join(bin, "gh");
    const head = "a".repeat(40);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    try {
      fs.writeFileSync(gh, `#!/bin/sh\necho '{"headRefOid":"${head}","baseRefName":"main"}'\n`, { mode: 0o755 });
      const ok = await runTool(h, { kind: "pr", value: "5" }, repo);
      expect(ok.isError).toBeUndefined();
      expect(ok.content[0]!.text).toContain("pull request #5 (head aaaaaaaa into main)");
      const text = brief(h);
      expect(text).toContain(`pull request #5 (head ${head} into main)`);
      expect(text).not.toContain("git fetch");
      fs.writeFileSync(gh, "#!/bin/sh\necho 'not logged in' >&2\nexit 1\n", { mode: 0o755 });
      const refused = await runTool(h, { kind: "pr", value: "5" }, repo);
      expect(refused.isError).toBe(true);
      expect(refused.content[0]!.text).toMatch(/not logged in/);
      expect(h.sends).toHaveLength(1);
    } finally {
      process.env.PATH = previousPath;
    }
  });

  it("a cancelled tool call launches nothing", async () => {
    const h = harness();
    const repo = makeRepo();
    await loadRoster(h);
    const controller = new AbortController();
    controller.abort();
    const result = await runTool(h, undefined, repo, controller.signal);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/cancelled/);
    expect(h.sends).toHaveLength(0);
  });

  it("the command reports a queued launch at info, warnings at warning, and usage at error", async () => {
    const h = harness();
    const repo = makeRepo();
    await loadRoster(h);
    const queued = await runCommand(h, "HEAD", repo);
    expect(queued.text).toMatch(/^Queued 1 reviewer\(s\) on HEAD /);
    expect(queued.level).toBe("info");
    await loadRoster(h, {
      instructions: null,
      reviewers: [
        { name: "ok", model: null, instructions: null, targets: null, enabled: true },
        { name: "!!", model: null, instructions: null, targets: null, enabled: true },
      ],
    });
    const warned = await runCommand(h, "HEAD", repo);
    expect(warned.text).toMatch(/Config warnings/);
    expect(warned.level).toBe("warning");
    const usage = await runCommand(h, "pr 0", repo);
    expect(usage).toEqual({ text: "usage: /code-review pr <number>", level: "error" });
  });

  it("without a roster snapshot refuses with a restart hint", async () => {
    const h = harness();
    const repo = makeRepo();
    const result = await runTool(h, undefined, repo);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/restart the session/);
    expect(h.sends).toHaveLength(0);
  });

  it("refuses outside a git checkout", async () => {
    const h = harness();
    const dir = tempDir("omp-ui-review-nogit-");
    await loadRoster(h);
    const result = await runTool(h, undefined, dir);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/git checkout/);
  });

  it("a failed send surfaces as an error, never a fake launch", async () => {
    const h = harness({ sendThrows: true });
    const repo = makeRepo();
    await loadRoster(h);
    const result = await runTool(h, undefined, repo);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/send failed/);
  });

  it("without pi.sendMessage the launch reports the incapability, never a fake launch", async () => {
    const h = harness({ withoutSend: true });
    const repo = makeRepo();
    await loadRoster(h);
    const result = await runTool(h, undefined, repo);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/cannot start/);
  });

  it("shell-shaped args never reach git", async () => {
    const h = harness();
    const repo = makeRepo();
    await loadRoster(h);
    for (const bad of ["`x`", "a|b", "a&&b", "-x", "a b", "a\nb", "..", "a..b..c"]) {
      const note = await runCommand(h, bad, repo);
      expect(note.text).toMatch(/^usage:/);
      expect(note.level).toBe("error");
    }
    expect(h.sends).toHaveLength(0);
  });
});
