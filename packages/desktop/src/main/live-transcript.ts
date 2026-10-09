// Live transcript history on disk (#817, ADR-0052). omp exposes no spoken
// text after a call ends (ADR-0049 finding 1), so the renderer appends every
// FINAL `live_transcript` frame as it arrives; this module is the confined
// write/read half: everything stays under
// `<lineageDir>/live-transcript/<connectionId>.jsonl` — one append-only
// JSON-lines file per connection, identity from the renderer-minted
// connectionId exactly like #809's audio refs — judged through realpath
// containment exactly like `live-audio.ts`: a crafted id can never turn these
// channels into an arbitrary file reader/writer.
//
// Every failure path skips or answers empty, never a throw: disk enumeration
// is the post-reopen truth source, and a strip render never depends on disk
// being kind. Turn numbers restart at 0 each connection (ADR-0049 decision
// 2), so one file per connection makes `(connectionId, role, turn)` the
// row key without collisions; a second renderer client appending the same
// frame dedupes to the last occurrence at read time.
import * as fs from "node:fs";
import * as path from "node:path";
import { CH, isWithin, type Registry, type RequestHandlers } from "@omp-ui/core";
import {
  isLiveConnectionId,
  LIVE_HISTORY_FILE_MAX_BYTES,
  parseLiveHistoryLine,
  type LiveHistoryEntry,
  type LiveHistoryTurn,
} from "@omp-ui/core/live-voice";

/** Dir inside the session's lineage dir holding its spoken turns (ADR-0003:
 * the session's delete/archive already moves the whole lineage dir). */
export const LIVE_TRANSCRIPT_DIR = "live-transcript";

const JSONL_SUFFIX = ".jsonl";

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(target);
  } catch {
    return null;
  }
}

/**
 * Append one final turn to its connection's file. The connection id is
 * judged by the same UUID grammar `parseLiveAudioRef` admits and the entry
 * is validated by round-tripping it through the line parser — so the exact
 * bytes written are bytes the reader is guaranteed to accept. An invalid id
 * or an over-cap/garbage entry is dropped with a warning, never written; a
 * disk failure is the same honest drop (the snapshot already rendered the
 * text — disk is the durable copy, not the render source).
 */
export async function appendLiveTranscript(
  absLineageDir: string,
  connectionId: string,
  entry: LiveHistoryTurn,
): Promise<void> {
  if (!isLiveConnectionId(connectionId)) {
    console.warn("live-transcript: dropping entry with a non-UUID connection id");
    return;
  }
  const line = JSON.stringify(entry);
  if (parseLiveHistoryLine(line) === null) {
    console.warn("live-transcript: dropping an entry the line parser rejects");
    return;
  }
  const root = path.join(absLineageDir, LIVE_TRANSCRIPT_DIR);
  const file = path.join(root, `${connectionId}${JSONL_SUFFIX}`);
  if (!isWithin(root, file)) return;
  try {
    await fs.promises.mkdir(root, { recursive: true });
    await fs.promises.appendFile(file, `${line}\n`);
  } catch {
    console.warn(`live-transcript: could not append to ${file}`);
  }
}

/** Read one connection file's entries: at most the cap's first bytes,
 *  tail-trimmed to the last newline boundary inside the window, parsed
 *  line-by-line tolerantly, deduped by (role, turn) — last occurrence wins
 *  (two clients appending the same frame). */
async function readConnectionFile(
  file: string,
  sizeBytes: number,
  connectionId: string,
): Promise<LiveHistoryEntry[]> {
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(file, "r");
  } catch {
    return [];
  }
  try {
    const window = Math.min(sizeBytes, LIVE_HISTORY_FILE_MAX_BYTES);
    if (window === 0) return [];
    const buffer = Buffer.alloc(window);
    await handle.read(buffer, 0, window, 0);
    const lastNewline = buffer.lastIndexOf(0x0a);
    const text = buffer.subarray(0, lastNewline < 0 ? 0 : lastNewline).toString("utf8");
    const byKey = new Map<string, LiveHistoryEntry>();
    for (const line of text.split("\n")) {
      if (line === "") continue;
      const parsed = parseLiveHistoryLine(line);
      if (parsed === null) continue;
      byKey.set(`${parsed.role}\u0000${parsed.turn}`, { connectionId, ...parsed });
    }
    return [...byKey.values()];
  } catch {
    return [];
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * The session's persisted spoken turns, oldest connection first (file mtime
 * ascending; file order inside a connection). A missing dir is an empty list,
 * not an error — sessions never had history until one speaks. Files the
 * reader cannot open, escape the dir after realpath, or whose names are not
 * `<uuid>.jsonl` are skipped.
 */
export async function readLiveTranscript(absLineageDir: string): Promise<LiveHistoryEntry[]> {
  const root = path.join(absLineageDir, LIVE_TRANSCRIPT_DIR);
  const rootReal = await realpathOrNull(root);
  if (rootReal === null) return [];
  let names: string[];
  try {
    names = await fs.promises.readdir(rootReal);
  } catch {
    return [];
  }
  const files: { connectionId: string; file: string; sizeBytes: number; mtimeMs: number }[] = [];
  for (const name of names) {
    if (!name.endsWith(JSONL_SUFFIX)) continue;
    const connectionId = name.slice(0, -JSONL_SUFFIX.length);
    if (!isLiveConnectionId(connectionId)) continue;
    const file = path.join(rootReal, name);
    const fileReal = await realpathOrNull(file);
    if (fileReal === null || !isWithin(rootReal, fileReal)) continue;
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(fileReal);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    files.push({ connectionId, file: fileReal, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
  }
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
  const entries: LiveHistoryEntry[] = [];
  for (const file of files) {
    entries.push(...(await readConnectionFile(file.file, file.sizeBytes, file.connectionId)));
  }
  return entries;
}

type LiveTranscriptHandlerChannels =
  | typeof CH.liveTranscriptAppend
  | typeof CH.liveTranscriptRead;

export interface LiveTranscriptHandlerDependencies {
  registry: Registry;
  getSessionsRoot: () => string;
}

/**
 * The two #817 channels. Tab → record resolution mirrors
 * `registerLiveAudioHandlers`: the lineage dir is `sessionsRoot` joined with
 * the record's `lineageDir`. An unknown tab appends nothing and reads [] —
 * the honest empty, never a throw across the channel boundary.
 */
export function registerLiveTranscriptHandlers(
  deps: LiveTranscriptHandlerDependencies,
): Pick<RequestHandlers, LiveTranscriptHandlerChannels> {
  const lineageDirFor = (tabId: string): string | null => {
    const record = deps.registry.sessions.find((s) => s.tabId === tabId);
    return record ? path.join(deps.getSessionsRoot(), record.lineageDir) : null;
  };
  return {
    [CH.liveTranscriptAppend]: async (tabId: string, connectionId: string, entry: LiveHistoryTurn) => {
      const dir = lineageDirFor(tabId);
      if (dir !== null) await appendLiveTranscript(dir, connectionId, entry);
    },
    [CH.liveTranscriptRead]: async (tabId: string) => {
      const dir = lineageDirFor(tabId);
      return dir === null ? [] : readLiveTranscript(dir);
    },
  };
}
