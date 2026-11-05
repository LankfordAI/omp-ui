import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { councilOverlayPath, writeCouncilOverlay } from "./council-overlay";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-council-overlay-test-"));
  dirs.push(dir);
  return dir;
}

const BASE = 'async:\n  enabled: true\ntask:\n  batch: true\n  perCallModel: "on"\n';

describe("writeCouncilOverlay", () => {
  it("turns per-call models on without granting any role when the council is empty", () => {
    const dir = tempDir();
    const file = writeCouncilOverlay(dir, []);
    expect(file).toBe(councilOverlayPath(dir));
    expect(fs.readFileSync(file, "utf8")).toBe(BASE);
  });

  it("grants one numbered role per member, in launch order", () => {
    const dir = tempDir();
    const file = writeCouncilOverlay(dir, ["openai/gpt-6-sol", "anthropic/claude-opus-5.5:high"]);
    expect(fs.readFileSync(file, "utf8")).toBe(
      BASE +
        "modelRoles:\n" +
        '  "omp-ui-council-1": "openai/gpt-6-sol"\n' +
        '  "omp-ui-council-2": "anthropic/claude-opus-5.5:high"\n',
    );
  });

  it("rewrites a stale overlay from an earlier spawn of the same lineage", () => {
    const dir = tempDir();
    writeCouncilOverlay(dir, ["openai/gpt-6-sol"]);
    const file = writeCouncilOverlay(dir, []);
    expect(fs.readFileSync(file, "utf8")).toBe(BASE);
  });

  it("throws on a selector that could break the strict config loader", () => {
    const dir = tempDir();
    expect(() => writeCouncilOverlay(dir, ["openai/gpt-6-sol", "openai/gpt\n  evil: true"])).toThrow(Error);
    expect(() => writeCouncilOverlay(dir, ["openai/gpt 6"])).toThrow(Error);
    expect(fs.existsSync(councilOverlayPath(dir))).toBe(false);
  });
});
