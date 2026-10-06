import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionLocation } from "./archive";
import {
  lastAssistantText,
  parseDayParam,
  renderDayIndex,
  renderSessionSummary,
  SUMMARY_TAIL_CAP,
} from "./sessions-resource";
import type { OwnedSessionRecord, ProjectRecord } from "./types";

const DAY_REFUSAL = "day must be a calendar date in YYYY-MM-DD form, for example 2026-10-06";
const UNAVAILABLE = "Summary unavailable: the transcript could not be read.";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-sessions-res-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function sessionRecord(patch: Partial<OwnedSessionRecord> = {}): OwnedSessionRecord {
  return {
    tabId: "tab-1",
    sessionId: null,
    lineageDir: "omp-ui--proj--11111111-2222-3333-4444-555555555555",
    projectCwd: "/abs/proj",
    worktree: null,
    planImplementationSource: null, experiment: null,
    launchedAt: "2026-07-29T10:00:00.000Z",
    mode: "pty",
    compactionMethod: null,
    approvalMode: null,
    serviceTier: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null,
    subagentModels: null,
    proposedPlans: [],
    cachedTitle: null,
    cachedModified: null,
    agentMode: "build",
    ...patch,
  };
}

function projectRecord(projectPath: string, name: string): ProjectRecord {
  return {
    path: projectPath,
    name,
    addedAt: "2026-01-01T00:00:00.000Z",
    lastModel: null,
    lastThinkingLevel: null,
    lastAdvisor: null,
    lastAdvisorModel: null,
    defaultModel: null,
    defaultAdvisorModel: null,
    browserClock: false,
    reviewRoster: null,
    knowledgeHome: null,
  };
}

/** ISO string of a LOCAL wall-clock time (month is 0-based like Date). */
function localIso(y: number, m: number, d: number, h: number, mi: number): string {
  return new Date(y, m, d, h, mi).toISOString();
}

function msg(message: object): string {
  return JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: "t", message });
}

function assistant(text: string, stopReason = "stop"): string {
  return msg({ role: "assistant", content: [{ type: "text", text }], stopReason });
}

const HEADER = '{"type":"session","version":3,"id":"s1","timestamp":"2026-10-06T10:00:00.000Z","cwd":"/abs/proj"}';

describe("parseDayParam", () => {
  it("defaults an absent day to the local calendar day of now", () => {
    expect(parseDayParam(null, new Date(2026, 9, 6, 23, 30))).toEqual({ ok: true, day: "2026-10-06" });
  });

  it.each(["2026-02-30", "2026-13-01", "2026-1-5", "", "today", "0099-01-01"])("refuses %j", (raw) => {
    expect(parseDayParam(raw, new Date(2026, 9, 6))).toEqual({ ok: false, error: DAY_REFUSAL });
  });

  it("accepts a real leap day", () => {
    expect(parseDayParam("2024-02-29", new Date(2026, 9, 6))).toEqual({ ok: true, day: "2024-02-29" });
  });
});

