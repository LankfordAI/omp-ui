import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { CH } from "@omp-ui/core";
import { LIVE_HISTORY_FILE_MAX_BYTES } from "@omp-ui/core/live-voice";
import {
  appendLiveTranscript,
  readLiveTranscript,
  registerLiveTranscriptHandlers,
} from "./live-transcript";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-live-transcript-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const fileFor = (lineageDir: string, connectionId: string): string =>
  path.join(lineageDir, "live-transcript", `${connectionId}.jsonl`);

/** Seeds a connection file directly (bypasses the writer's caps). */
function seed(lineageDir: string, connectionId: string, lines: readonly string[]): string {
  const file = fileFor(lineageDir, connectionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

describe("appendLiveTranscript (#817)", () => {
  it("round-trips one final turn through disk", async () => {
    const dir = tmp();
    const conn = randomUUID();
    await appendLiveTranscript(dir, conn, { role: "assistant", turn: 2, text: "hello" });
    const file = fileFor(dir, conn);
    expect(fs.readFileSync(file, "utf8")).toBe('{"role":"assistant","turn":2,"text":"hello"}\n');
    expect(await readLiveTranscript(dir)).toEqual([
      { connectionId: conn, role: "assistant", turn: 2, text: "hello" },
    ]);
  });

  it("appends in order — one line per final frame", async () => {
    const dir = tmp();
    const conn = randomUUID();
    await appendLiveTranscript(dir, conn, { role: "user", turn: 0, text: "hi" });
    await appendLiveTranscript(dir, conn, { role: "assistant", turn: 0, text: "hey" });
    expect(await readLiveTranscript(dir)).toEqual([
      { connectionId: conn, role: "user", turn: 0, text: "hi" },
      { connectionId: conn, role: "assistant", turn: 0, text: "hey" },
    ]);
  });

  it("drops an entry with a non-UUID connection id without writing", async () => {
    const dir = tmp();
    await appendLiveTranscript(dir, "../../outside", { role: "user", turn: 0, text: "x" });
    expect(fs.existsSync(path.join(dir, "live-transcript"))).toBe(false);
    expect(await readLiveTranscript(dir)).toEqual([]);
  });

  it("drops an over-cap entry without writing it", async () => {
    const dir = tmp();
    const conn = randomUUID();
    await appendLiveTranscript(dir, conn, { role: "user", turn: 0, text: "x".repeat(65_537) });
    expect(fs.existsSync(fileFor(dir, conn))).toBe(false);
  });
});

describe("readLiveTranscript (#817)", () => {
  it("is an empty list — not an error — with no live-transcript dir", async () => {
    expect(await readLiveTranscript(tmp())).toEqual([]);
  });

  it("sorts connections by file mtime ascending", async () => {
    const dir = tmp();
    const a = randomUUID();
    const b = randomUUID();
    seed(dir, b, ['{"role":"user","turn":0,"text":"second"}']);
    const aFile = seed(dir, a, ['{"role":"user","turn":0,"text":"first"}']);
    fs.utimesSync(aFile, new Date(1000), new Date(1000));
    fs.utimesSync(fileFor(dir, b), new Date(2000), new Date(2000));
    expect((await readLiveTranscript(dir)).map((e) => e.text)).toEqual(["first", "second"]);
  });

  it("collides (connectionId, role, turn) duplicates to the last occurrence", async () => {
    const dir = tmp();
    const conn = randomUUID();
    // Same key twice (a corrected re-send, or two clients appending): the
    // last occurrence wins and the row surfaces once.
    seed(dir, conn, [
      '{"role":"assistant","turn":1,"text":"first wording"}',
      '{"role":"assistant","turn":1,"text":"final wording"}',
    ]);
    expect(await readLiveTranscript(dir)).toEqual([
      { connectionId: conn, role: "assistant", turn: 1, text: "final wording" },
    ]);
  });

  it("skips malformed lines and junk file names", async () => {
    const dir = tmp();
    const conn = randomUUID();
    seed(dir, conn, [
      "not json at all",
      '{"role":"intruder","turn":0,"text":"x"}',
      '{"role":"user","turn":1.5,"text":"x"}',
      '{"role":"user","turn":-1,"text":"x"}',
      '"a bare string"',
      '{"role":"user","turn":3,"text":"kept"}',
    ]);
    fs.writeFileSync(path.join(dir, "live-transcript", "notes.txt"), "junk");
    fs.writeFileSync(path.join(dir, "live-transcript", "not-a-uuid.jsonl"), "junk");
    expect(await readLiveTranscript(dir)).toEqual([
      { connectionId: conn, role: "user", turn: 3, text: "kept" },
    ]);
  });

  it("reads a torn last line as absent and keeps the head", async () => {
    const dir = tmp();
    const conn = randomUUID();
    const file = fileFor(dir, conn);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"role":"user","turn":0,"text":"ok"}\n{"role":"user","tu');
    expect(await readLiveTranscript(dir)).toEqual([
      { connectionId: conn, role: "user", turn: 0, text: "ok" },
    ]);
  });

  it("tail-trims an over-cap file to its first cap window", async () => {
    const dir = tmp();
    const conn = randomUUID();
    const file = fileFor(dir, conn);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const head = '{"role":"user","turn":0,"text":"head"}\n';
    const tail = '{"role":"user","turn":1,"text":"tail"}\n';
    fs.writeFileSync(
      file,
      Buffer.concat([
        Buffer.from(head),
        Buffer.alloc(LIVE_HISTORY_FILE_MAX_BYTES - head.length - 1, 0x20),
        Buffer.from("\n"),
        Buffer.from(tail),
      ]),
    );
    expect(await readLiveTranscript(dir)).toEqual([
      { connectionId: conn, role: "user", turn: 0, text: "head" },
    ]);
  });

  it("refuses a symlink that escapes the live-transcript dir", async () => {
    const dir = tmp();
    const conn = randomUUID();
    const outside = path.join(dir, "outside.jsonl");
    fs.writeFileSync(outside, '{"role":"user","turn":0,"text":"secret"}\n');
    fs.mkdirSync(path.join(dir, "live-transcript"), { recursive: true });
    fs.symlinkSync(outside, fileFor(dir, conn));
    expect(await readLiveTranscript(dir)).toEqual([]);
  });
});

describe("registerLiveTranscriptHandlers (#817)", () => {
  const handlers = (sessionsRoot: string, tabId: string) =>
    registerLiveTranscriptHandlers({
      registry: { sessions: [{ tabId, lineageDir: "lineage-1" }] } as never,
      getSessionsRoot: () => sessionsRoot,
    });

  it("resolves tab → lineage dir for both channels", async () => {
    const dir = tmp();
    const conn = randomUUID();
    const h = handlers(dir, "tab-1");
    await h[CH.liveTranscriptAppend]("tab-1", conn, { role: "user", turn: 0, text: "hi" });
    expect(fs.existsSync(fileFor(path.join(dir, "lineage-1"), conn))).toBe(true);
    expect(await h[CH.liveTranscriptRead]("tab-1")).toEqual([
      { connectionId: conn, role: "user", turn: 0, text: "hi" },
    ]);
  });

  it("answers the honest empty for an unknown tab", async () => {
    const h = handlers(tmp(), "tab-1");
    expect(await h[CH.liveTranscriptRead]("nope")).toEqual([]);
    // An unknown tab appends nothing, and never throws.
    await expect(
      h[CH.liveTranscriptAppend]("nope", randomUUID(), { role: "user", turn: 0, text: "x" }),
    ).resolves.toBeUndefined();
  });
});
