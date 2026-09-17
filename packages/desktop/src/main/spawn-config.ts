import * as fs from "node:fs";

import {
  hydrateSessionFile,
  parseModelRole,
  resolveSessionLocation,
  resolveSubagentOverlayEntries,
  rebindSessionCwd,
  unarchiveSession,
  readOmpCompactionMethods,
  type OwnedSessionRecord,
  writeAdvisorOverlay,
  writeAutoresearchExtension,
  writeBrowserPaneExtension,
  writeAdvisorStatsExtension,
  writeCapabilitiesExtension,
  writeCompactionMethodOverlay,
  writeDefaultModelOverlay,
  writeMcpStatusExtension,
  writeGoalExtension,
  writePlanExtension,
  writeSubagentModelOverlay,
} from "@omp-ui/core";
import { NO_GATE, type SpawnGate } from "./spawn-gate";

/** Registry inputs the subagent overlay needs (ADR-0031), read synchronously off the registry. */
export interface SubagentSpawnConfig {
  inheritByDefault: boolean;
  roster: readonly string[];
}

/** Rewrites spawn overlays from the session record (and any dev/test gate pin) on every launch. */
export function writeSessionOverlays(
  record: OwnedSessionRecord,
  absLineageDir: string,
  gate: SpawnGate = NO_GATE,
  subagents: SubagentSpawnConfig = { inheritByDefault: false, roster: [] },
): string[] {
  const overlays: string[] = [];
  // The gate's advisor model wins over the record's; the enabled flag stays the
  // record's, so an advisor test under the gate still tests the advisor.
  const advisorRole =
    gate.advisorModel ?? (record.advisorModel === null ? null : parseModelRole(record.advisorModel));
  try {
    const overlay = writeAdvisorOverlay(absLineageDir, advisorRole, record.advisor);
    if (overlay !== null) overlays.push(overlay);
  } catch (err) {
    console.warn("[advisor] could not write the overlay:", err);
  }
  // The gate pins every launch, resume included; otherwise the record's own pin,
  // unchanged. A gated level comes from the selector alone — a run that wants the
  // record's thinking level asks omp for it, so record.thinkingLevel is not consulted.
  const role =
    gate.model ??
    (record.model === null
      ? null
      : parseModelRole(
          record.thinkingLevel === null
            ? record.model
            : `${record.model}:${record.thinkingLevel}`,
        ));
  if (role !== null) {
    try {
      const overlay = writeDefaultModelOverlay(absLineageDir, role);
      if (overlay !== null) overlays.push(overlay);
    } catch (err) {
      console.warn("[model] could not write the default-model overlay:", err);
    }
  }
  // The gate needs no subagent case: a gated main model reaches subagents for
  // free through the "*" entries the umbrella and explicit choices resolve to.
  try {
    const overlay = writeSubagentModelOverlay(
      absLineageDir,
      resolveSubagentOverlayEntries(
        record.subagentModels,
        subagents.inheritByDefault,
        subagents.roster,
      ),
    );
    if (overlay !== null) overlays.push(overlay);
  } catch (err) {
    console.warn("[subagents] could not write the overlay:", err);
  }
  return overlays;
}

export async function writeRpcOverlays(
  record: OwnedSessionRecord,
  absLineageDir: string,
  ompPath: string,
  gate: SpawnGate = NO_GATE,
  subagents: SubagentSpawnConfig = { inheritByDefault: false, roster: [] },
): Promise<string[]> {
  const overlays = writeSessionOverlays(record, absLineageDir, gate, subagents);
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
export function writeRpcExtensions(absLineageDir: string): {
  paths: string[];
  mcpStatusLoaded: boolean;
  capabilitiesLoaded: boolean;
  goalLoaded: boolean;
  browserPaneLoaded: boolean;
  autoresearchLoaded: boolean;
} {
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
    let capabilitiesLoaded = false;
    try {
      paths.push(writeCapabilitiesExtension(absLineageDir));
      capabilitiesLoaded = true;
    } catch (err) {
      console.warn("[capabilities] could not write the capabilities extension:", err);
    }
    let goalLoaded = false;
    try {
      paths.push(writeGoalExtension(absLineageDir));
      goalLoaded = true;
    } catch (err) {
      console.warn("[goal] could not write the goal extension:", err);
    }
    let browserPaneLoaded = false;
    try {
      paths.push(writeBrowserPaneExtension(absLineageDir));
      browserPaneLoaded = true;
    } catch (err) {
      console.warn("[browser-pane] could not write the browser-pane extension:", err);
    }
    let autoresearchLoaded = false;
    try {
      paths.push(writeAutoresearchExtension(absLineageDir));
      autoresearchLoaded = true;
    } catch (err) {
      console.warn("[autoresearch] could not write the autoresearch extension:", err);
    }
    return {
      paths,
      mcpStatusLoaded,
      capabilitiesLoaded,
      goalLoaded,
      browserPaneLoaded,
      autoresearchLoaded,
    };
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
      const restored = await resolveSessionLocation(
        deps.sessionsRoot,
        deps.archiveRoot,
        record.lineageDir,
        sessionId,
      );
      if (restored.where === "active") await rebindCwd(restored.filePath, record);
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
    await rebindCwd(loc.filePath, record);
    return record;
  }

/**
 * Keeps the session file's recorded directory equal to the record's effective
 * working tree. omp refuses `--resume` for a session whose header `cwd` no
 * longer exists, which is exactly what releasing a worktree leaves behind
 * (issue #334): the checkout is gone and the session now runs in the project.
 * Never fatal — a failed rewrite loses the resume, not the session.
 */
async function rebindCwd(filePath: string, record: OwnedSessionRecord): Promise<void> {
  try {
    await rebindSessionCwd(filePath, record.worktree?.path ?? record.projectCwd);
  } catch (err) {
    console.warn(`[sessions] could not rebind ${filePath} to its working tree:`, err);
  }
}