describe("renderDayIndex", () => {
  it("lists a session by the local date of cachedModified, never launchedAt", () => {
    const records = [
      sessionRecord({
        sessionId: "sid-1",
        cachedTitle: "Overnight",
        launchedAt: localIso(2026, 9, 5, 22, 0),
        cachedModified: localIso(2026, 9, 6, 0, 30),
      }),
    ];
    const today = renderDayIndex(records, [], "2026-10-06");
    expect(today).toContain("**Overnight**");
    expect(today).toContain("· 00:30 ·");
    expect(renderDayIndex(records, [], "2026-10-05")).toBe(
      "# Sessions on 2026-10-05\n\nNo omp-ui sessions were active on 2026-10-05.\n",
    );
  });

  it("never lists an unmaterialized session or one with no usable cachedModified", () => {
    const records = [
      sessionRecord({ lineageDir: "a", sessionId: null, cachedTitle: "No id", cachedModified: localIso(2026, 9, 6, 9, 0) }),
      sessionRecord({ lineageDir: "b", sessionId: "sid-b", cachedTitle: "No mtime", cachedModified: null }),
      sessionRecord({ lineageDir: "c", sessionId: "sid-c", cachedTitle: "Bad mtime", cachedModified: "garbage" }),
    ];
    expect(renderDayIndex(records, [], "2026-10-06")).toBe(
      "# Sessions on 2026-10-06\n\nNo omp-ui sessions were active on 2026-10-06.\n",
    );
  });

  it("collapses a lineage to its newest record", () => {
    const records = [
      sessionRecord({ tabId: "t1", sessionId: "old", cachedTitle: "Old title", cachedModified: localIso(2026, 9, 6, 9, 0) }),
      sessionRecord({ tabId: "t2", sessionId: "new", cachedTitle: "New title", cachedModified: localIso(2026, 9, 6, 15, 0) }),
    ];
    const text = renderDayIndex(records, [], "2026-10-06");
    expect(text).toContain("**New title**");
    expect(text).not.toContain("Old title");
    expect(text).toContain("1 session across 1 project.");
    expect(text).toContain("omp-ui://sessions/new/summary");
  });

  it("groups by project newest first, rows newest first, with the row shape", () => {
    const records = [
      sessionRecord({
        lineageDir: "alpha-early",
        sessionId: "a-early",
        projectCwd: "/abs/alpha",
        mode: "rpc-ui",
        worktree: { path: "/wt/alpha", branch: "work-branch", base: "main" },
        cachedTitle: "Alpha early",
        cachedModified: localIso(2026, 9, 6, 10, 0),
      }),
      sessionRecord({
        lineageDir: "alpha-late",
        sessionId: "a-late",
        projectCwd: "/abs/alpha",
        mode: "pty",
        cachedTitle: "Alpha late",
        cachedModified: localIso(2026, 9, 6, 14, 5),
      }),
      sessionRecord({
        lineageDir: "beta",
        sessionId: "b-only",
        projectCwd: "/abs/beta-dir",
        mode: "rpc-ui",
        cachedTitle: "  Beta\n  work  ",
        cachedModified: localIso(2026, 9, 6, 16, 0),
      }),
    ];
    const text = renderDayIndex(records, [projectRecord("/abs/alpha", "Alpha Project")], "2026-10-06");
    expect(text).toBe(
      [
        "# Sessions on 2026-10-06",
        "",
        "3 sessions across 2 projects.",
        "",
        "## beta-dir",
        "",
        "- **Beta work** · native · 16:00 · omp-ui://sessions/b-only/summary",
        "",
        "## Alpha Project",
        "",
        "- **Alpha late** · terminal · 14:05 · omp-ui://sessions/a-late/summary",
        "- **Alpha early** · native · work-branch · 10:00 · omp-ui://sessions/a-early/summary",
        "",
      ].join("\n"),
    );
  });

  it("caps the index at a row boundary with a count of the rest", () => {
    const records = Array.from({ length: 200 }, (_, i) =>
      sessionRecord({
        tabId: `t${i}`,
        lineageDir: `lineage-${i}`,
        sessionId: `sid-${i}`,
        cachedTitle: `${String(i).padStart(3, "0")}${"x".repeat(197)}`,
        cachedModified: localIso(2026, 9, 6, 8, i % 60),
      }),
    );
    const text = renderDayIndex(records, [], "2026-10-06");
    expect(text.length).toBeLessThanOrEqual(24_000);
    expect(text).toContain("200 sessions across 1 project.");
    const lines = text.split("\n");
    expect(lines.at(-1)).toBe("");
    const tailMatch = /^… (\d+) more sessions; narrow the day or the query\.$/.exec(lines.at(-2) ?? "");
    expect(tailMatch).not.toBeNull();
    const rows = lines.filter((line) => line.endsWith("/summary"));
    expect(Number(tailMatch?.[1]) + rows.length).toBe(200);
    expect(lines.at(-3)).toBe("");
    expect(lines.at(-4)).toMatch(/^- \*\*\d{3}x{197}\*\* · terminal · \d{2}:\d{2} · omp-ui:\/\/sessions\/sid-\d+\/summary$/);
  });
});

describe("lastAssistantText", () => {
  it("picks the last qualifying assistant message", () => {
    expect(lastAssistantText([assistant("first"), assistant("second")].join("\n"))).toBe("second");
  });

  it("skips errored, aborted, tool-call-only, empty-text, toolResult, and user entries", () => {
    const jsonl = [
      HEADER,
      assistant("good"),
      assistant("errored", "error"),
      assistant("aborted", "aborted"),
      msg({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }], stopReason: "toolUse" }),
      msg({ role: "assistant", content: [{ type: "text", text: "   " }], stopReason: "stop" }),
      msg({ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: "assistant output" }] }),
      msg({ role: "user", content: [{ type: "text", text: "dear assistant" }] }),
    ].join("\n");
    expect(lastAssistantText(jsonl)).toBe("good");
  });

  it("joins multiple text blocks with a blank line", () => {
    const line = msg({
      role: "assistant",
      content: [
        { type: "text", text: " one " },
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "two" },
      ],
      stopReason: "stop",
    });
    expect(lastAssistantText(line)).toBe("one\n\ntwo");
  });

  it("tolerates a partial first line from a tail window", () => {
    const full = assistant("cut off");
    const partial = `{${full.slice(full.indexOf('"role"'))}`;
    expect(lastAssistantText(partial)).toBeNull();
    expect(lastAssistantText(`${partial}\n${assistant("whole")}\n`)).toBe("whole");
  });

  it("returns null when nothing qualifies", () => {
    expect(lastAssistantText("")).toBeNull();
    expect(lastAssistantText([HEADER, msg({ role: "user", content: [{ type: "text", text: "assistant?" }] })].join("\n"))).toBeNull();
  });
});

