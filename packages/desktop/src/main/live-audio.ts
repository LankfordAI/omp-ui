// Live voice recordings on disk (#809, ADR-0049). The reference scheme lives
// in core (`formatLiveAudioRef` / `parseLiveAudioRef`); this module is the
// confined list/read half: everything stays under
// `<lineageDir>/live-audio/<connectionId>/<role>-<turn>.wav`, judged through
// realpath containment exactly like `readConfinedPlanFile` (plan-file.ts) —
// a crafted reference can never turn these channels into an arbitrary file
// reader. No writer ships here yet: omp ≤ 18.8.6 never exposes assistant
// output audio (the controller drops `output_audio.delta`), so there is
// nothing to write from; when a future omp does, its writer lands against
// this unchanged layout via atomic-write (`.partial` → rename).
//
// Every failure path returns an honest state, never a throw: disk enumeration
// is the post-reopen truth source, and a load never substitutes anything.
import * as fs from "node:fs";
import * as path from "node:path";
import { CH, isWithin, type Registry, type RequestHandlers } from "@omp-ui/core";
import {
  parseLiveAudioRef,
  type LiveAudioEntry,
  type LiveAudioLoad,
  type LiveRole,
} from "@omp-ui/core/live-voice";

/** Dir inside the session's lineage dir holding its recordings (ADR-0003:
 * the session's delete/archive already moves the whole lineage dir). */
export const LIVE_AUDIO_DIR = "live-audio";
/** Guard for the relay/base64 path, not the author — well above any real
 * realtime turn while staying under the JSON transport's ceiling. */
export const LIVE_AUDIO_MAX_BYTES = 32 * 1024 * 1024;
/** atomic-write.ts's temp sibling; a dangling one is an `incomplete` recording. */
const PARTIAL_SUFFIX = ".partial";

const WAV_SUFFIX = ".wav";

interface ParsedName {
  role: LiveRole;
  turn: number;
}

/** `<role>-<turn>` once the extension is stripped; anything else is not a recording. */
function parseRecordingName(basename: string): ParsedName | null {
  const match = /^(user|assistant)-(\d+)$/.exec(basename);
  if (!match) return null;
  const turn = Number(match[2]);
  if (!Number.isSafeInteger(turn)) return null;
  return { role: match[1] as ParsedName["role"], turn };
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(target);
  } catch {
    return null;
  }
}

/**
 * Enumerate one session's recordings, newest first. A missing dir is an
 * empty list, not an error — sessions never had audio until one exists.
 * Malformed names are skipped; a dangling `.partial` (writer crashed
 * mid-rename) is reported with the partial file's size so the UI can say
 * `incomplete` without a second stat round trip.
 */
export async function listLiveAudio(absLineageDir: string): Promise<LiveAudioEntry[]> {
  const root = path.join(absLineageDir, LIVE_AUDIO_DIR);
  const entries: LiveAudioEntry[] = [];
  let connections: string[];
  try {
    connections = (await fs.promises.readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  for (const connectionId of connections) {
    let names: string[];
    try {
      names = await fs.promises.readdir(path.join(root, connectionId));
    } catch {
      continue;
    }
    // A .partial whose .wav sibling exists is the writer mid-rename — the
    // completed file wins, so the turn is reported once.
    const seen = new Set(names);
    for (const name of names) {
      const isPartial = name.endsWith(PARTIAL_SUFFIX);
      const stem = name.endsWith(WAV_SUFFIX) || isPartial
        ? name.slice(0, name.lastIndexOf("."))
        : null;
      if (stem === null) continue;
      if (isPartial && seen.has(`${stem}${WAV_SUFFIX}`)) continue;
      const wav = parseRecordingName(stem);
      if (wav === null) continue;
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(path.join(root, connectionId, name));
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      entries.push({
        connectionId,
        role: wav.role,
        turn: wav.turn,
        sizeBytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    }
  }
  entries.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  return entries;
}

/**
 * Load one recording by voice recording reference. The reference is parsed
 * strictly FIRST — a malformed string never touches the filesystem. The
 * resolved path must sit inside `<lineageDir>/live-audio` after realpath, so
 * neither a symlink nor a crafted segment escapes; over-cap and non-regular
 * files are `unavailable`. A `.wav` that is absent while its `.partial`
 * sibling exists is `incomplete`: a half recording, honestly labeled.
 */
export async function readLiveAudio(absLineageDir: string, ref: string): Promise<LiveAudioLoad> {
  const parsed = parseLiveAudioRef(ref);
  if (parsed === null) return { status: "unavailable" };
  const rootReal = await realpathOrNull(absLineageDir);
  if (rootReal === null) return { status: "unavailable" };
  const audioRoot = path.join(rootReal, LIVE_AUDIO_DIR);
  const wavPath = path.join(
    audioRoot,
    parsed.connectionId,
    `${parsed.role}-${parsed.turn}${WAV_SUFFIX}`,
  );
  const wavReal = await realpathOrNull(wavPath);
  if (wavReal !== null) {
    if (!isWithin(audioRoot, wavReal)) return { status: "unavailable" };
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(wavReal);
    } catch {
      return { status: "unavailable" };
    }
    if (!stat.isFile() || stat.size > LIVE_AUDIO_MAX_BYTES) return { status: "unavailable" };
    try {
      const buffer = await fs.promises.readFile(wavReal);
      if (buffer.length > LIVE_AUDIO_MAX_BYTES) return { status: "unavailable" };
      return { status: "ready", wavBase64: buffer.toString("base64"), sizeBytes: buffer.length };
    } catch {
      return { status: "unavailable" };
    }
  }
  // No .wav: a dangling .partial says a writer left a half recording.
  const partialReal = await realpathOrNull(wavPath.replace(/\.wav$/, PARTIAL_SUFFIX));
  if (partialReal !== null && isWithin(audioRoot, partialReal)) return { status: "incomplete" };
  return { status: "unavailable" };
}

type LiveAudioHandlerChannels = typeof CH.listLiveAudio | typeof CH.readLiveAudio;

export interface LiveAudioHandlerDependencies {
  registry: Registry;
  getSessionsRoot: () => string;
}

/**
 * The two #809 channels. Tab → record resolution mirrors the `plan:read`
 * dep: the lineage dir is `sessionsRoot` joined with the record's
 * `lineageDir`. An unknown tab lists nothing and reads `unavailable` — the
 * honest empty, never a throw across the channel boundary.
 */
export function registerLiveAudioHandlers(
  deps: LiveAudioHandlerDependencies,
): Pick<RequestHandlers, LiveAudioHandlerChannels> {
  const lineageDirFor = (tabId: string): string | null => {
    const record = deps.registry.sessions.find((s) => s.tabId === tabId);
    return record ? path.join(deps.getSessionsRoot(), record.lineageDir) : null;
  };
  return {
    [CH.listLiveAudio]: async (tabId: string) => {
      const dir = lineageDirFor(tabId);
      return dir === null ? [] : listLiveAudio(dir);
    },
    [CH.readLiveAudio]: async (tabId: string, ref: string) => {
      const dir = lineageDirFor(tabId);
      return dir === null ? { status: "unavailable" as const } : readLiveAudio(dir, ref);
    },
  };
}
