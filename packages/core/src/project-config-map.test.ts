import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  readProjectConfigMap,
  setProjectConfigMapEntry,
} from "./project-config-writer";

/**
 * The map half of the project-layer editor (ADR-0031): `task.agentModelOverrides`
 * is a third-level string map edited ONE ENTRY at a time, so an unrelated
 * hand-written key survives, and any shape the grammar cannot see reports
 * `unsupported` with file and line rather than being reformatted.
 */

const dirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-pcm-"));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, ".omp"));
  return dir;
}

function writeConfig(cwd: string, text: string): string {
  const file = path.join(cwd, ".omp", "config.yml");
  fs.writeFileSync(file, text);
  return file;
}

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

const KEY = ["task", "agentModelOverrides"] as const;

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("readProjectConfigMap", () => {
  it("reads entries, unquoting keys and values", () => {
    const cwd = tmpProject();
    writeConfig(
      cwd,
      'task:\n  agentModelOverrides:\n    "scout": "*"\n    task: "openai/gpt-5:high" # keep me\n',
    );
    expect(readProjectConfigMap(cwd, KEY)).toEqual({
      shape: "map",
      value: { scout: "*", task: "openai/gpt-5:high" },
    });
  });

  it("reports absent for a missing file, parent, child, or empty child", () => {
    const cwd = tmpProject();
    expect(readProjectConfigMap(cwd, KEY)).toEqual({ shape: "absent" });
    writeConfig(cwd, "advisor:\n  enabled: true\n");
    expect(readProjectConfigMap(cwd, KEY)).toEqual({ shape: "absent" });
    writeConfig(cwd, "task:\n  agentModelOverrides:\n");
    expect(readProjectConfigMap(cwd, KEY)).toEqual({ shape: "absent" });
  });

  it("reads a scalar or sequence where a map was expected back as a value", () => {
    const cwd = tmpProject();
    writeConfig(cwd, "task:\n  agentModelOverrides: nope\n");
    expect(readProjectConfigMap(cwd, KEY)).toEqual({ shape: "value", value: "nope" });
    writeConfig(cwd, "task:\n  agentModelOverrides:\n    - one\n    - two\n");
    expect(readProjectConfigMap(cwd, KEY)).toEqual({ shape: "value", value: ["one", "two"] });
  });

  it("reports unsupported with a line for flow mappings, anchors, and duplicates", () => {
    const cwd = tmpProject();
    writeConfig(cwd, "task:\n  agentModelOverrides: { scout: '*' }\n");
    const flow = readProjectConfigMap(cwd, KEY);
    expect(flow.shape).toBe("unsupported");
    expect(flow.shape === "unsupported" && flow.line).toBe(2);

    writeConfig(cwd, "task:\n  agentModelOverrides:\n    scout: &pin '*'\n");
    const anchor = readProjectConfigMap(cwd, KEY);
    expect(anchor.shape).toBe("unsupported");
    // A thrown refusal reports line 0 and embeds the line in the reason.
    expect(anchor.shape === "unsupported" && anchor.reason).toContain(":3:");

    writeConfig(cwd, "task:\n  agentModelOverrides:\n    scout: a/b\n    scout: c/d\n");
    const dup = readProjectConfigMap(cwd, KEY);
    expect(dup.shape).toBe("unsupported");
    expect(dup.shape === "unsupported" && dup.reason).toContain(":4:");
  });
});

describe("setProjectConfigMapEntry", () => {
  it("creates the file mode 0o600 with omp's own shape", async () => {
    const cwd = tmpProject();
    await setProjectConfigMapEntry(cwd, KEY, "scout", "*");
    const file = path.join(cwd, ".omp", "config.yml");
    expect(read(file)).toBe('task:\n  agentModelOverrides:\n    scout: "*"\n');
    // Windows does not emulate chmod for writable files; stat reports the
    // NTFS-derived 0o666 there (same platform expectation as
    // project-config-writer.test.ts, issue #566).
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("changes only the one entry's line, byte-level, beside comments and siblings", async () => {
    const cwd = tmpProject();
    const file = writeConfig(
      cwd,
      [
        "# hand-written comment",
        "task:",
        "  agentModelOverrides:",
        '    "scout": "*"',
        '    "task": "openai/gpt-5"',
        "advisor:",
        "  subagents:",
        "    - reviewer",
        "",
      ].join("\n"),
    );
    await setProjectConfigMapEntry(cwd, KEY, "scout", "anthropic/claude-sonnet-4.5");
    expect(read(file)).toBe(
      [
        "# hand-written comment",
        "task:",
        "  agentModelOverrides:",
        '    scout: "anthropic/claude-sonnet-4.5"',
        '    "task": "openai/gpt-5"',
        "advisor:",
        "  subagents:",
        "    - reviewer",
        "",
      ].join("\n"),
    );
  });

  it("appends a new entry after the last one, at the entries' indent", async () => {
    const cwd = tmpProject();
    const file = writeConfig(cwd, 'task:\n  agentModelOverrides:\n    "scout": "*"\n');
    await setProjectConfigMapEntry(cwd, KEY, "task", "@task");
    expect(read(file)).toBe(
      'task:\n  agentModelOverrides:\n    "scout": "*"\n    task: "@task"\n',
    );
  });

  it("deletes one entry, and the emptied child with it", async () => {
    const cwd = tmpProject();
    const file = writeConfig(
      cwd,
      'task:\n  agentModelOverrides:\n    "scout": "*"\n    "task": "@task"\nadvisor:\n  enabled: true\n',
    );
    await setProjectConfigMapEntry(cwd, KEY, "scout", null);
    expect(read(file)).toBe(
      'task:\n  agentModelOverrides:\n    "task": "@task"\nadvisor:\n  enabled: true\n',
    );
    await setProjectConfigMapEntry(cwd, KEY, "task", null);
    expect(read(file)).toBe("task:\nadvisor:\n  enabled: true\n");
  });

  it("refuses flow, scalar, and sequence shapes, naming the file and line", async () => {
    const cwd = tmpProject();
    const file = writeConfig(cwd, "task:\n  agentModelOverrides: { scout: '*' }\n");
    await expect(setProjectConfigMapEntry(cwd, KEY, "task", "*")).rejects.toThrow(
      `${file}:2: agentModelOverrides is a flow mapping`,
    );
    writeConfig(cwd, "task:\n  agentModelOverrides: nope\n");
    await expect(setProjectConfigMapEntry(cwd, KEY, "task", "*")).rejects.toThrow(
      "holds a scalar",
    );
    writeConfig(cwd, "task:\n  agentModelOverrides:\n    - one\n");
    await expect(setProjectConfigMapEntry(cwd, KEY, "task", "*")).rejects.toThrow(
      "holds a list",
    );
  });

  it("refuses a duplicate entry rather than guessing which to edit", async () => {
    const cwd = tmpProject();
    writeConfig(cwd, "task:\n  agentModelOverrides:\n    scout: a/b\n    scout: c/d\n");
    await expect(setProjectConfigMapEntry(cwd, KEY, "scout", "*")).rejects.toThrow(
      'duplicate "scout" entry',
    );
  });

  it("round-trips: writes read back through readProjectConfigMap", async () => {
    const cwd = tmpProject();
    await setProjectConfigMapEntry(cwd, KEY, "scout", "*");
    await setProjectConfigMapEntry(cwd, KEY, "task", "openrouter/openai/gpt-5.6-luna:medium");
    expect(readProjectConfigMap(cwd, KEY)).toEqual({
      shape: "map",
      value: { scout: "*", task: "openrouter/openai/gpt-5.6-luna:medium" },
    });
  });
});
