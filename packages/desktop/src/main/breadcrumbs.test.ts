import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createBreadcrumbRing, NO_BREADCRUMBS } from "./breadcrumbs";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "crumbs-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function logLines(): string[] {
  return fs
    .readFileSync(path.join(dir, "breadcrumbs.log"), "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

describe("createBreadcrumbRing", () => {
  it("caps the ring at 200 entries, dropping the oldest", () => {
    const ring = createBreadcrumbRing(dir);
    for (let i = 0; i < 250; i += 1) ring.record("session-spawn", { tabId: `t${i}` });
    const entries = ring.entries();
    expect(entries).toHaveLength(200);
    expect(entries[0]!.tabId).toBe("t50");
    expect(entries.at(-1)!.tabId).toBe("t249");
    expect(entries.map((e) => e.seq)).toEqual(
      Array.from({ length: 200 }, (_, i) => i + 51),
    );
  });

  it("appends one parseable JSON line per record, ISO-prefixed by main-log", () => {
    const ring = createBreadcrumbRing(dir);
    ring.record("launch", { detail: "v1 packaged=false" });
    ring.record("session-exit", { tabId: "t1", detail: "code=0" });
    const lines = logLines();
    expect(lines).toHaveLength(2);
    const [first, second] = lines.map((line) => {
      const match = /^(\S+) (.*)$/.exec(line);
      expect(match, line).not.toBeNull();
      expect(Number.isNaN(Date.parse(match![1]!)), line).toBe(false);
      return JSON.parse(match![2]!) as Record<string, unknown>;
    });
    expect(first).toEqual({ seq: 1, kind: "launch", detail: "v1 packaged=false" });
    expect(second).toEqual({ seq: 2, kind: "session-exit", tabId: "t1", detail: "code=0" });
  });

  it("truncates detail at the bound so the ring cannot be crowded out", () => {
    const ring = createBreadcrumbRing(dir);
    ring.record("main-exception", { detail: "x".repeat(5_000) });
    const [entry] = ring.entries();
    expect(entry!.detail).toHaveLength(200);
    expect(entry!.detail!.endsWith("…")).toBe(true);
  });

  it("carries mode on session-mode rows", () => {
    const ring = createBreadcrumbRing(dir);
    ring.record("session-mode", { tabId: "t1", mode: "pty" });
    expect(ring.entries()[0]).toMatchObject({ kind: "session-mode", tabId: "t1", mode: "pty" });
    expect(JSON.parse(logLines()[0]!.split(" ")[1]!)).toEqual({
      seq: 1,
      kind: "session-mode",
      tabId: "t1",
      mode: "pty",
    });
  });

  it("never throws when the log dir cannot be written", () => {
    const blocked = path.join(dir, "blocked");
    fs.writeFileSync(blocked, "not a dir");
    const ring = createBreadcrumbRing(blocked);
    expect(() => ring.record("quit")).not.toThrow();
    // The ring still records in memory even when the file sink fails.
    expect(ring.entries()).toHaveLength(1);
  });

  it("rotates at 1 MiB through the shared main-log machinery", () => {
    const ring = createBreadcrumbRing(dir);
    // detail caps at 200 chars, so each line is ~260 bytes; 4200 cross the
    // 1 MiB ceiling.
    for (let i = 0; i < 4200; i += 1) ring.record("renderer-gone", { detail: "y".repeat(300) });
    expect(fs.existsSync(path.join(dir, "breadcrumbs.log.old"))).toBe(true);
    expect(fs.statSync(path.join(dir, "breadcrumbs.log")).size).toBeLessThanOrEqual(
      1024 * 1024,
    );
  });
});

describe("NO_BREADCRUMBS", () => {
  it("swallows records and reports an empty ring", () => {
    NO_BREADCRUMBS.record("launch");
    expect(NO_BREADCRUMBS.entries()).toEqual([]);
  });
});
