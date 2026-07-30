import type { OmpBackend } from "@omp-ui/core/types";

// The only module touching window.ompBackend (ADR-0002) — components import
// this, never the global.
export const backend: OmpBackend = window.ompBackend;
