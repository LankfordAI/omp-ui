import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_SPEND_COMMAND,
  SESSION_SPEND_POLL_MS,
  SESSION_SPEND_STATUS_KEY,
  parseSessionSpendSnapshot,
  type SessionSpendSnapshot,
} from "./session-spend";
import { sessionSpendExtensionPath, writeSessionSpendExtension } from "./session-spend-extension";
import { transpileGeneratedExtension, typecheckGeneratedExtension } from "./generated-extension-test-utils";

const nodeRequire = createRequire(import.meta.url);
const dirs: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-spend-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

interface FakeRoot {
  prompt(): Promise<void>;
}

interface SpendHarness {
  /** What the fake root's sessionManager.getSessionFile() returns. */
  setSessionFile(file: string | undefined): void;
  bindRoot(): Promise<FakeRoot>;
  arm(): Promise<void>;
  published: SessionSpendSnapshot[];
  latest(): SessionSpendSnapshot;
}

function executableExtension(): SpendHarness {
  let sessionFile: string | undefined;
  class FakeAgentSession {
    sessionManager = { getSessionFile: (): string | undefined => sessionFile };
    async prompt(): Promise<void> {}
  }

  const file = writeSessionSpendExtension(tempDir());
  const output = transpileGeneratedExtension(fs.readFileSync(file, "utf8"), "cjs");
  const loaded = { exports: {} as { default?: (api: unknown) => void } };
  Function("module", "exports", "require", output)(loaded, loaded.exports, nodeRequire);
  const factory = loaded.exports.default;
  if (!factory) throw new Error("generated extension has no default factory");

  let handler:
    | ((args: string, ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } }) => Promise<void>)
    | undefined;
  const published: SessionSpendSnapshot[] = [];
  factory({
    pi: { AgentSession: FakeAgentSession },
    registerCommand: (name: string, options: { handler: typeof handler }): void => {
      expect(name).toBe(SESSION_SPEND_COMMAND);
      handler = options.handler;
    },
  });

  return {
    setSessionFile: (next) => {
      sessionFile = next;
    },
    bindRoot: async () => {
      const session = new FakeAgentSession();
      await session.prompt();
      return session;
    },
    arm: async () => {
      if (!handler) throw new Error("generated extension did not register its command");
      await handler("", {
        ui: {
          setStatus: (key, text): void => {
            expect(key).toBe(SESSION_SPEND_STATUS_KEY);
            const parsed = parseSessionSpendSnapshot(text);
            if (parsed === null) throw new Error(`malformed snapshot: ${text}`);
            published.push(parsed);
          },
        },
      });
    },
    published,
    latest: () => {
      const value = published.at(-1);
      if (!value) throw new Error("generated extension published no snapshot");
      return value;
    },
  };
}

const HEADER_AT = "2026-10-15T10:00:00.000Z";

function header(timestamp = HEADER_AT): string {
  return JSON.stringify({ type: "session", version: 3, id: "s", timestamp, cwd: "/tmp" });
}

function at(offsetSeconds: number): string {
  return new Date(Date.parse(HEADER_AT) + offsetSeconds * 1000).toISOString();
}

