/**
 * Fleet dispatch (issue #899, ADR-0061): the Node half on the owning host.
 * The resource sampler behind `fleet:hostReport`, and the staged dispatch
 * prompt — written into the lineage dir at accept time, delivered on the
 * initialCommands rail, and unlinked once omp acknowledges the prompt.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { removeLineageArtifact, writeLineageArtifact } from "./lineage-artifact";

export const FLEET_PROMPT_ARTIFACT = "fleet-prompt.md";

/** Stages the dispatch prompt; dies with the lineage dir like every lineage artifact. */
export function stageFleetPrompt(absLineageDir: string, text: string): string {
  return writeLineageArtifact(absLineageDir, path.join(absLineageDir, FLEET_PROMPT_ARTIFACT), text);
}

/** The staged prompt; null when absent, unreadable, or blank. */
export function readFleetPrompt(absLineageDir: string): string | null {
  try {
    const text = fs.readFileSync(path.join(absLineageDir, FLEET_PROMPT_ARTIFACT), "utf8");
    return text.trim() === "" ? null : text;
  } catch {
    return null;
  }
}

/** Removes the staged prompt after omp acknowledged it; absent is success. */
export function consumeFleetPrompt(absLineageDir: string): void {
  removeLineageArtifact(path.join(absLineageDir, FLEET_PROMPT_ARTIFACT));
}

export interface HostResources {
  cpuCount: number;
  /** 0..1 over the sample window; null when the window saw no ticks. */
  cpuUtilization: number | null;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
}

function cpuTicks(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/**
 * Available memory: Linux reads `MemAvailable` from /proc/meminfo (it counts
 * reclaimable page cache); every other platform, and any read failure, uses
 * `os.freemem()`. On macOS that under-counts reclaimable pages, which only
 * makes placement conservative there.
 */
function availableMemory(): number {
  if (process.platform === "linux") {
    try {
      const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(fs.readFileSync("/proc/meminfo", "utf8"));
      if (match !== null) return Number(match[1]) * 1024;
    } catch {
      // fall through to os.freemem()
    }
  }
  return os.freemem();
}

/** Two `os.cpus()` snapshots `intervalMs` apart: utilization is 1 - idle/total over every core. */
export async function sampleHostResources(intervalMs = 200): Promise<HostResources> {
  const before = cpuTicks();
  await delay(intervalMs);
  const after = cpuTicks();
  const totalDelta = after.total - before.total;
  const idleDelta = after.idle - before.idle;
  const cpuUtilization = totalDelta > 0 ? Math.min(1, Math.max(0, 1 - idleDelta / totalDelta)) : null;
  return {
    cpuCount: os.cpus().length,
    cpuUtilization,
    totalMemoryBytes: os.totalmem(),
    availableMemoryBytes: availableMemory(),
  };
}
