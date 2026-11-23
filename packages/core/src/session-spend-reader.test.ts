import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionSpendDiskCache, readSessionSpendFromDisk } from "./session-spend-reader";

let tmpDir = "";

function writeLines(filePath: string, lines: unknown[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + "\n";
  if (filePath.endsWith(".gz")) {
    fs.writeFileSync(filePath, zlib.gzipSync(Buffer.from(body, "utf8")));
  } else {
    fs.writeFileSync(filePath, body, "utf8");
  }
}

function assistantEntry(
  timestamp: string,
  cost: number,
  input: number,
  output: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: "message",
    timestamp,
    message: {
      role: "assistant",
      usage: {
        cost: { total: cost },
        input,
        output,
        reasoningTokens: extra.reasoningTokens ?? 0,
        cacheRead: extra.cacheRead ?? 0,
        cacheWrite: extra.cacheWrite ?? 0,
        totalTokens: input + output + Number(extra.reasoningTokens ?? 0) + Number(extra.cacheRead ?? 0) + Number(extra.cacheWrite ?? 0),
        premiumRequests: extra.premiumRequests ?? 0,
      },
    },
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-spend-reader-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("readSessionSpendFromDisk", () => {
  it("sums active root and nested subagent transcripts while excluding advisors, toolResults, foreign files, and pre-fork entries", async () => {
    const root = path.join(tmpDir, "2026-11-22_root.jsonl");
    const artifacts = path.join(tmpDir, "2026-11-22_root");
    writeLines(root, [
      '{ "type" : "session" , "timestamp": "2026-11-22T10:00:00.000Z" }',
      // Pre-fork entry copied from parent: must be ignored.
      assistantEntry("2026-11-22T09:59:59.000Z", 5.0, 900, 100),
      assistantEntry("2026-11-22T10:00:05.000Z", 0.2, 100, 50, { premiumRequests: 1 }),
      // toolResult usage must never be counted.
      {
        type: "message",
        timestamp: "2026-11-22T10:00:06.000Z",
        message: { role: "toolResult", usage: { cost: { total: 9.9 }, input: 999, output: 1, totalTokens: 1000 } },
      },
      // model_usage entry is counted.
      {
        type: "model_usage",
        timestamp: "2026-11-22T10:00:10.000Z",
        purpose: "cache-warm",
        usage: { cost: { total: 0.05 }, input: 10, output: 0, cacheWrite: 20, totalTokens: 30, premiumRequests: 0 },
      },
    ]);
    writeLines(path.join(artifacts, "nested", "sub-1.jsonl"), [
      { type: "session", timestamp: "2026-11-22T10:01:00.000Z" },
      assistantEntry("2026-11-22T10:01:02.000Z", 0.3, 200, 80, { reasoningTokens: 20, premiumRequests: 2 }),
    ]);
    // Advisor transcripts are excluded.
    writeLines(path.join(artifacts, "__advisor.jsonl"), [
      { type: "session", timestamp: "2026-11-22T10:01:00.000Z" },
      assistantEntry("2026-11-22T10:01:02.000Z", 7.7, 700, 70),
    ]);
    writeLines(path.join(artifacts, "nested", "__advisor.review.jsonl"), [
      { type: "session", timestamp: "2026-11-22T10:01:00.000Z" },
      assistantEntry("2026-11-22T10:01:02.000Z", 8.8, 800, 80),
    ]);
    // Foreign jsonl without session header within first 4 KiB is ignored.
    writeLines(path.join(artifacts, "foreign.jsonl"), [
      JSON.stringify({ type: "other", payload: "x".repeat(5000) }),
      assistantEntry("2026-11-22T10:02:00.000Z", 3.3, 300, 30),
    ]);

    const totals = await readSessionSpendFromDisk({ where: "active", filePath: root });
    expect(totals).not.toBeNull();
    expect(totals!.cost).toBeCloseTo(0.55, 6);
    expect(totals!.input).toBe(310);
    expect(totals!.output).toBe(130);
    expect(totals!.reasoning).toBe(20);
    expect(totals!.cacheWrite).toBe(20);
    expect(totals!.totalTokens).toBe(480);
    expect(totals!.premiumRequests).toBe(3);
    expect(totals!.requests).toBe(3);
  });

  it("reads archived .jsonl.gz roots along with sibling active and gzipped artifacts", async () => {
    const root = path.join(tmpDir, "2026-11-22_archived.jsonl.gz");
    const artifacts = path.join(tmpDir, "2026-11-22_archived");
    writeLines(root, [
      { type: "session", timestamp: "2026-11-22T10:00:00.000Z" },
      assistantEntry("2026-11-22T10:00:01.000Z", 0.4, 100, 20),
    ]);
    writeLines(path.join(artifacts, "sub.jsonl.gz"), [
      { type: "session", timestamp: "2026-11-22T10:00:02.000Z" },
      assistantEntry("2026-11-22T10:00:03.000Z", 0.15, 50, 10),
    ]);
    writeLines(path.join(artifacts, "__advisor.jsonl.gz"), [
      { type: "session", timestamp: "2026-11-22T10:00:02.000Z" },
      assistantEntry("2026-11-22T10:00:03.000Z", 9.0, 500, 100),
    ]);

    const totals = await readSessionSpendFromDisk({ where: "archived", filePath: root });
    expect(totals).not.toBeNull();
    expect(totals!.cost).toBeCloseTo(0.55, 6);
    expect(totals!.totalTokens).toBe(180);
    expect(totals!.requests).toBe(2);
  });

  it("returns null for missing locations or corrupt gzip files", async () => {
    expect(await readSessionSpendFromDisk({ where: "missing" })).toBeNull();
    const corrupt = path.join(tmpDir, "bad.jsonl.gz");
    fs.writeFileSync(corrupt, "not gzip bytes");
    expect(await readSessionSpendFromDisk({ where: "archived", filePath: corrupt })).toBeNull();
  });
});

describe("SessionSpendDiskCache", () => {
  it("caches unchanged files, invalidates on append, and prunes dropped paths", async () => {
    const root = path.join(tmpDir, "2026-11-22_cached.jsonl");
    writeLines(root, [
      { type: "session", timestamp: "2026-11-22T10:00:00.000Z" },
      assistantEntry("2026-11-22T10:00:01.000Z", 0.1, 40, 10),
    ]);
    const cache = new SessionSpendDiskCache();
    const loc = { where: "active" as const, filePath: root };
    const first = await cache.read(loc);
    const second = await cache.read(loc);
    expect(second).toBe(first);
    expect(first?.cost).toBeCloseTo(0.1, 6);

    fs.appendFileSync(root, JSON.stringify(assistantEntry("2026-11-22T10:00:02.000Z", 0.25, 60, 20)) + "\n");
    const updated = await cache.read(loc);
    expect(updated).not.toBe(first);
    expect(updated?.cost).toBeCloseTo(0.35, 6);

    cache.prune(new Set());
    const afterPrune = await cache.read(loc);
    expect(afterPrune).not.toBe(updated);
    expect(afterPrune?.cost).toBeCloseTo(0.35, 6);
  });
});
