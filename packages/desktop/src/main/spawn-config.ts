import {
  parseModelRole,
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
