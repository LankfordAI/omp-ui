import type { OmpBackend } from "@omp-ui/core/types";

// The only module touching window.ompBackend (ADR-0002) — components import
// this, never the global.
export const backend: OmpBackend = window.ompBackend;

/** ipcRenderer.invoke wraps main-process errors — unwrap for display (#16 precedent). */
export function displayMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "");
}
