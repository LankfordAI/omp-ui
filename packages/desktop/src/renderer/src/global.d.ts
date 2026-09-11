import type { OmpBackend } from "@omp-ui/core/types";

declare global {
  interface Window {
    ompBackend: OmpBackend;
  }
}

export {};
