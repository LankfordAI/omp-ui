import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  generateTitleWithOmp,
  parseTitleOutput,
  sanitizeModelTitle,
  type TitleProcess,
  type TitleSpawnFn,
} from "./title-model";

/** A fake omp run: emits `stdout`, then exits with `code`. */
function fakeOmp(
  stdout: string,
  code: number | null = 0,
  opts: { spawnError?: Error; hang?: boolean } = {},
): { spawn: TitleSpawnFn; argv: string[][]; killed: () => number } {
  const argv: string[][] = [];
  let kills = 0;
  const spawn: TitleSpawnFn = (_omp, args) => {
    argv.push(args);
    const out = new PassThrough();
    const err = new PassThrough();
    const exits = new EventEmitter();
    const proc: TitleProcess = {
      stdout: out,
      stderr: err,
      kill: () => {
        kills++;
      },
      onExit: (cb) => void exits.on("exit", cb),
      onSpawnError: (cb) => void exits.on("error", cb),
    };
    // Deferred so the caller finishes wiring its listeners first.
    setImmediate(() => {
      if (opts.spawnError) return exits.emit("error", opts.spawnError);
      if (opts.hang) return;
      out.write(stdout);
      exits.emit("exit", code);
    });
    return proc;
  };
  return { spawn, argv, killed: () => kills };
}

function run(stdout: string, code: number | null = 0): Promise<string | null> {
  return generateTitleWithOmp({
    ompPath: "/bin/omp",
    projectCwd: "/p",
    model: "a/tiny",
    prompt: "fix the parser",
    spawnProcess: fakeOmp(stdout, code).spawn,
  });
}

describe("sanitizeModelTitle", () => {
  it("collapses whitespace and strips control characters", () => {
    expect(sanitizeModelTitle("  Fix\tthe\n parser  ")).toBe("Fix the parser");
    // A model-authored title must never be able to inject terminal escapes.
    expect(sanitizeModelTitle("Fix\u001b[31m the parser")).toBe("Fix [31m the parser");
  });

  it("treats a blank answer as no title", () => {
    expect(sanitizeModelTitle("   ")).toBeNull();
  });

  it("truncates an overlong title on a word boundary", () => {
    const title = sanitizeModelTitle(`${"word ".repeat(40)}end`)!;
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith("word")).toBe(true);
  });
});

describe("parseTitleOutput", () => {
  it("extracts the marked title", () => {
    expect(parseTitleOutput("<title>Fix login button on mobile</title>")).toBe(
      "Fix login button on mobile",
    );
  });

  it("treats the empty marker as no title", () => {
    // The prompt's own answer for a greeting — must not become a literal title.
    expect(parseTitleOutput("<title/>")).toBeNull();
    expect(parseTitleOutput("<title />")).toBeNull();
  });

  it("accepts a short unmarked answer", () => {
    expect(parseTitleOutput("Fix the parser\n")).toBe("Fix the parser");
  });

  it("rejects a long unmarked answer rather than titling from prose", () => {
    expect(parseTitleOutput("x".repeat(201))).toBeNull();
  });

  it("returns null on empty output", () => {
    expect(parseTitleOutput("   ")).toBeNull();
  });
});

describe("generateTitleWithOmp", () => {
  it("returns the model's title on a clean run", async () => {
    await expect(run("<title>Add pagination to sessions list</title>\n")).resolves.toBe(
      "Add pagination to sessions list",
    );
  });

  it("returns null when omp exits non-zero", async () => {
    // e.g. the configured model is not reachable — the caller keeps its fallback.
    await expect(run("<title>ignored</title>", 1)).resolves.toBeNull();
  });

  it("returns null when the process cannot be spawned", async () => {
    const { spawn } = fakeOmp("", 0, { spawnError: new Error("ENOENT") });
    await expect(
      generateTitleWithOmp({
        ompPath: "/bin/omp",
        projectCwd: "/p",
        model: null,
        prompt: "fix the parser",
        spawnProcess: spawn,
      }),
    ).resolves.toBeNull();
  });

  it("kills the run and yields null on timeout", async () => {
    const fake = fakeOmp("", 0, { hang: true });
    await expect(
      generateTitleWithOmp({
        ompPath: "/bin/omp",
        projectCwd: "/p",
        model: null,
        prompt: "fix the parser",
        spawnProcess: fake.spawn,
        timeoutMs: 10,
      }),
    ).resolves.toBeNull();
    // A leaked omp process per title would be worse than a missing title.
    expect(fake.killed()).toBe(1);
  });

  it("runs stateless, tool-less, and in the project cwd", async () => {
    const fake = fakeOmp("<title>T</title>");
    await generateTitleWithOmp({
      ompPath: "/bin/omp",
      projectCwd: "/proj",
      model: "a/tiny:medium",
      prompt: "fix the parser",
      spawnProcess: fake.spawn,
    });
    const args = fake.argv[0]!;
    // --no-session keeps title runs out of the sessions root entirely, so one
    // can never be mistaken for an owned session.
    for (const flag of ["-p", "--no-session", "--no-tools", "--no-lsp", "--no-extensions"]) {
      expect(args).toContain(flag);
    }
    expect(args[args.indexOf("--cwd") + 1]).toBe("/proj");
    expect(args[args.indexOf("--model") + 1]).toBe("a/tiny:medium");
  });

  it("omits --model so omp resolves its own chain when no role is configured", async () => {
    const fake = fakeOmp("<title>T</title>");
    await generateTitleWithOmp({
      ompPath: "/bin/omp",
      projectCwd: "/p",
      model: null,
      prompt: "fix the parser",
      spawnProcess: fake.spawn,
    });
    expect(fake.argv[0]).not.toContain("--model");
  });

  it("passes the prompt as argv data after `--`", async () => {
    // A prompt starting with `-` or `@` must never be read as a flag or a file
    // reference by omp's own argument parser.
    const fake = fakeOmp("<title>T</title>");
    await generateTitleWithOmp({
      ompPath: "/bin/omp",
      projectCwd: "/p",
      model: null,
      prompt: "@package.json --help is broken",
      spawnProcess: fake.spawn,
    });
    const args = fake.argv[0]!;
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("<user>@package.json --help is broken</user>");
  });
});
