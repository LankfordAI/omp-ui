// The omp `/collab` local-registry contract (issue #686). omp owns the relay,
// the room keys, and the hosting lifecycle; omp-ui only READS the local
// registry CLI (`omp collab list|link --json`) and WRITES the slash lines that
// start and stop hosting into a terminal tab's PTY. Nothing here speaks the
// relay protocol, and the room key never exists in omp-ui except as an opaque
// fragment of a link URL.
//
// Pure module: the renderer imports the wire types directly (ADR-0002); the
// subprocess half lives in collab-cli.ts, which main binds to the resolved
// omp binary at call time.
import { isObject } from "./guards";

/** The two access levels omp's `/collab` hosts a room with. */
export type CollabAccess = "full" | "view";

/**
 * One live host row from `omp collab list --json` (omp 18.4.3, live-probed):
 * `instanceId`/`pid`/`generation` identify the host, `generation` rotates when
 * the hosted session changes (`/new`, `/resume`, branch switches), and the row
 * disappears when the host process exits. Fields the CLI may omit degrade to
 * safe defaults; rows missing an identity are dropped (see parse).
 */
export interface CollabHostRow {
  instanceId: string;
  /** The host process pid — the key omp-ui matches rows against its own PTY children. */
  pid: number;
  generation: number;
  sessionId: string;
  sessionName: string;
  cwd: string;
  model: string;
  /** ISO timestamp omp wrote at host start; degraded to "" when absent. */
  startedAt: string;
  participants: number;
  access: CollabAccess;
  relayConnected: boolean;
  /** True while a guest is waiting on a dialog in the host's TUI. */
  inputRequired: boolean;
  busy: boolean;
}

/** One `omp collab link` outcome: a URL, or omp's own refusal. */
export type CollabLinkResult = { ok: true; url: string } | { ok: false; message: string };

/**
 * Per-tab collab state broadcast to the renderer (issue #686). A tab with no
 * live host — off, closed, or an rpc-ui tab where omp exposes no collab
 * surface — is `null`, so "never hosted" and "stopped" render the same.
 */
export interface CollabTabState {
  status: CollabAccess;
  generation: number;
  participants: number;
  relayConnected: boolean;
  inputRequired: boolean;
}

/** The `collabList` request / `collabChanged` event row, keyed by tab. */
export interface CollabTabSnapshot {
  tabId: string;
  state: CollabTabState | null;
}

/**
 * Parses a decoded `collab list --json` document. Tolerant by contract: a
 * shape mismatch is `null` (transient — keep the last known state), never a
 * throw and never a half-read host list. Rows without an identity are dropped;
 * optional fields degrade to defaults.
 */
export function parseCollabListing(value: unknown): CollabHostRow[] | null {
  if (!isObject(value) || !Array.isArray(value.hosts)) return null;
  const rows: CollabHostRow[] = [];
  for (const item of value.hosts) {
    const row = parseCollabRow(item);
    if (row !== null) rows.push(row);
  }
  return rows;
}

function parseCollabRow(value: unknown): CollabHostRow | null {
  if (!isObject(value)) return null;
  const instanceId = value.instanceId;
  const pid = value.pid;
  const generation = value.generation;
  if (typeof instanceId !== "string" || instanceId.length === 0) return null;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof generation !== "number" || !Number.isInteger(generation)) return null;
  return {
    instanceId,
    pid,
    generation,
    sessionId: typeof value.sessionId === "string" ? value.sessionId : "",
    sessionName: typeof value.sessionName === "string" ? value.sessionName : "",
    cwd: typeof value.cwd === "string" ? value.cwd : "",
    model: typeof value.model === "string" ? value.model : "",
    startedAt:
      typeof value.startedAt === "string"
        ? value.startedAt
        : typeof value.startedAt === "number"
          ? String(value.startedAt)
          : "",
    participants:
      typeof value.participants === "number" && Number.isFinite(value.participants)
        ? value.participants
        : 0,
    access: value.access === "view" ? "view" : "full",
    relayConnected: value.relayConnected === true,
    inputRequired: value.inputRequired === true,
    busy: value.busy === true,
  };
}
