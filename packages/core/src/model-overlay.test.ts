import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { modelOverlayPath, writeDefaultModelOverlay } from "./model-overlay";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-model-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeDefaultModelOverlay", () => {
  it("pins modelRoles.default as strict-loadable YAML", () => {
    const dir = tmpDir();
    const file = writeDefaultModelOverlay(dir, {
      model: "openrouter/anthropic/claude-opus-5",
      level: "high",
    });
    expect(file).toBe(modelOverlayPath(dir));
    expect(fs.readFileSync(file!, "utf8")).toBe(
      'modelRoles:\n  default: "openrouter/anthropic/claude-opus-5:high"\n',
    );
  });

  it("writes a bare model id without a level suffix", () => {
    const dir = tmpDir();
    const file = writeDefaultModelOverlay(dir, { model: "openrouter/openai/gpt-5.6" })!;
    expect(fs.readFileSync(file, "utf8")).toBe('modelRoles:\n  default: "openrouter/openai/gpt-5.6"\n');
  });

  it("returns null (no overlay) for a null role, leaving omp's config to decide", () => {
    const dir = tmpDir();
    expect(writeDefaultModelOverlay(dir, null)).toBeNull();
    expect(fs.existsSync(modelOverlayPath(dir))).toBe(false);
  });

  it("removes a stale overlay when the remembered model is cleared", () => {
    const dir = tmpDir();
    const file = writeDefaultModelOverlay(dir, { model: "a/b" })!;
    expect(writeDefaultModelOverlay(dir, null)).toBeNull();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("creates the lineage dir so --config cannot fail on a missing file", () => {
    const dir = path.join(tmpDir(), "not-yet");
    const file = writeDefaultModelOverlay(dir, { model: "a/b" })!;
    expect(fs.existsSync(file)).toBe(true);
  });

  it("quotes a selector with metacharacters", () => {
    const dir = tmpDir();
    const file = writeDefaultModelOverlay(dir, { model: 'a/b"c' })!;
    expect(fs.readFileSync(file, "utf8")).toBe('modelRoles:\n  default: "a/b\\"c"\n');
  });
});
