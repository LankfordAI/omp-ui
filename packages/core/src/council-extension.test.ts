import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as module from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { COUNCIL_AGENT, COUNCIL_COMMAND, COUNCIL_LAUNCH_TYPE, COUNCIL_PR_USAGE, COUNCIL_TOOL, COUNCIL_USAGE } from "./council";
import { resolveCouncilRoster, type CouncilDocument, type CouncilRosterResult } from "./council-config";
import { councilExtensionDir, councilExtensionPath, writeCouncilExtension } from "./council-extension";
import { councilRosterSnapshotPath, writeCouncilRosterSnapshot } from "./council-roster-snapshot";
import { transpileGeneratedExtension, typecheckGeneratedExtension } from "./generated-extension-test-utils";

const nodeRequire = module.createRequire(import.meta.url);
const dirs: string[] = [];

afterEach(() => {
  // A git child spawned in the temp repo can still hold it as its cwd when the
  // test returns (an already-aborted signal makes execFile reject before git
  // exits), and Windows then refuses the removal with EBUSY even though every
  // assertion passed. git.test.ts and worktree.test.ts ride out the same lock;
  // this harness matches them (issue #948).
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
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
  const dir = tempDir("omp-ui-council-ext-");
  expect(writeCouncilExtension(dir)).toBe(councilExtensionDir(dir));
  const file = councilExtensionPath(dir);
  typecheckGeneratedExtension(file);
  const source = fs.readFileSync(file, "utf8");
  const outputText = transpileGeneratedExtension(source, "cjs");
  const loaded = { exports: {} as { default?: (api: unknown) => void } };
  Function("module", "exports", "require", outputText)(loaded, loaded.exports, nodeRequire);
  const factory = loaded.exports.default;
  if (!factory) throw new Error("generated council extension has no default factory");

  const sends: Harness["sends"] = [];
  const commands = new Map<string, (args: string, ctx: Record<string, unknown>) => Promise<void>>();
  let tool: ToolDefinition | null = null;
  const z: unknown = new Proxy(() => z, { get: () => z, apply: () => z });

  factory({
    cwd: process.cwd(),
    zod: { object: () => z, string: () => z, boolean: () => z },
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
  if (tool === null) throw new Error("generated council extension registered no tool");
  return { dir, commands, tool, sends };
}

const DEFAULT_COUNCIL: CouncilRosterResult = {
  instructions: "find bugs",
  members: [{ name: "sec", model: "vllm/gemma-4-31b-it", instructions: null, enabled: true }],
  trial: null,
  configWarnings: [],
};

/** Snapshots a resolved council the way main does at spawn. */
function loadCouncil(h: Harness, council: CouncilRosterResult = DEFAULT_COUNCIL): void {
  writeCouncilRosterSnapshot(h.dir, council);
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
  const repo = path.join(tempDir("omp-ui-council-repo-"), "repo");
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
  await h.commands.get(COUNCIL_COMMAND)!(args, {
    cwd,
    ui: { notify: (text: string, level: string) => notes.push({ text, level }) },
  });
  expect(notes).toHaveLength(1);
  return notes[0]!;
}

function runTool(h: Harness, params: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<TextResult> {
  return h.tool.execute("id", params, signal, undefined, { cwd });
}

/** A review-mode tool call; `target` undefined reviews local changes. */
function runReview(h: Harness, target: unknown, cwd: string, signal?: AbortSignal): Promise<TextResult> {
  return runTool(h, target === undefined ? { review: true } : { review: true, target }, cwd, signal);
}

function launchPrompt(h: Harness): string {
  expect(h.sends).toHaveLength(1);
  return String(h.sends[0]!.message.content);
}

/** Every fenced batch JSON block the launch prompt carries, backreference-matched, in order. */
function batchJsons(h: Harness): Array<{ context: string; tasks: Array<Record<string, unknown>> }> {
  const content = launchPrompt(h);
  const blocks = [...content.matchAll(/(`{3,})json\n([\s\S]*?)\n\1/g)];
  if (blocks.length === 0) throw new Error("no fenced batch JSON in:\n" + content);
  return blocks.map((match) => JSON.parse(match[2]!) as { context: string; tasks: Array<Record<string, unknown>> });
}

/** The first fenced batch JSON the launch prompt carries = the council batch. */
function batchJson(h: Harness): { context: string; tasks: Array<Record<string, unknown>> } {
  return batchJsons(h)[0]!;
}

function brief(h: Harness): string {
  return String(batchJson(h).tasks[0]!.task);
}

const emptyTree = (repo: string): string =>
  childProcess.execFileSync("git", ["-C", repo, "hash-object", "-t", "tree", "--stdin"], { input: "", encoding: "utf8" }).trim();

describe("generated council extension", () => {
  it("registers the command and the namespaced tool", () => {
    const h = harness();
    expect(h.commands.has(COUNCIL_COMMAND)).toBe(true);
    expect(h.tool.name).toBe(COUNCIL_TOOL);
  });

  it("writes a package omp loads as a directory root, with the council agent beside the bridge", () => {
    const dir = tempDir("omp-ui-council-pkg-");
    const root = writeCouncilExtension(dir);
    expect(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))).toEqual({
      name: "omp-ui-council",
      private: true,
      omp: { extensions: ["./omp-ui-council.ts"] },
    });
    expect(fs.existsSync(path.join(root, "omp-ui-council.ts"))).toBe(true);
    const agent = fs.readFileSync(path.join(root, "agents", "omp-ui-council.md"), "utf8");
    expect(agent).toMatch(/^---\nname: omp-ui-council\n[\s\S]*\ntools: read, grep, find, bash\n---\n/);
    expect(agent).toContain("Never edit or create files");
  });

  describe("ask", () => {
    it("launches one batch of council-agent items carrying each member's model and the request", async () => {
      const h = harness();
      const cwd = tempDir("omp-ui-council-ask-"); // ask mode needs no git checkout
      loadCouncil(h, {
        instructions: null,
        members: [
          { name: "sol", model: "openai/gpt-6-sol", instructions: "Think about cost.", enabled: true },
          { name: "opus", model: "anthropic/claude-opus-5.5", instructions: null, enabled: true },
        ],
        trial: null,
        configWarnings: [],
      });
      const note = await runCommand(h, "is the cache invalidation safe?", cwd);
      expect(note).toEqual({
        text: "Asked 2 council member(s) on (ask). The session model starts them on its next turn; answers arrive as background results.",
        level: "info",
      });
      const send = h.sends[0]!;
      expect(send.options).toEqual({ deliverAs: "nextTurn", triggerTurn: true });
      expect(send.message.customType).toBe(COUNCIL_LAUNCH_TYPE);
      expect(send.message.display).toBe(false);
      const json = batchJson(h);
      expect(json.context).toMatch(/^omp-ui council \(\/council\)\. Answer the request independently/);
      expect(json.tasks.map((t) => [t.name, t.agent, t.model])).toEqual([
        ["council-sol", COUNCIL_AGENT, "openai/gpt-6-sol"],
        ["council-opus", COUNCIL_AGENT, "anthropic/claude-opus-5.5"],
      ]);
      for (const task of json.tasks) {
        expect(typeof task.solutionSpace).toBe("string");
        expect(String(task.solutionSpace)).not.toBe("");
        expect(String(task.task)).toMatch(/\n\n## Request\nis the cache invalidation safe\?$/);
        expect(String(task.task)).toContain("POSITION:");
      }
      expect(String(json.tasks[0]!.task)).toContain("Think about cost.");
      const prompt = launchPrompt(h);
      expect(prompt).toContain("sol (openai/gpt-6-sol), opus (anthropic/claude-opus-5.5)");
      expect(prompt).toContain("Do not edit files or post anywhere because of this message.");
      expect(prompt).not.toContain("SCORE");
      expect(prompt).not.toMatch(/trial/i);
    });

    it("a trial member rides a second batch after the council batch, blind and uncounted", async () => {
      const h = harness();
      const cwd = tempDir("omp-ui-council-ask-");
      loadCouncil(h, {
        instructions: null,
        members: [
          { name: "sol", model: "openai/gpt-6-sol", instructions: "Think about cost.", enabled: true },
          { name: "opus", model: "anthropic/claude-opus-5.5", instructions: null, enabled: true },
        ],
        trial: { name: "nova", model: "litellm/nova", instructions: "Prefer boring designs.", enabled: true },
        configWarnings: [],
      });
      const note = await runCommand(h, "which queue fits?", cwd);
      expect(note.text.startsWith("Asked 2 council member(s) and trial member nova on (ask).")).toBe(true);
      const blocks = batchJsons(h);
      expect(blocks).toHaveLength(2);
      const council = blocks[0]!;
      expect(council.tasks.map((t) => [t.name, t.agent, t.model])).toEqual([
        ["council-sol", COUNCIL_AGENT, "openai/gpt-6-sol"],
        ["council-opus", COUNCIL_AGENT, "anthropic/claude-opus-5.5"],
      ]);
      expect(blocks[1]!.tasks).toHaveLength(1);
      const trialTask = blocks[1]!.tasks[0]!;
      expect([trialTask.name, trialTask.agent, trialTask.model]).toEqual(["council-nova", COUNCIL_AGENT, "litellm/nova"]);
      expect(blocks[1]!.context).toBe(council.context);
      expect(String(trialTask.task)).toContain("Prefer boring designs.");
      expect(String(trialTask.task)).toMatch(/\n\n## Request\nwhich queue fits\?$/);
      expect(String(trialTask.task)).not.toMatch(/trial/i);
      const prompt = launchPrompt(h);
      expect(prompt).toContain("It is not a council member");
      expect(prompt).toContain('"Trial model" section');
      expect(prompt).toContain("trial-only, not acted on");
      expect(prompt).toContain("Never wait for the trial member");
    });

    it("the tool asks with a trimmed request and the council's shared instructions as context", async () => {
      const h = harness();
      const cwd = tempDir("omp-ui-council-ask-");
      loadCouncil(h);
      const result = await runTool(h, { request: "  which queue fits?  " }, cwd);
      expect(result.isError).toBeUndefined();
      const json = batchJson(h);
      expect(json.context).toBe("omp-ui council (/council). find bugs");
      expect(String(json.tasks[0]!.task)).toMatch(/\n\n## Request\nwhich queue fits\?$/);
    });
  });

  describe("review", () => {
    it("launches council-agent items on the resolved diff, scored per member", async () => {
      const h = harness();
      const repo = makeRepo();
      loadCouncil(h);
      const result = await runReview(h, { kind: "commit", value: "HEAD" }, repo);
      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.text).toMatch(/^Asked 1 council member\(s\) on HEAD\. /);
      const json = batchJson(h);
      expect(json.context).toBe("omp-ui council review (/council review). find bugs");
      expect(json.tasks.map((t) => [t.name, t.agent, t.model])).toEqual([
        ["council-sec", COUNCIL_AGENT, "vllm/gemma-4-31b-it"],
      ]);
      expect(String(json.tasks[0]!.solutionSpace)).not.toBe("");
      const text = brief(h);
      expect(text).toContain("SCORE: <0-10>/10");
      expect(text).toContain(`## Diff target\nReview commit ${git(repo, "rev-parse", "HEAD")} (\`HEAD\`)`);
      expect(text).not.toContain("## Request");
      expect(launchPrompt(h)).toContain(`call ${COUNCIL_TOOL} with review: true for a fresh round`);
    });

    it("a review round adds the trial batch and keeps the members' stopping rule council-only", async () => {
      const h = harness();
      const repo = makeRepo();
      loadCouncil(h, {
        instructions: null,
        members: [{ name: "sec", model: "vllm/gemma-4-31b-it", instructions: null, enabled: true }],
        trial: { name: "nova", model: "litellm/nova", instructions: null, enabled: true },
        configWarnings: [],
      });
      const result = await runReview(h, { kind: "commit", value: "HEAD" }, repo);
      expect(result.isError).toBeUndefined();
      const blocks = batchJsons(h);
      expect(blocks).toHaveLength(2);
      expect(blocks[1]!.tasks).toHaveLength(1);
      const trialTask = blocks[1]!.tasks[0]!;
      expect([trialTask.name, trialTask.agent, trialTask.model]).toEqual(["council-nova", COUNCIL_AGENT, "litellm/nova"]);
      expect(blocks[1]!.context).toBe(blocks[0]!.context);
      expect(String(trialTask.task)).toContain("SCORE: <0-10>/10");
      expect(String(trialTask.task)).not.toMatch(/trial/i);
      const prompt = launchPrompt(h);
      expect(prompt).toContain("Stop when no council member reports a blocker or major finding");
      expect(prompt).toContain("in the last row, labelled (trial)");
    });

    it("a review request rides as extra focus after the diff target", async () => {
      const h = harness();
      const repo = makeRepo();
      loadCouncil(h);
      await runTool(h, { review: true, request: " auth paths ", target: { kind: "commit", value: "HEAD" } }, repo);
      expect(brief(h)).toMatch(/## Diff target\n[\s\S]*\n\n## Focus\nauth paths$/);
    });

    it("launches exactly the members a resolved council holds, and its warnings ride the status", async () => {
      const h = harness();
      const repo = makeRepo();
      const doc: CouncilDocument = {
        instructions: "Top line\nsecond",
        members: [
          { name: "a", model: "x/y:high", instructions: "Line one\nLine two", enabled: true },
          { name: "no-model", model: null, instructions: null, enabled: true },
          { name: "off", model: "x/off", instructions: null, enabled: false },
          { name: "c", model: "p/q", instructions: null, enabled: true },
          { name: "d", model: "r/s", instructions: null, enabled: true },
          { name: "e", model: "t/u", instructions: null, enabled: true },
        ],
      };
      loadCouncil(h, resolveCouncilRoster("project", { global: null, project: doc }));
      const note = await runCommand(h, "review HEAD", repo);
      expect(note.level).toBe("warning");
      expect(note.text).toMatch(/Config warnings: .*no model — skipped.*more than 3 members — skipped/);
      const json = batchJson(h);
      expect(json.tasks.map((t) => [t.name, t.model])).toEqual([
        ["council-a", "x/y:high"],
        ["council-c", "p/q"],
        ["council-d", "r/s"],
      ]);
      expect(String(json.tasks[0]!.task)).toContain("Line one\nLine two");
      expect(json.context).toContain("Top line\nsecond");
    });
  });

  it("an empty council refuses with the Council settings sentence and launches nothing", async () => {
    const h = harness();
    const cwd = tempDir("omp-ui-council-empty-");
    loadCouncil(h, { instructions: null, members: [], trial: null, configWarnings: ['member "x": no model — skipped'] });
    const note = await runCommand(h, "hello", cwd);
    expect(note).toEqual({
      text:
        "No council members were loaded for this session. Pick each member's model in Project settings → Council, " +
        'then restart the session. Config warnings: member "x": no model — skipped',
      level: "error",
    });
    expect(h.sends).toHaveLength(0);
  });

  describe("command arguments", () => {
    it("malformed arguments refuse with their usage line", async () => {
      const h = harness();
      const repo = makeRepo();
      loadCouncil(h);
      const table: Array<[string, string]> = [
        ["", COUNCIL_USAGE],
        ["   ", COUNCIL_USAGE],
        ["review pr", "usage: /council review pr <number>"],
        ["review pr 0", COUNCIL_PR_USAGE],
        ["review pr x", COUNCIL_PR_USAGE],
        ["review pr 5 6", COUNCIL_PR_USAGE],
        ["review a|b", COUNCIL_USAGE],
        ["review work...feature", COUNCIL_USAGE],
      ];
      for (const [args, usage] of table) {
        expect(await runCommand(h, args, repo)).toEqual({ text: usage, level: "error" });
      }
      expect(h.sends).toHaveLength(0);
    });

    it("review followed by more than one word is a request", async () => {
      const h = harness();
      const cwd = tempDir("omp-ui-council-ask-");
      loadCouncil(h);
      const note = await runCommand(h, "review the auth design", cwd);
      expect(note.text).toMatch(/^Asked 1 council member\(s\) on \(ask\)\./);
      expect(brief(h)).toMatch(/\n\n## Request\nreview the auth design$/);
    });

    it("bare review reviews local changes", async () => {
      const h = harness();
      const repo = makeRepo();
      loadCouncil(h);
      const note = await runCommand(h, "review", repo);
      expect(note.text).toMatch(/^Asked 1 council member\(s\) on local changes\./);
      expect(brief(h)).toContain(`the base is the empty tree ${emptyTree(repo)}`);
    });

    it("shell-shaped review targets never reach git", async () => {
      const h = harness();
      const repo = makeRepo();
      loadCouncil(h);
      for (const bad of ["`x`", "a|b", "a&&b", "-x", "..", "a..b..c"]) {
        const note = await runCommand(h, `review ${bad}`, repo);
        expect(note).toEqual({ text: COUNCIL_USAGE, level: "error" });
      }
      expect(h.sends).toHaveLength(0);
    });
  });

  it("the tool validates request, review, and target before launching anything", async () => {
    const h = harness();
    const repo = makeRepo();
    loadCouncil(h);
    const cases: Array<[Record<string, unknown>, string]> = [
      [{}, "request is required unless review is true"],
      [{ request: "   " }, "request is required unless review is true"],
      [{ review: false, request: null }, "request is required unless review is true"],
      [{ request: "x", target: { kind: "pr", value: "1" } }, "target applies only with review: true"],
      [{ review: null, request: "x", target: { kind: "local" } }, "target applies only with review: true"],
      [{ review: true, target: { kind: "branch", value: "x" } }, "target.kind must be local, commit, or pr"],
      [{ review: true, target: { kind: "local", value: "x" } }, "a local target carries no value"],
      [{ review: true, target: { kind: "pr" } }, "target.value is required for pr"],
      [{ review: true, target: { kind: "pr", value: "0" } }, "target.value must be a positive pull request number"],
      [{ review: true, target: { kind: "commit", value: "a b" } }, "target.value must be a ref, sha, or <from>..<to> range"],
    ];
    for (const [params, message] of cases) {
      expect(await runTool(h, params, repo)).toEqual({ content: [{ type: "text", text: message }], isError: true });
    }
    expect(h.sends).toHaveLength(0);
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

    it("hands members a three-dot diff that git runs", async () => {
      const h = harness();
      const { repo, work, feature } = featureRepo();
      loadCouncil(h);
      const result = await runReview(h, { kind: "commit", value: "work..feature" }, repo);
      expect(result.isError).toBeUndefined();
      const text = brief(h);
      expect(text).toContain(`git diff ${work}...${feature}`);
      const range = /`git diff ([0-9a-f]+\.\.\.[0-9a-f]+)`/.exec(text)![1]!;
      const names = childProcess.execFileSync("git", ["-C", repo, "diff", "--name-only", range], { encoding: "utf8" });
      expect(names.split("\n")).toEqual(expect.arrayContaining(["g1.txt", "g2.txt"]));
    });

    it("refuses empty and unknown ranges", async () => {
      const h = harness();
      const { repo } = featureRepo();
      loadCouncil(h);
      const backwards = await runReview(h, { kind: "commit", value: "feature..work" }, repo);
      expect(backwards.content[0]!.text).toMatch(/carries no commits/);
      const unknown = await runReview(h, { kind: "commit", value: "work..nope" }, repo);
      expect(unknown.content[0]!.text).toMatch(/Not a commit in this repository: nope/);
      const command = await runCommand(h, "review feature..work", repo);
      expect(command).toEqual({ text: "Nothing to review: feature..work carries no commits.", level: "error" });
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
      loadCouncil(h);
      const result = await runReview(h, undefined, repo);
      expect(result.content[0]!.text).toMatch(/^Asked 1 council member\(s\) on local changes\./);
      const text = brief(h);
      expect(text).toContain("the merge-base of HEAD and origin/work");
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
      loadCouncil(h);
      await runReview(h, undefined, repo);
      const text = brief(h);
      expect(text).toContain(`the base is HEAD's parent ${parent}`);
      expect(text).not.toContain(unrelated);
    });

    it("a root commit diffs against the empty tree, staged work included", async () => {
      const h = harness();
      const repo = makeRepo();
      fs.writeFileSync(path.join(repo, "s.txt"), "staged\n");
      git(repo, "add", "s.txt");
      loadCouncil(h);
      await runReview(h, undefined, repo);
      expect(brief(h)).toContain(`the base is the empty tree ${emptyTree(repo)}`);
    });

    it("a clean tree at the upstream tip has nothing to review; an untracked file does", async () => {
      const h = harness();
      const repo = makeRepo();
      addOrigin(repo);
      loadCouncil(h);
      const clean = await runReview(h, undefined, repo);
      expect(clean.isError).toBe(true);
      expect(clean.content[0]!.text).toMatch(/^Nothing to review: no changes against the merge-base with origin\/work/);
      expect(h.sends).toHaveLength(0);
      fs.writeFileSync(path.join(repo, "u.txt"), "untracked\n");
      const untracked = await runReview(h, undefined, repo);
      expect(untracked.isError).toBeUndefined();
      expect(h.sends).toHaveLength(1);
    });
  });

  it.skipIf(process.platform === "win32")("review pr asks gh once, read-only, and refuses on a gh failure", async () => {
    const h = harness();
    const repo = makeRepo();
    loadCouncil(h);
    const bin = tempDir("omp-ui-council-gh-");
    const gh = path.join(bin, "gh");
    const head = "a".repeat(40);
    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${previousPath ?? ""}`;
    try {
      fs.writeFileSync(gh, `#!/bin/sh\necho '{"headRefOid":"${head}","baseRefName":"main"}'\n`, { mode: 0o755 });
      const ok = await runCommand(h, "review pr 5", repo);
      expect(ok.level).toBe("info");
      expect(ok.text).toMatch(/^Asked 1 council member\(s\) on pull request #5\./);
      const text = brief(h);
      expect(text).toContain(`pull request #5 (head ${head} into main)`);
      expect(text).not.toContain("git fetch");
      fs.writeFileSync(gh, "#!/bin/sh\necho 'not logged in' >&2\nexit 1\n", { mode: 0o755 });
      const refused = await runReview(h, { kind: "pr", value: "5" }, repo);
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
    loadCouncil(h);
    const controller = new AbortController();
    controller.abort();
    const review = await runReview(h, undefined, repo, controller.signal);
    expect(review.isError).toBe(true);
    expect(review.content[0]!.text).toMatch(/cancelled/);
    const ask = await runTool(h, { request: "why?" }, repo, controller.signal);
    expect(ask.isError).toBe(true);
    expect(ask.content[0]!.text).toMatch(/cancelled/);
    expect(h.sends).toHaveLength(0);
  });

  it("without a council snapshot refuses with a restart hint", async () => {
    const h = harness();
    const cwd = tempDir("omp-ui-council-nosnap-");
    const result = await runTool(h, { request: "hello" }, cwd);
    expect(result).toEqual({
      content: [{ type: "text", text: "The council was not loaded for this session; restart the session to load it." }],
      isError: true,
    });
    expect(h.sends).toHaveLength(0);
  });

  it("a snapshot main never writes reads as not loaded", async () => {
    const h = harness();
    const cwd = tempDir("omp-ui-council-badsnap-");
    const member = { name: "sec", model: "m/x", instructions: null };
    const snapshot = (overrides: Record<string, unknown>): string =>
      JSON.stringify({ version: 2, instructions: null, members: [member], trial: null, configWarnings: [], ...overrides });
    const noTrialKey = (() => {
      const { trial: _trial, ...rest } = JSON.parse(snapshot({})) as Record<string, unknown>;
      return JSON.stringify(rest);
    })();
    const hostile = [
      snapshot({ version: 1 }),
      snapshot({ version: 3 }),
      noTrialKey,
      snapshot({ trial: { ...member, name: "Sec" } }),
      snapshot({ trial: { ...member, model: "" } }),
      snapshot({ trial: 5 }),
      snapshot({ members: [member, { ...member, name: "b" }, { ...member, name: "c" }, { ...member, name: "d" }] }),
      snapshot({ members: [{ ...member, name: "Sec" }] }),
      snapshot({ members: [{ ...member, name: "a".repeat(25) }] }),
      snapshot({ members: [{ ...member, model: "" }] }),
      snapshot({ members: [{ ...member, model: null }] }),
      snapshot({ members: [{ ...member, instructions: 5 }] }),
      snapshot({ instructions: 5 }),
      "not json",
    ];
    for (const content of hostile) {
      fs.writeFileSync(councilRosterSnapshotPath(h.dir), content);
      const note = await runCommand(h, "hello", cwd);
      expect(note).toEqual({ text: expect.stringMatching(/restart the session/), level: "error" });
    }
    expect(h.sends).toHaveLength(0);
  });

  it("a snapshot with trial: null loads and launches without a trial member", async () => {
    const h = harness();
    const cwd = tempDir("omp-ui-council-ask-");
    fs.writeFileSync(
      councilRosterSnapshotPath(h.dir),
      JSON.stringify({
        version: 2,
        instructions: null,
        members: [{ name: "sec", model: "m/x", instructions: null }],
        trial: null,
        configWarnings: [],
      }),
    );
    const note = await runCommand(h, "hello", cwd);
    expect(note.level).toBe("info");
    expect(launchPrompt(h)).not.toMatch(/trial/i);
  });

  it("review refuses outside a git checkout", async () => {
    const h = harness();
    const dir = tempDir("omp-ui-council-nogit-");
    loadCouncil(h);
    const result = await runReview(h, undefined, dir);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/git checkout/);
    expect(h.sends).toHaveLength(0);
  });

  it("a failed send surfaces as an error, never a fake launch", async () => {
    const h = harness({ sendThrows: true });
    const repo = makeRepo();
    loadCouncil(h);
    const result = await runReview(h, undefined, repo);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/send failed/);
  });

  it("without pi.sendMessage the launch reports the incapability, never a fake launch", async () => {
    const h = harness({ withoutSend: true });
    const repo = makeRepo();
    loadCouncil(h);
    const result = await runTool(h, { request: "hello" }, repo);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/cannot start/);
  });
});
