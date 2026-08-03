import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveFileMentions } from "./mention-resolve";

const cleanups: string[] = [];
afterEach(() => {
  for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mention-resolve-test-"));
  cleanups.push(dir);
  return dir;
}

function write(dir: string, rel: string, content: string | Buffer): void {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe("resolveFileMentions", () => {
  it("inlines a text file with the exact wrapper format", async () => {
    const dir = tmpDir();
    write(dir, "a.txt", "hello");
    const { contextText, images } = await resolveFileMentions(dir, "read @a.txt please");
    expect(contextText).toBe('\n\n<file path="a.txt">\nhello\n</file>');
    expect(images).toEqual([]);
  });

  it("resolves the quoted form for paths with spaces", async () => {
    const dir = tmpDir();
    write(dir, "my file.txt", "spaced");
    const { contextText } = await resolveFileMentions(dir, 'see @"my file.txt" here');
    expect(contextText).toBe('\n\n<file path="my file.txt">\nspaced\n</file>');
  });

  it("ignores an email address", async () => {
    const dir = tmpDir();
    write(dir, "b.com", "not a file mention");
    const { contextText } = await resolveFileMentions(dir, "mail a@b.com now");
    expect(contextText).toBe("");
  });

  it("strips trailing punctuation from the unquoted token", async () => {
    const dir = tmpDir();
    write(dir, "foo.ts", "export {};\n");
    const { contextText } = await resolveFileMentions(dir, "see @foo.ts.");
    expect(contextText).toBe('\n\n<file path="foo.ts">\nexport {};\n\n</file>');
  });

  it("contributes nothing for a missing file", async () => {
    const dir = tmpDir();
    const { contextText, images } = await resolveFileMentions(dir, "open @nope.txt");
    expect(contextText).toBe("");
    expect(images).toEqual([]);
  });

  it("skip-notes a binary file", async () => {
    const dir = tmpDir();
    write(dir, "blob.bin", Buffer.from([1, 0, 2, 3]));
    const { contextText } = await resolveFileMentions(dir, "look @blob.bin");
    expect(contextText).toBe(
      '\n\n<file path="blob.bin">\n(skipped auto-read: binary file, 4 B)\n</file>',
    );
  });

  it("skip-notes a file over the inline cap", async () => {
    const dir = tmpDir();
    write(dir, "big.txt", "x".repeat(300 * 1024));
    const { contextText } = await resolveFileMentions(dir, "look @big.txt");
    expect(contextText).toBe(
      '\n\n<file path="big.txt">\n(skipped auto-read: too large, 300.0 KiB)\n</file>',
    );
  });

  it("attaches a small image and leaves a marker block", async () => {
    const dir = tmpDir();
    const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    write(dir, "pic.png", payload);
    const { contextText, images } = await resolveFileMentions(dir, "what is @pic.png");
    expect(images).toEqual([
      { type: "image", data: payload.toString("base64"), mimeType: "image/png" },
    ]);
    expect(contextText).toBe('\n\n<file path="pic.png">\n[Image attached]\n</file>');
  });

  it("lists a directory with a trailing-slash suffix for subdirs", async () => {
    const dir = tmpDir();
    fs.mkdirSync(path.join(dir, "pkg", "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "pkg", "a.txt"), "a\n");
    const { contextText } = await resolveFileMentions(dir, "what is in @pkg");
    expect(contextText).toBe('\n\n<file path="pkg">\na.txt\nsub/\n</file>');
  });

  it("caps a directory listing and says so", async () => {
    const dir = tmpDir();
    for (let i = 0; i < 501; i++) {
      write(dir, path.join("many", `f${String(i).padStart(3, "0")}.txt`), "");
    }
    const { contextText } = await resolveFileMentions(dir, "list @many");
    expect(contextText).toContain("\n[500 entries limit reached]\n</file>");
    expect(contextText).not.toContain("f500.txt\n");
  });

  it("refuses a path that escapes the project", async () => {
    const dir = tmpDir();
    // Exists and readable relative to the subproject — confinement, not
    // absence, is what must keep it literal.
    write(dir, "escape.txt", "secret");
    const { contextText } = await resolveFileMentions(
      path.join(dir, "sub"),
      "read @../escape.txt",
    );
    expect(contextText).toBe("");
  });

  it("reads a duplicated mention once", async () => {
    const dir = tmpDir();
    write(dir, "a.txt", "hello");
    const { contextText } = await resolveFileMentions(dir, "@a.txt and again @a.txt");
    expect(contextText).toBe('\n\n<file path="a.txt">\nhello\n</file>');
  });
});
