import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  projectConfigFile,
  readProjectConfigValue,
  setProjectConfigValue,
} from "./project-config-writer";

/**
 * The project-layer editor (issue #383). The contract has two halves: bytes
 * outside the touched lines survive verbatim — the opposite of omp's own
 * writer, which regenerates and drops comments (verified against 18.1.10) —
 * and any shape the two-level grammar cannot see refuses naming file and line
 * instead of guessing.
 */

const dirs: string[] = [];

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-pcw-"));
  dirs.push(dir);
  const ompDir = path.join(dir, ".omp");
  fs.mkdirSync(ompDir);
  return dir;
}

function writeConfig(cwd: string, text: string, name = "config.yml"): string {
  const file = path.join(cwd, ".omp", name);
  fs.writeFileSync(file, text);
  return file;
}

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("setProjectConfigValue — in-place edits", () => {
  it("replaces a boolean line keeping every other byte, comments included", async () => {
    const cwd = tmpProject();
    const file = writeConfig(
      cwd,
      [
        "# hand-written comment",
        "bash:",
        "  enabled: true",
        "advisor:",
        "  enabled: false # inline note",
        "unrelated: keep-me",
        "",
      ].join("\n"),
    );
    await setProjectConfigValue(cwd, ["bash", "enabled"], false);
    expect(read(file)).toBe(
      [
        "# hand-written comment",
        "bash:",
        "  enabled: false",
        "advisor:",
        "  enabled: false # inline note",
        "unrelated: keep-me",
        "",
      ].join("\n"),
    );
  });

  it("appends a child to an existing parent block at the block's indent", async () => {
    const cwd = tmpProject();
    const file = writeConfig(cwd, "skills:\n  ignoredSkills:\n    - one\nadvisor:\n  enabled: true\n");
    await setProjectConfigValue(cwd, ["skills", "enablePiUser"], true);
    expect(read(file)).toBe(
      "skills:\n  ignoredSkills:\n    - one\n  enablePiUser: true\nadvisor:\n  enabled: true\n",
    );
  });

  it("appends a new parent block formatted like omp config set's output", async () => {
    const cwd = tmpProject();
    const file = writeConfig(cwd, "advisor:\n  enabled: true");
    await setProjectConfigValue(cwd, ["bash", "enabled"], false);
    expect(read(file)).toBe("advisor:\n  enabled: true\nbash:\n  enabled: false\n");
  });

  it("creates the file at mode 0o600 when no config exists", async () => {
    const cwd = tmpProject();
    await setProjectConfigValue(cwd, ["todo", "enabled"], true);
    const file = path.join(cwd, ".omp", "config.yml");
    expect(read(file)).toBe("todo:\n  enabled: true\n");
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });

  it("writes a string list as block-sequence items in omp's grammar", async () => {
    const cwd = tmpProject();
    const file = writeConfig(cwd, "skills:\n  ignoredSkills:\n    - old\n");
    await setProjectConfigValue(cwd, ["skills", "ignoredSkills"], ["a b", 'he said "hi"', ":x"]);
    expect(read(file)).toBe(
      'skills:\n  ignoredSkills:\n    - a b\n    - "he said \\"hi\\""\n    - ":x"\n',
    );
  });

  it("converts a flow sequence to the block form it replaces", async () => {
    const cwd = tmpProject();
    const file = writeConfig(cwd, "skills:\n  ignoredSkills: [gone]\n");
    await setProjectConfigValue(cwd, ["skills", "ignoredSkills"], ["fresh"]);
    expect(read(file)).toBe("skills:\n  ignoredSkills:\n    - fresh\n");
  });

  it("preserves CRLF line endings", async () => {
    const cwd = tmpProject();
    const file = writeConfig(cwd, "bash:\r\n  enabled: true\r\n");
    await setProjectConfigValue(cwd, ["bash", "enabled"], false);
    expect(read(file)).toBe("bash:\r\n  enabled: false\r\n");
  });

  it("falls back to config.yaml only when config.yml is absent", async () => {
    const cwd = tmpProject();
    const yaml = writeConfig(cwd, "bash:\n  enabled: true\n", "config.yaml");
    await setProjectConfigValue(cwd, ["bash", "enabled"], false);
    expect(read(yaml)).toBe("bash:\n  enabled: false\n");
    expect(fs.existsSync(path.join(cwd, ".omp", "config.yml"))).toBe(false);
    expect(projectConfigFile(cwd)).toBe(yaml);
  });
});