function usage(cost: number, totalTokens = 100): Record<string, unknown> {
  return {
    input: totalTokens - 10,
    output: 10,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    reasoningTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function assistant(cost: number, seconds = 1, totalTokens = 100): string {
  return JSON.stringify({
    type: "message",
    id: `a${seconds}`,
    timestamp: at(seconds),
    message: { role: "assistant", content: [], usage: usage(cost, totalTokens) },
  });
}

function journal(...lines: string[]): string {
  return lines.map((line) => `${line}\n`).join("");
}

/** A root journal path plus its artifacts dir (omp's rule: the path minus `.jsonl`). */
function sessionPaths(dir = tempDir(), name = "root"): { root: string; artifacts: string } {
  return { root: path.join(dir, `${name}.jsonl`), artifacts: path.join(dir, name) };
}

function writeFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

async function armed(root: string): Promise<SpendHarness> {
  const harness = executableExtension();
  harness.setSessionFile(root);
  await harness.bindRoot();
  await harness.arm();
  return harness;
}

describe("writeSessionSpendExtension", () => {
  it("writes into the lineage dir, interpolates the wire constants, and type-checks", () => {
    const dir = tempDir();
    const file = writeSessionSpendExtension(dir);
    expect(file).toBe(sessionSpendExtensionPath(dir));
    const source = fs.readFileSync(file, "utf8");
    expect(source).toContain(`"${SESSION_SPEND_STATUS_KEY}"`);
    expect(source).toContain(`const POLL_MS = ${SESSION_SPEND_POLL_MS};`);
    typecheckGeneratedExtension(file);
  });
});

describe("session-spend bridge", () => {
  it("keeps spend from before a compaction", async () => {
    const { root } = sessionPaths();
    writeFile(
      root,
      journal(
        header(),
        assistant(0.1, 1),
        assistant(0.2, 2),
        assistant(0.3, 3),
        JSON.stringify({ type: "compaction", id: "c", timestamp: at(4), summary: "s", firstKeptEntryId: "a3" }),
        assistant(0.4, 5),
      ),
    );
    const harness = await armed(root);
    const snapshot = harness.latest();
    expect(snapshot.available).toBe(true);
    expect(snapshot.sessionFile).toBe(root);
    expect(snapshot.total.cost).toBeCloseTo(1.0);
    expect(snapshot.total.totalTokens).toBe(400);
    expect(snapshot.total.reasoning).toBe(12);
    expect(snapshot.total.requests).toBe(4);
  });

  it("counts a sync task once, from its transcript, not from the root's task result", async () => {
    const { root, artifacts } = sessionPaths();
    writeFile(
      root,
      journal(
        header(),
        assistant(1, 1),
        JSON.stringify({
          type: "message",
          id: "t",
          timestamp: at(2),
          message: { role: "toolResult", toolName: "task", content: [], details: { usage: usage(5) } },
        }),
      ),
    );
    writeFile(path.join(artifacts, "A.jsonl"), journal(header(), assistant(5, 1)));
    const snapshot = (await armed(root)).latest();
    expect(snapshot.main.cost).toBeCloseTo(1);
    expect(snapshot.subagents.cost).toBeCloseTo(5);
    expect(snapshot.total.cost).toBeCloseTo(6);
    expect(snapshot.transcripts).toBe(1);
  });

  it("counts nested subagents and model_usage entries", async () => {
    const { root, artifacts } = sessionPaths();
    writeFile(
      root,
      journal(
        header(),
        assistant(1, 1),
        JSON.stringify({ type: "model_usage", id: "m", parentId: null, timestamp: at(2), usage: usage(0.5) }),
      ),
    );
    writeFile(path.join(artifacts, "A.jsonl"), journal(header(), assistant(2, 1)));
    writeFile(path.join(artifacts, "A", "B.jsonl"), journal(header(), assistant(3, 1)));
    const snapshot = (await armed(root)).latest();
    expect(snapshot.main.cost).toBeCloseTo(1.5);
    expect(snapshot.main.requests).toBe(2);
    expect(snapshot.subagents.cost).toBeCloseTo(5);
    expect(snapshot.transcripts).toBe(2);
  });

  it("excludes advisor transcripts and ignores non-transcript files", async () => {
    const { root, artifacts } = sessionPaths();
    writeFile(root, journal(header(), assistant(1, 1)));
    writeFile(path.join(artifacts, "__advisor.jsonl"), journal(header(), assistant(7, 1)));
    writeFile(path.join(artifacts, "__advisor.reviewer.jsonl"), journal(header(), assistant(9, 1)));
    writeFile(path.join(artifacts, "1.bash.log"), assistant(11, 1));
    // Foreign JSONL past the header window: never a transcript.
    writeFile(path.join(artifacts, "foreign.jsonl"), journal(...Array.from({ length: 60 }, () => assistant(13, 1))));
    const snapshot = (await armed(root)).latest();
    expect(snapshot.total.cost).toBeCloseTo(1);
    expect(snapshot.subagents.cost).toBe(0);
    expect(snapshot.transcripts).toBe(0);
  });

  it("skips fork-copied entries that predate the file's header", async () => {
    const { root, artifacts } = sessionPaths();
    writeFile(root, journal(header(), assistant(1, 1)));
    // The fork header is 10s after HEADER_AT; its first two entries were copied from the parent.
    writeFile(
      path.join(artifacts, "Tan-1.jsonl"),
      journal(header(at(10)), assistant(1, 1), assistant(2, 2), assistant(4, 11), assistant(8, 12)),
    );
    const snapshot = (await armed(root)).latest();
    expect(snapshot.subagents.cost).toBeCloseTo(12);
    expect(snapshot.subagents.requests).toBe(2);
  });

  it("counts a line split across polls exactly once, publishing only when it completes", async () => {
    vi.useFakeTimers();
    const { root } = sessionPaths();
    writeFile(root, journal(header(), assistant(1, 1)));
    const harness = await armed(root);
    const revision = harness.latest().revision;
    const line = assistant(2, 2);
    fs.appendFileSync(root, line.slice(0, 40));
    await vi.advanceTimersByTimeAsync(SESSION_SPEND_POLL_MS);
    expect(harness.latest().revision).toBe(revision);
    fs.appendFileSync(root, `${line.slice(40)}\n`);
    await vi.advanceTimersByTimeAsync(SESSION_SPEND_POLL_MS * 5);
    expect(harness.latest().revision).toBe(revision + 1);
    expect(harness.latest().total.cost).toBeCloseTo(3);
    expect(harness.latest().total.requests).toBe(2);
  });

  it("rescans a subagent transcript that was rewritten shorter", async () => {
    vi.useFakeTimers();
    const { root, artifacts } = sessionPaths();
    const sub = path.join(artifacts, "A.jsonl");
    writeFile(root, journal(header()));
    writeFile(sub, journal(header(), assistant(1, 1), assistant(2, 2), assistant(4, 3)));
    const harness = await armed(root);
    expect(harness.latest().subagents.cost).toBeCloseTo(7);
    const replacement = `${sub}.tmp`;
    fs.writeFileSync(replacement, journal(header(), assistant(0.5, 1)));
    fs.renameSync(replacement, sub);
    await vi.advanceTimersByTimeAsync(SESSION_SPEND_POLL_MS);
    expect(harness.latest().subagents.cost).toBeCloseTo(0.5);
  });

  it("starts a new total when the root session file changes", async () => {
    vi.useFakeTimers();
    const dir = tempDir();
    const first = sessionPaths(dir, "first");
    const second = sessionPaths(dir, "second");
    writeFile(first.root, journal(header(), assistant(1, 1)));
    writeFile(path.join(first.artifacts, "A.jsonl"), journal(header(), assistant(2, 1)));
    writeFile(second.root, journal(header(), assistant(0.25, 1)));
    const harness = await armed(first.root);
    expect(harness.latest().total.cost).toBeCloseTo(3);
    harness.setSessionFile(second.root);
    await vi.advanceTimersByTimeAsync(SESSION_SPEND_POLL_MS);
    expect(harness.latest().sessionFile).toBe(second.root);
    expect(harness.latest().total.cost).toBeCloseTo(0.25);
    expect(harness.latest().transcripts).toBe(0);
  });

  it("publishes zero totals for a persisted session whose file does not exist yet", async () => {
    const { root } = sessionPaths();
    const snapshot = (await armed(root)).latest();
    expect(snapshot.available).toBe(true);
    expect(snapshot.total.cost).toBe(0);
  });

  it("reports an unpersisted session as unavailable", async () => {
    const harness = executableExtension();
    harness.setSessionFile(undefined);
    await harness.bindRoot();
    await harness.arm();
    expect(harness.latest()).toMatchObject({
      available: false,
      unavailable: "this session is not persisted",
      sessionFile: null,
    });
  });

  it("reports no root before the first prompt", async () => {
    const harness = executableExtension();
    await harness.arm();
    expect(harness.latest().unavailable).toBe("no omp session has prompted yet");
  });
});
