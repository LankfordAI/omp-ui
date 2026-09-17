import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  subagentModelOverlayPath,
  writeSubagentModelOverlay,
} from "./subagent-model-overlay";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-subagents-test-"));
  dirs.push(dir);
  return dir;
}

describe("writeSubagentModelOverlay", () => {
  it("writes the task.agentModelOverrides map, keys and values quoted, sorted", () => {
    const dir = tmp();
    const file = writeSubagentModelOverlay(dir, {
      task: "openrouter/openai/gpt-5.6-luna:medium",
      scout: "*",
    });
    expect(file).toBe(subagentModelOverlayPath(dir));
    expect(fs.readFileSync(file!, "utf8")).toBe(
      'task:\n  agentModelOverrides:\n    "scout": "*"\n    "task": "openrouter/openai/gpt-5.6-luna:medium"\n',
    );
  });

  it("removes an old overlay when the entries empty out", () => {
    const dir = tmp();
    writeSubagentModelOverlay(dir, { scout: "*" });
    expect(writeSubagentModelOverlay(dir, {})).toBeNull();
    expect(fs.existsSync(subagentModelOverlayPath(dir))).toBe(false);
  });

  it("removes the artifact and returns null for a rejected name or selector", () => {
    const dir = tmp();
    writeSubagentModelOverlay(dir, { scout: "*" });
    expect(writeSubagentModelOverlay(dir, { "bad name": "*" })).toBeNull();
    expect(fs.existsSync(subagentModelOverlayPath(dir))).toBe(false);
    expect(writeSubagentModelOverlay(dir, { scout: "not a selector" })).toBeNull();
    expect(fs.existsSync(subagentModelOverlayPath(dir))).toBe(false);
  });
});
