import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as module from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { CODE_REVIEW_COMMAND, CODE_REVIEW_TOOL } from "./review";
import { reviewExtensionPath, writeReviewExtension } from "./review-extension";
import { typecheckGeneratedExtension } from "./generated-extension-test-utils";

const nodeRequire = module.createRequire(import.meta.url);
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface ToolDefinition {
  name: string;
  description: string;
  execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: Record<string, unknown> | undefined,
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
}

interface Harness {
  commands: Map<string, (args: string, ctx: Record<string, unknown>) => Promise<void>>;
  tool: ToolDefinition | null;
  sends: Array<{ message: Record<string, unknown>; options: Record<string, unknown> }>;
}

function harness(options: { sendThrows?: boolean; withoutSend?: boolean } = {}): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-review-ext-"));
  dirs.push(dir);
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
  return {
    commands,
    get tool() {
      return tool;
    },
    sends,
  };
}

/** A git checkout whose user-scoped agent dir carries a two-entry roster. */
function makeRepo(roster?: string): { repo: string; envRestore: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-review-repo-"));
  dirs.push(base);
  const repo = path.join(base, "repo");
  fs.mkdirSync(repo, { recursive: true });
  childProcess.execFileSync("git", ["init", "-q", repo]);
  fs.writeFileSync(path.join(repo, "f.txt"), "hello\n");
  childProcess.execFileSync("git", ["-C", repo, "add", "f.txt"]);
  childProcess.execFileSync("git", [
    "-c",
    "user.email=t@t",
    "-c",
    "user.name=t",
    "-C",
    repo,
    "commit",
    "-q",
    "-m",
    "add f",
  ]);
  const agentDir = path.join(base, "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(
    path.join(agentDir, "REVIEW.yml"),
    roster ??
      "instructions: find bugs\nreviewers:\n  - name: sec\n    model: vllm/gemma-4-31b-it\n  - name: nit\n    enabled: false\n",
  );
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  return {
    repo,
    envRestore: () => {
      if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = previous;
    },
  };
}

/** The fenced batch JSON the launch prompt carries, backreference-matched. */
function batchJson(content: string): { context: string; tasks: Array<Record<string, unknown>> } {
  const match = /(`{3,})json\n([\s\S]*?)\n\1/.exec(content);
  if (match === null) throw new Error("no fenced batch JSON in:\n" + content);
  return JSON.parse(match[2]!) as { context: string; tasks: Array<Record<string, unknown>> };
}

describe("generated code-review extension", () => {
  it("registers the command and the namespaced tool", () => {
    const h = harness();
    expect(h.commands.has(CODE_REVIEW_COMMAND)).toBe(true);
    expect(h.tool?.name).toBe(CODE_REVIEW_TOOL);
  });

  it("the command launches a batch through pi.sendMessage", async () => {
    const h = harness();
    const repo = makeRepo();
    try {
      await h.commands.get(CODE_REVIEW_COMMAND)?.("", { cwd: repo.repo, ui: { notify: () => {} } });
      expect(h.sends).toHaveLength(1);
      const send = h.sends[0]!;
      expect(send.options.deliverAs).toBe("nextTurn");
      expect(send.options.triggerTurn).toBe(true);
      expect(send.message.customType).toBe("omp-ui-code-review-launch");
      expect(send.message.display).toBe(false);
      const json = batchJson(String(send.message.content));
      expect(json.context).toContain("find bugs");
      expect(json.tasks).toHaveLength(1); // nit is disabled
      expect(json.tasks[0]!.name).toBe("review-sec");
      expect(json.tasks[0]!.model).toBe("vllm/gemma-4-31b-it");
      expect(String(json.tasks[0]!.task)).toContain("independent code reviewers");
      expect(String(json.tasks[0]!.task)).toContain("## Diff target");
    } finally {
      repo.envRestore();
    }
  });

  it("the tool runs the same path and validates the target", async () => {
    const h = harness();
    const repo = makeRepo();
    try {
      const tool = h.tool;
      if (!tool) throw new Error("no tool");
      const bad = await tool.execute("id1", { target: { kind: "nope" } }, undefined, undefined, { cwd: repo.repo });
      expect(bad.isError).toBe(true);
      const noValue = await tool.execute("id2", { target: { kind: "pr" } }, undefined, undefined, { cwd: repo.repo });
      expect(noValue.isError).toBe(true);
      const ok = await tool.execute(
        "id3",
        { target: { kind: "commit", value: "HEAD" } },
        undefined,
        undefined,
        { cwd: repo.repo },
      );
      expect(ok.isError).toBeUndefined();
      expect(h.sends).toHaveLength(1);
      expect(String(h.sends[0]!.message.content)).toContain("Review commit HEAD");
    } finally {
      repo.envRestore();
    }
  });

  it("refuses outside a git checkout, with a usage line, and with an empty roster", async () => {
    const h = harness();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-review-nogit-"));
    dirs.push(dir);
    const tool = h.tool;
    if (!tool) throw new Error("no tool");
    const outside = await tool.execute("id", undefined, undefined, undefined, { cwd: dir });
    expect(outside.isError).toBe(true);
    expect(outside.content[0]!.text).toMatch(/git checkout/);
    const repo = makeRepo("reviewers:\n  - name: only\n    enabled: false\n");
    try {
      const empty = await tool.execute("id", undefined, undefined, undefined, { cwd: repo.repo });
      expect(empty.isError).toBe(true);
      expect(empty.content[0]!.text).toMatch(/roster is empty/);
    } finally {
      repo.envRestore();
    }
  });

  it("a failed send surfaces as an error, never a fake launch", async () => {
    const h = harness({ sendThrows: true });
    const repo = makeRepo();
    try {
      const tool = h.tool;
      if (!tool) throw new Error("no tool");
      const result = await tool.execute("id", undefined, undefined, undefined, { cwd: repo.repo });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/send failed/);
    } finally {
      repo.envRestore();
    }
  });

  it("without pi.sendMessage the launch reports the incapability, never a fake launch", async () => {
    const h = harness({ withoutSend: true });
    const repo = makeRepo();
    try {
      const tool = h.tool;
      if (!tool) throw new Error("no tool");
      const result = await tool.execute("id", undefined, undefined, undefined, { cwd: repo.repo });
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toMatch(/cannot start/);
    } finally {
      repo.envRestore();
    }
  });

  it("unparseable roster rows warn but never block the launch", async () => {
    const h = harness();
    const repo = makeRepo(
      'instructions: "look at security"\nreviewers:\n  - name: ok\n  - name: "!!"\n    model: x\n',
    );
    try {
      const tool = h.tool;
      if (!tool) throw new Error("no tool");
      const result = await tool.execute("id", undefined, undefined, undefined, { cwd: repo.repo });
      expect(result.isError).toBeUndefined();
      expect(result.content[0]!.text).toMatch(/Config warnings/);
      const json = batchJson(String(h.sends[0]!.message.content));
      expect(json.tasks.map((t) => t.name)).toEqual(["review-ok"]);
    } finally {
      repo.envRestore();
    }
  });
});
