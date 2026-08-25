import * as fs from "node:fs";

import {
  hydrateSessionFile,
  parseModelRole,
  resolveSessionLocation,
  unarchiveSession,
  readOmpCompactionMethods,
  type OwnedSessionRecord,
  writeAdvisorOverlay,
  writeAdvisorStatsExtension,
  writeCompactionMethodOverlay,
  writeDefaultModelOverlay,
  writeMcpStatusExtension,
  writePlanExtension,
} from "@omp-ui/core";

  /** Rewrites spawn overlays from the session record on every launch. */
export function writeSessionOverlays(record: OwnedSessionRecord, absLineageDir: string): string[] {
    const overlays: string[] = [];
    const advisorRole = record.advisorModel === null ? null : parseModelRole(record.advisorModel);
    try {
      const overlay = writeAdvisorOverlay(absLineageDir, advisorRole, record.advisor);
      if (overlay !== null) overlays.push(overlay);
    } catch (err) {
      console.warn("[advisor] could not write the overlay:", err);
    }
    const model = record.model;
    if (model !== null) {
      const selector =
        record.thinkingLevel == null ? model : `${model}:${record.thinkingLevel}`;
      try {
        const overlay = writeDefaultModelOverlay(absLineageDir, parseModelRole(selector));
        if (overlay !== null) overlays.push(overlay);
      } catch (err) {
        console.warn("[model] could not write the default-model overlay:", err);
      }
    }
    return overlays;
  }

export async function writeRpcOverlays(
    record: OwnedSessionRecord,
    absLineageDir: string,
    ompPath: string,
  ): Promise<string[]> {
    const overlays = writeSessionOverlays(record, absLineageDir);
    const preferred = record.compactionMethod;
    if (preferred === null) {
      writeCompactionMethodOverlay(absLineageDir, null, []);
      return overlays;
    }
    try {
      const methods = await readOmpCompactionMethods({
        ompPath,
        projectCwd: record.worktree?.path ?? record.projectCwd,
      });
      if (!methods.supported.includes(preferred)) {
        writeCompactionMethodOverlay(absLineageDir, null, []);
        console.warn(
          `[compaction] tab ${record.tabId} captured unavailable method ${preferred}; using omp configuration`,
        );
        return overlays;
      }
      const overlay = writeCompactionMethodOverlay(
        absLineageDir,
        preferred,
        methods.configuredOrder,
      );
      if (overlay !== null) overlays.push(overlay);
    } catch (err) {
      writeCompactionMethodOverlay(absLineageDir, null, []);
      console.warn(
        `[compaction] tab ${record.tabId} could not apply captured method ${preferred}; using omp configuration:`,
        err,
      );
    }
    return overlays;
  }

  /** The generated `-e` bridges an rpc-ui spawn needs. */
export function writeRpcExtensions(absLineageDir: string): { paths: string[]; mcpStatusLoaded: boolean } {
    const paths: string[] = [];
    try {
      paths.push(writePlanExtension(absLineageDir));
    } catch (err) {
      console.warn("[plan] could not write the plan extension:", err);
    }
    try {
      paths.push(writeAdvisorStatsExtension(absLineageDir));
    } catch (err) {
      console.warn("[advisor] could not write the advisor-stats extension:", err);
    }
    let mcpStatusLoaded = false;
    try {
      paths.push(writeMcpStatusExtension(absLineageDir));
      mcpStatusLoaded = true;
    } catch (err) {
      console.warn("[mcp] could not write the MCP-status extension:", err);
    }
    return { paths, mcpStatusLoaded };
  }

/** Manager-provided paths and registry mutation for prepareResumeRecord. */
export interface PrepareResumeDeps {
  sessionsRoot: string;
  archiveRoot: string;
  updateSession: (
    tabId: string,
    patch: Partial<Omit<OwnedSessionRecord, "tabId">>,
  ) => OwnedSessionRecord | undefined;
}

/** Unarchives / adopts as needed so spawn can --resume the right session. */

export async function prepareResumeRecord(
  record: OwnedSessionRecord,
  deps: PrepareResumeDeps,
): Promise<OwnedSessionRecord> {
    if (record.worktree && !fs.existsSync(record.worktree.path)) {
      throw new Error(
        "this session's worktree checkout is gone — delete the session from the sidebar",
      );
    }
    const loc = await resolveSessionLocation(
      deps.sessionsRoot,
      deps.archiveRoot,
      record.lineageDir,
      record.sessionId,
    );
    if (loc.where === "missing") {
      // omp writes the transcript lazily, on the first turn. A record that
      // never had a session id is therefore still a fresh start, not a loss.
      if (record.sessionId === null) return record;
      throw new Error("session files are gone — delete it from the sidebar");
    }
    if (loc.where === "archived") {
      let sessionId = record.sessionId;
      if (!sessionId) {
        const m = /_([^_]+)\.jsonl\.gz$/.exec(loc.filePath);
        if (!m) throw new Error(`cannot identify archived session file ${loc.filePath}`);
        sessionId = m[1]!;
      }
      await unarchiveSession(
        deps.sessionsRoot,
        deps.archiveRoot,
        record.lineageDir,
        sessionId,
      );
      if (sessionId !== record.sessionId) {
        record = deps.updateSession(record.tabId, { sessionId }) ?? record;
      }
      return record;
    }
    // Active: adopt the file's header id when it differs (stale or null id).
    try {
      const h = await hydrateSessionFile(loc.filePath);
      if (h.id && h.id !== record.sessionId) {
        record =
          deps.updateSession(record.tabId, {
            sessionId: h.id,
            cachedTitle: h.title ?? record.cachedTitle,
            cachedModified: h.mtime.toISOString(),
          }) ?? record;
      }
    } catch {
      // Head unreadable — spawn proceeds without --resume.
    }
    return record;
  }
