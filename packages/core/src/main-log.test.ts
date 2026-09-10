import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { appendMainLog } from "./main-log";

let base = "";

afterEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

describe("appendMainLog (issue #184)", () => {
  it("creates the dir and appends timestamped lines", () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-mainlog-"));
    const dir = path.join(base, "logs");
    appendMainLog(dir, "main.log", "hello");
    appendMainLog(dir, "main.log", "world");
    const content = fs.readFileSync(path.join(dir, "main.log"), "utf8");
    expect(content).toMatch(/^\d{4}-\d{2}-\d{2}T.* hello\n\d{4}-\d{2}-\d{2}T.* world\n$/);
  });

  it("rotates once at 1 MiB, keeping one generation", () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-mainlog-"));
    const dir = path.join(base, "logs");
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "main.log"), "x".repeat(1024 * 1024));
    appendMainLog(dir, "main.log", "fresh");
    expect(fs.readFileSync(path.join(dir, "main.log.old"), "utf8")).toHaveLength(1024 * 1024);
    expect(fs.readFileSync(path.join(dir, "main.log"), "utf8")).toContain("fresh");
  });

  it("never throws on an unwritable dir", () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-mainlog-"));
    // A regular file where the log dir must be created: mkdir fails ENOTDIR.
    const blocker = path.join(base, "blocker");
    fs.writeFileSync(blocker, "file, not a dir");
    expect(() => appendMainLog(path.join(blocker, "sub"), "main.log", "x")).not.toThrow();
  });
});
