import { appendMainLog } from "./main-log";
import type { SessionMode } from "@omp-ui/core";

/**
 * Crash-surviving lifecycle breadcrumbs (issue #413). Every event lands in an
 * in-memory ring AND on disk through `appendMainLog`, which gives the ISO
 * prefix and the 1 MiB rotation to `.old` for free — so the tail of a log
 * written before a crash is still readable after it.
 */
export type BreadcrumbKind =
  | "launch"
  | "window-created"
  | "quit"
  | "session-spawn"
  | "session-resume"
  | "session-exit"
  | "session-terminate"
  | "session-hibernate"
  | "session-mode"
  | "update-stage"
  | "remote-enable"
  | "remote-token-regenerate"
  | "renderer-gone"
  | "renderer-reload"
  | "renderer-crash-loop"
  | "renderer-unresponsive"
  | "child-process-gone"
  | "main-exception"
  | "main-rejection";

export interface BreadcrumbEntry {
  at: string;
  /** Monotonic within the run; restarts at 0 on relaunch. */
  seq: number;
  kind: BreadcrumbKind;
  /** Never prompt text — an id only. */
  tabId?: string;
  mode?: SessionMode;
  /** Truncated at `record()` time so one long stack line can't crowd the ring. */
  detail?: string;
}

export interface BreadcrumbSink {
  record(kind: BreadcrumbKind, fields?: Omit<BreadcrumbEntry, "at" | "seq" | "kind">): void;
  /** In-memory ring, newest last, capped at 200. */
  entries(): BreadcrumbEntry[];
}

const RING_CAPACITY = 200;
const DETAIL_LIMIT = 200;

/** Swallows every record — the default for tests and unwired construction paths. */
export const NO_BREADCRUMBS: BreadcrumbSink = {
  record: () => undefined,
  entries: () => [],
};

export function createBreadcrumbRing(logDir: string): BreadcrumbSink {
  const ring: BreadcrumbEntry[] = [];
  let seq = 0;
  return {
    record(kind, fields = {}) {
      seq += 1;
      const entry: BreadcrumbEntry = { at: new Date().toISOString(), seq, kind };
      if (fields.tabId !== undefined) entry.tabId = fields.tabId;
      if (fields.mode !== undefined) entry.mode = fields.mode;
      if (fields.detail !== undefined) {
        entry.detail =
          fields.detail.length > DETAIL_LIMIT
            ? `${fields.detail.slice(0, DETAIL_LIMIT - 1)}…`
            : fields.detail;
      }
      ring.push(entry);
      if (ring.length > RING_CAPACITY) ring.shift();
      // The file line carries appendMainLog's own ISO prefix, not the entry's.
      const { at: _ignored, ...payload } = entry;
      appendMainLog(logDir, "breadcrumbs.log", JSON.stringify(payload));
    },
    entries: () => ring.slice(),
  };
}