describe("renderSessionSummary", () => {
  const record = sessionRecord({
    sessionId: "sid-1",
    projectCwd: "/abs/proj",
    mode: "rpc-ui",
    cachedTitle: "Title",
    cachedModified: localIso(2026, 9, 6, 11, 7),
  });
  const projects = [projectRecord("/abs/proj", "Project")];
  const heading = "# Title · Project · native · 2026-10-06 11:07\n\n## Where it landed\n\n";
  const at = (location: SessionLocation) => async (): Promise<SessionLocation> => location;

  function writeActive(contents: string): string {
    const file = path.join(tmpDir(), "2026-10-06T10-00-00-000Z_sid-1.jsonl");
    fs.writeFileSync(file, contents);
    return file;
  }

  it("carries the last landed assistant text, capped, never user or aborted text", async () => {
    const userLine = msg({ role: "user", content: [{ type: "text", text: "USER-MARKER-768 for the assistant" }] });
    const file = writeActive(
      [
        HEADER,
        userLine,
        assistant(`${"A".repeat(2_500)}LANDED`),
        userLine,
        assistant("ABORTED-TEXT", "aborted"),
        msg({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: {} }], stopReason: "toolUse" }),
        "",
      ].join("\n"),
    );
    const text = await renderSessionSummary(record, projects, at({ where: "active", filePath: file }));
    expect(text.startsWith("# Title · Project · native")).toBe(true);
    expect(text).toContain("## Where it landed");
    expect(text).toBe(`${heading}${"A".repeat(SUMMARY_TAIL_CAP)}…\n`);
    expect(text).not.toContain("USER-MARKER-768");
    expect(text).not.toContain("ABORTED-TEXT");
  });

  it("reads an archived transcript in memory without unarchiving it", async () => {
    const sessionsRoot = tmpDir();
    const archiveDir = path.join(tmpDir(), record.lineageDir);
    fs.mkdirSync(archiveDir);
    const gzName = "2026-10-06T10-00-00-000Z_sid-1.jsonl.gz";
    const gzPath = path.join(archiveDir, gzName);
    fs.writeFileSync(gzPath, zlib.gzipSync([HEADER, assistant("archived landing")].join("\n")));
    const text = await renderSessionSummary(record, projects, at({ where: "archived", filePath: gzPath }));
    expect(text).toBe(`${heading}archived landing\n`);
    expect(fs.readdirSync(archiveDir)).toEqual([gzName]);
    expect(fs.existsSync(path.join(sessionsRoot, record.lineageDir))).toBe(false);
  });

  it("falls back to the whole file when the tail window holds no assistant text", async () => {
    const huge = msg({
      role: "toolResult",
      toolCallId: "c1",
      content: [{ type: "text", text: "z".repeat(Math.ceil(1.1 * 1_048_576)) }],
    });
    const file = writeActive([HEADER, assistant("before the flood"), huge, ""].join("\n"));
    const text = await renderSessionSummary(record, projects, at({ where: "active", filePath: file }));
    expect(text).toBe(`${heading}before the flood\n`);
  });

  it.each([
    ["a missing location", async (): Promise<SessionLocation> => ({ where: "missing" })],
    [
      "an active path that does not exist",
      async (): Promise<SessionLocation> => ({ where: "active", filePath: path.join(os.tmpdir(), "omp-ui-nope", "x.jsonl") }),
    ],
    [
      "a corrupt archive",
      async (): Promise<SessionLocation> => {
        const gz = path.join(tmpDir(), "x.jsonl.gz");
        fs.writeFileSync(gz, "not gzip at all");
        return { where: "archived", filePath: gz };
      },
    ],
    [
      "a rejecting locate",
      async (): Promise<SessionLocation> => {
        throw new Error("boom");
      },
    ],
    [
      "a transcript with no qualifying message",
      async (): Promise<SessionLocation> => ({
        where: "active",
        filePath: writeActive([HEADER, msg({ role: "user", content: [{ type: "text", text: "hi assistant" }] })].join("\n")),
      }),
    ],
  ])("answers the unavailable line for %s", async (_label, locate) => {
    expect(await renderSessionSummary(record, projects, locate)).toBe(`${heading}${UNAVAILABLE}\n`);
  });
});
