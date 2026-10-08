import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { formatLiveAudioRef } from "@omp-ui/core/live-voice";
import { CH } from "@omp-ui/core";
import {
  LIVE_AUDIO_MAX_BYTES,
  listLiveAudio,
  readLiveAudio,
  registerLiveAudioHandlers,
} from "./live-audio";

const tmpDirs: string[] = [];
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-live-audio-"));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const SESSION = randomUUID();

/** Builds a lineage dir with `live-audio/<connectionId>/<role>-<turn>.wav`. */
function place(
  lineageDir: string,
  connectionId: string,
  role: "user" | "assistant",
  turn: number,
  bytes: Buffer | string = "RIFF....WAVDATA",
  suffix = ".wav",
): string {
  const file = path.join(lineageDir, "live-audio", connectionId, `${role}-${turn}${suffix}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
  return file;
}

const ref = (connectionId: string, role: "user" | "assistant", turn: number): string =>
  formatLiveAudioRef({ sessionId: SESSION, connectionId, role, turn });

describe("readLiveAudio (#809)", () => {
  it("returns ready with the exact bytes for a well-formed ref", async () => {
    const dir = tmp();
    const conn = randomUUID();
    const bytes = Buffer.from("RIFFfake-wav-bytes", "utf8");
    place(dir, conn, "assistant", 2, bytes);
    const load = await readLiveAudio(dir, ref(conn, "assistant", 2));
    expect(load.status).toBe("ready");
    expect(Buffer.from(load.wavBase64 ?? "", "base64").equals(bytes)).toBe(true);
    expect(load.sizeBytes).toBe(bytes.length);
  });

  it("is unavailable for a missing file, a malformed ref, or an unknown lineage dir", async () => {
    const dir = tmp();
    expect((await readLiveAudio(dir, ref(randomUUID(), "assistant", 0))).status).toBe(
      "unavailable",
    );
    expect((await readLiveAudio(dir, "v1/nope/nope/assistant/0")).status).toBe("unavailable");
    expect((await readLiveAudio(dir, `v1/${SESSION}/${randomUUID()}/assistant/-2`)).status).toBe(
      "unavailable",
    );
    expect((await readLiveAudio(path.join(dir, "gone"), ref(randomUUID(), "user", 1))).status).toBe(
      "unavailable",
    );
  });

  it("refuses a symlink that escapes the live-audio tree", async () => {
    const dir = tmp();
    const conn = randomUUID();
    const outside = path.join(dir, "outside.wav");
    fs.writeFileSync(outside, "secret");
    const link = path.join(dir, "live-audio", conn, "assistant-0.wav");
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(outside, link);
    expect((await readLiveAudio(dir, ref(conn, "assistant", 0))).status).toBe("unavailable");
  });

  it("is unavailable past the byte cap", async () => {
    const dir = tmp();
    const conn = randomUUID();
    const file = place(dir, conn, "assistant", 1, "");
    fs.truncateSync(file, LIVE_AUDIO_MAX_BYTES + 1);
    expect((await readLiveAudio(dir, ref(conn, "assistant", 1))).status).toBe("unavailable");
  });

  it("reports incomplete when only the .partial sibling exists", async () => {
    const dir = tmp();
    const conn = randomUUID();
    place(dir, conn, "assistant", 3, "half-written", ".partial");
    expect((await readLiveAudio(dir, ref(conn, "assistant", 3))).status).toBe("incomplete");
  });
});

describe("listLiveAudio (#809)", () => {
  it("is an empty list — not an error — with no live-audio dir", async () => {
    expect(await listLiveAudio(tmp())).toEqual([]);
  });

  it("enumerates recordings newest first and skips junk names", async () => {
    const dir = tmp();
    const a = randomUUID();
    const b = randomUUID();
    place(dir, a, "user", 0);
    const newest = place(dir, b, "assistant", 1);
    const partial = place(dir, a, "assistant", 2, "", ".partial");
    // Deterministic mtimes: newest-first needs no wall-clock luck.
    fs.utimesSync(path.join(dir, "live-audio", a, "user-0.wav"), new Date(1000), new Date(1000));
    fs.utimesSync(partial, new Date(2000), new Date(2000));
    fs.utimesSync(newest, new Date(3000), new Date(3000));
    // Junk that must never surface as a recording:
    place(dir, a, "assistant", 3, "", ".txt");
    fs.mkdirSync(path.join(dir, "live-audio", b, "nested"), { recursive: true });

    const entries = await listLiveAudio(dir);
    expect(entries.map((e) => [e.connectionId, e.role, e.turn])).toEqual([
      [b, "assistant", 1],
      [a, "assistant", 2],
      [a, "user", 0],
    ]);
    expect(entries.every((e) => typeof e.sizeBytes === "number" && !Number.isNaN(Date.parse(e.modifiedAt)))).toBe(true);
  });
});

describe("registerLiveAudioHandlers (#809)", () => {
  const handlers = (sessionsRoot: string, tabId: string) =>
    registerLiveAudioHandlers({
      registry: { sessions: [{ tabId, lineageDir: "lineage-1" }] } as never,
      getSessionsRoot: () => sessionsRoot,
    });

  it("resolves tab → lineage dir for both channels", async () => {
    const dir = tmp();
    const conn = randomUUID();
    place(path.join(dir, "lineage-1"), conn, "assistant", 0);
    const h = handlers(dir, "tab-1");
    expect(await h[CH.listLiveAudio]("tab-1")).toHaveLength(1);
    expect((await h[CH.readLiveAudio]("tab-1", ref(conn, "assistant", 0))).status).toBe("ready");
  });

  it("answers the honest empty for an unknown tab", async () => {
    const h = handlers(tmp(), "tab-1");
    expect(await h[CH.listLiveAudio]("nope")).toEqual([]);
    expect((await h[CH.readLiveAudio]("nope", "anything")).status).toBe("unavailable");
  });
});
