import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CARRYOVER_CHAR_BUDGET,
  CARRYOVER_MESSAGE_CHAR_CAP,
  renderCarryoverDigest,
} from "./carryover-context";
import { carryoverContextPath, stageCarryoverContext } from "./carryover-artifact";

const dirs: string[] = [];

function tempLineageDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "carryover-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("renderCarryoverDigest", () => {
  it("renders one turn block per message, oldest first, under the header", () => {
    const digest = renderCarryoverDigest([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi there" },
      { role: "user", text: "ship it" },
    ]);
    expect(digest.startsWith("Earlier messages from this session's previous process, oldest first."));
    const at = (role: string) => digest.indexOf(`<turn role="${role}">`);
    expect(at("user")).toBeLessThan(at("assistant"));
    expect(digest.indexOf("ship it")).toBeGreaterThan(digest.indexOf("hi there"));
    expect(digest).toContain('<turn role="user">\nship it\n</turn>');
    expect(digest).not.toContain("omitted");
  });

  it("returns the empty string for no messages", () => {
    expect(renderCarryoverDigest([])).toBe("");
  });

  it("caps each message at the per-message ceiling with an ellipsis", () => {
    const digest = renderCarryoverDigest([
      { role: "user", text: "x".repeat(CARRYOVER_MESSAGE_CHAR_CAP + 500) },
    ]);
    expect(digest).toContain(`${"x".repeat(CARRYOVER_MESSAGE_CHAR_CAP)}…`);
    expect(digest).not.toContain("x".repeat(CARRYOVER_MESSAGE_CHAR_CAP + 1));
  });

  it("keeps the newest messages when the budget is exhausted and notes the omission", () => {
    const each = CARRYOVER_MESSAGE_CHAR_CAP - 100;
    const messages = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((letter) => ({
      role: "user" as const,
      text: letter.repeat(each),
    }));
    const digest = renderCarryoverDigest(messages);
    expect(digest).toContain("(earlier messages omitted)");
    expect(digest).toContain("j".repeat(each));
    expect(digest).toContain("c".repeat(each));
    expect(digest).not.toContain("b".repeat(each));
    expect(digest).not.toContain("a".repeat(each));
    // The omission line sits before the first turn block.
    expect(digest.indexOf("(earlier messages omitted)")).toBeLessThan(
      digest.indexOf("<turn"),
    );
  });

  it("emits nothing when even the newest message cannot fit", () => {
    expect(
      renderCarryoverDigest([
        { role: "user", text: "x".repeat(CARRYOVER_CHAR_BUDGET) },
      ]),
    ).toBe("");
  });
});

describe("stageCarryoverContext", () => {
  it("writes the artifact and returns its path for a digest", () => {
    const dir = tempLineageDir();
    const file = stageCarryoverContext(dir, "<turn role=\"user\">\nhello\n</turn>");
    expect(file).toBe(carryoverContextPath(dir));
    expect(fs.readFileSync(file!, "utf8")).toBe('<turn role="user">\nhello\n</turn>');
  });

  it("removes a stale artifact when the digest is null", () => {
    const dir = tempLineageDir();
    stageCarryoverContext(dir, "seed");
    expect(stageCarryoverContext(dir, null)).toBeNull();
    expect(fs.existsSync(carryoverContextPath(dir))).toBe(false);
  });

  it("treats a blank digest as no seed and removes the stale file", () => {
    const dir = tempLineageDir();
    stageCarryoverContext(dir, "seed");
    expect(stageCarryoverContext(dir, "   ")).toBeNull();
    expect(fs.existsSync(carryoverContextPath(dir))).toBe(false);
  });

  it("never throws when there is nothing to remove", () => {
    const dir = tempLineageDir();
    expect(stageCarryoverContext(dir, null)).toBeNull();
  });

  it("creates the lineage dir when absent", () => {
    const dir = path.join(tempLineageDir(), "lineage");
    expect(stageCarryoverContext(dir, "seed")).toBe(carryoverContextPath(dir));
    expect(fs.existsSync(carryoverContextPath(dir))).toBe(true);
  });
});