describe("setProjectConfigValue — refusals name file and line", () => {
  it("refuses a duplicate parent block", async () => {
    const cwd = tmpProject();
    const file = writeConfig(cwd, "skills:\n  enabled: true\nskills:\n  ignoredSkills: []\n");
    await expect(setProjectConfigValue(cwd, ["skills", "enabled"], false)).rejects.toThrow(
      new RegExp(`config\\.yml:3: duplicate "skills:" block`),
    );
    void file;
  });

  it("refuses a scalar where a mapping must go", async () => {
    const cwd = tmpProject();
    writeConfig(cwd, "bash: loud\n");
    await expect(setProjectConfigValue(cwd, ["bash", "enabled"], true)).rejects.toThrow(
      /config\.yml:1: "bash" holds a scalar/,
    );
  });

  it("refuses a flow mapping", async () => {
    const cwd = tmpProject();
    writeConfig(cwd, "skills: {enabled: true}\n");
    await expect(setProjectConfigValue(cwd, ["skills", "enabled"], false)).rejects.toThrow(
      /flow mapping/,
    );
  });

  it("refuses an anchored value on the target line", async () => {
    const cwd = tmpProject();
    writeConfig(cwd, "base: &on true\nbash:\n  enabled: *on\n");
    await expect(setProjectConfigValue(cwd, ["bash", "enabled"], false)).rejects.toThrow(
      /anchor, alias, or tag/,
    );
  });

  it("refuses a multi-document file", async () => {
    const cwd = tmpProject();
    writeConfig(cwd, "---\nbash:\n  enabled: true\n");
    await expect(setProjectConfigValue(cwd, ["bash", "enabled"], false)).rejects.toThrow(
      /multi-document/,
    );
  });

  it("refuses replacing a list with a scalar and vice versa", async () => {
    const cwd = tmpProject();
    writeConfig(cwd, "skills:\n  ignoredSkills:\n    - one\nbash:\n  enabled: true\n");
    await expect(setProjectConfigValue(cwd, ["skills", "ignoredSkills"], "one")).rejects.toThrow(
      /holds a list/,
    );
    await expect(setProjectConfigValue(cwd, ["bash", "enabled"], ["a"])).rejects.toThrow(
      /holds a scalar/,
    );
  });

  it("leaves the file byte-identical when it refuses", async () => {
    const cwd = tmpProject();
    const file = writeConfig(cwd, "bash: loud\n");
    const before = read(file);
    await expect(setProjectConfigValue(cwd, ["bash", "enabled"], true)).rejects.toThrow();
    expect(read(file)).toBe(before);
  });
});

describe("readProjectConfigValue", () => {
  it("reads the project layer's own values", () => {
    const cwd = tmpProject();
    writeConfig(
      cwd,
      "skills:\n  ignoredSkills:\n    - web-design\n    - \"quoted one\"\n  enablePiUser: false\nbash:\n  enabled: true\n",
    );
    expect(readProjectConfigValue(cwd, ["skills", "ignoredSkills"])).toEqual({
      shape: "value",
      value: ["web-design", "quoted one"],
    });
    expect(readProjectConfigValue(cwd, ["skills", "enablePiUser"])).toEqual({
      shape: "value",
      value: false,
    });
    expect(readProjectConfigValue(cwd, ["bash", "enabled"])).toEqual({
      shape: "value",
      value: true,
    });
    expect(readProjectConfigValue(cwd, ["todo", "enabled"])).toEqual({ shape: "absent" });
  });

  it("reports a nested mapping as unsupported rather than guessing", () => {
    const cwd = tmpProject();
    writeConfig(cwd, "skills:\n  ignoredSkills:\n    nested:\n      deep: true\n");
    const read0 = readProjectConfigValue(cwd, ["skills", "ignoredSkills"]);
    expect(read0.shape).toBe("unsupported");
  });
});
