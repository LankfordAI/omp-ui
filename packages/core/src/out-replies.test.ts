import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isReplyWrite, supportsOutReplies, toolResultReplies } from "./out-replies";
import { outRepliesOverlayPath, writeOutRepliesOverlay } from "./out-replies-overlay";

describe("isReplyWrite (issue #969, port of omp's reply-write.ts)", () => {
  it("claims only a write whose target is the out scheme", () => {
    expect(isReplyWrite("write", { path: "out://", content: "hi" })).toBe(true);
    expect(isReplyWrite("write", { path: "OUT://note" })).toBe(true);
    expect(isReplyWrite("write", { file_path: "out://" })).toBe(true);
    expect(isReplyWrite("write", { path: "local://out.md" })).toBe(false);
    expect(isReplyWrite("write", { path: "src/out.ts" })).toBe(false);
    expect(isReplyWrite("bash", { command: "echo hi > out://" })).toBe(false);
  });

  it("stays undecided while streamed args could still become out://", () => {
    expect(isReplyWrite("write", {})).toBeUndefined();
    expect(isReplyWrite("write", undefined)).toBeUndefined();
    expect(isReplyWrite("write", { path: "ou" })).toBeUndefined();
    expect(isReplyWrite("write", { path: "out:/" })).toBeUndefined();
    expect(isReplyWrite("write", { path: "outline.md" })).toBe(false);
  });
});

describe("toolResultReplies", () => {
  it("keeps the string replies a bash run reported and ignores anything else", () => {
    expect(toolResultReplies({ replies: ["a\n", 3, "b"] })).toEqual(["a\n", "b"]);
    expect(toolResultReplies({ replies: "a" })).toEqual([]);
    expect(toolResultReplies(null)).toEqual([]);
  });
});

describe("supportsOutReplies", () => {
  it("admits omp 18.14.0 and later only", () => {
    expect(supportsOutReplies("18.14.0")).toBe(true);
    expect(supportsOutReplies("19.0.0")).toBe(true);
    expect(supportsOutReplies("18.13.3")).toBe(false);
    expect(supportsOutReplies(null)).toBe(false);
  });
});

describe("writeOutRepliesOverlay", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });
  function tmp(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-out-test-"));
    dirs.push(dir);
    return dir;
  }

  it("writes the out.enabled pin", () => {
    const dir = tmp();
    const file = writeOutRepliesOverlay(dir, true);
    expect(file).toBe(outRepliesOverlayPath(dir));
    expect(fs.readFileSync(file!, "utf8")).toBe("out:\n  enabled: true\n");
  });

  it("removes a stale artifact on a null pin", () => {
    const dir = tmp();
    writeOutRepliesOverlay(dir, true);
    expect(writeOutRepliesOverlay(dir, null)).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
