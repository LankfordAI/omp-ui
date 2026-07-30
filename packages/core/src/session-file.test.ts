import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  deriveStatusFromTail,
  hydrateSessionFile,
  parseSessionPrefix,
} from "./session-file";

const HEADER =
  '{"type":"session","version":3,"id":"019faeab-cc7b-7000-8bfc-67242a2869d8","timestamp":"2026-07-29T16:18:42.427Z","cwd":"/home/user/proj"}';

function titleSlot(title: string): string {
  // Fixed-width slot: exactly 256 bytes including the trailing newline.
  const base = `{"type":"title","v":1,"title":${JSON.stringify(title)},"source":"auto","updatedAt":"2026-07-29T16:20:00.000Z","pad":"`;
  const pad = " ".repeat(Math.max(0, 255 - base.length - 1));
  return `${base}${pad}"}\n`;
}

function msg(message: object): string {
  return JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "t", message });
}

const tmpFiles: string[] = [];
function writeTmp(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-sf-"));
  const file = path.join(dir, "s.jsonl");
  fs.writeFileSync(file, contents);
  tmpFiles.push(dir);
  return file;
}

afterEach(() => {
  for (const dir of tmpFiles.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseSessionPrefix", () => {
  it("parses a slotless file (header on line 1)", () => {
    const head = parseSessionPrefix(`${HEADER}\n${msg({ role: "user" })}\n`);
    expect(head).toEqual({
      id: "019faeab-cc7b-7000-8bfc-67242a2869d8",
      cwd: "/home/user/proj",
      created: "2026-07-29T16:18:42.427Z",
    });
  });

  it("takes the title from the slot when the header lacks one", () => {
    const head = parseSessionPrefix(`${titleSlot("Fix the bug")}${HEADER}\n`);
    expect(head.title).toBe("Fix the bug");
    expect(head.id).toBe("019faeab-cc7b-7000-8bfc-67242a2869d8");
  });

  it("prefers the header title over the slot", () => {
    const headerWithTitle = HEADER.replace('"cwd"', '"title":"Header title","cwd"');
    const head = parseSessionPrefix(`${titleSlot("Slot title")}${headerWithTitle}\n`);
    expect(head.title).toBe("Header title");
  });

  it("skips lines not starting with { and lines cut mid-JSON", () => {
    const garbage = `not json at all\n{"type":"title","title":"cut off never closed\n${HEADER}\n`;
    const head = parseSessionPrefix(garbage);
    expect(head.id).toBe("019faeab-cc7b-7000-8bfc-67242a2869d8");
    expect(head.title).toBeUndefined();
  });

  it("returns an empty head when the prefix holds no header", () => {
    expect(parseSessionPrefix("")).toEqual({});
    expect(parseSessionPrefix('{"type":"message"}\n')).toEqual({});
  });
});

describe("deriveStatusFromTail", () => {
  it("maps assistant stopReason error/aborted/length", () => {
    expect(deriveStatusFromTail(msg({ role: "assistant", stopReason: "error" }))).toBe("error");
    expect(deriveStatusFromTail(msg({ role: "assistant", stopReason: "aborted" }))).toBe("aborted");
    expect(deriveStatusFromTail(msg({ role: "assistant", stopReason: "length" }))).toBe(
      "interrupted",
    );
  });

  it("classifies a trailing toolCall as interrupted", () => {
    const line = msg({
      role: "assistant",
      stopReason: "toolUse",
      content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }],
    });
    expect(deriveStatusFromTail(line)).toBe("interrupted");
  });

  it("classifies a clean assistant turn as complete", () => {
    const line = msg({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "done" }],
    });
    expect(deriveStatusFromTail(line)).toBe("complete");
  });

  it("classifies a trailing toolResult as interrupted", () => {
    expect(deriveStatusFromTail(msg({ role: "toolResult" }))).toBe("interrupted");
  });

  it("classifies a trailing user message as pending", () => {
    expect(deriveStatusFromTail(msg({ role: "user", content: "hi" }))).toBe("pending");
  });

  it("walks backwards to the last message entry", () => {
    const tail = [
      msg({ role: "assistant", stopReason: "stop", content: [] }),
      msg({ role: "user", content: "next" }),
      '{"type":"model_change","modelId":"x"}',
      "trailing garbage",
      "",
    ].join("\n");
    expect(deriveStatusFromTail(tail)).toBe("pending");
  });

  it("skips a message entry with no message payload", () => {
    const tail = [
      msg({ role: "assistant", stopReason: "stop", content: [] }),
      '{"type":"message"}',
    ].join("\n");
    expect(deriveStatusFromTail(tail)).toBe("complete");
  });

  it("returns unknown for an empty tail or no message line", () => {
    expect(deriveStatusFromTail("")).toBe("unknown");
    expect(deriveStatusFromTail('{"type":"model_change"}\n')).toBe("unknown");
    expect(deriveStatusFromTail("garbage\n")).toBe("unknown");
  });
});

describe("hydrateSessionFile", () => {
  it("hydrates head, status, and mtime from a real file", async () => {
    const file = writeTmp(
      `${titleSlot("Ship it")}${HEADER}\n${msg({ role: "user", content: "go" })}\n${msg({ role: "assistant", stopReason: "stop", content: [] })}\n`,
    );
    const h = await hydrateSessionFile(file);
    expect(h).toMatchObject({
      id: "019faeab-cc7b-7000-8bfc-67242a2869d8",
      cwd: "/home/user/proj",
      title: "Ship it",
      created: "2026-07-29T16:18:42.427Z",
      status: "complete",
    });
    expect(h.mtime).toBeInstanceOf(Date);
  });

  it("reports unknown when the final message exceeds the 32 KiB tail window", async () => {
    const big = msg({
      role: "assistant",
      stopReason: "stop",
      content: [{ type: "text", text: "x".repeat(40 * 1024) }],
    });
    const file = writeTmp(`${HEADER}\n${big}\n`);
    const h = await hydrateSessionFile(file);
    expect(h.id).toBe("019faeab-cc7b-7000-8bfc-67242a2869d8");
    expect(h.status).toBe("unknown");
  });
});
