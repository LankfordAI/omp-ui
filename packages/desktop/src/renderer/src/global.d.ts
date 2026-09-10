import type { OmpBackend } from "@omp-ui/core/types";
import type { DesktopAdapter } from "@omp-ui/core/desktop-channels";

declare global {
  interface Window {
    ompBackend: OmpBackend;
    /** Present only inside a desktop client (issue #454). */
    ompDesktop?: DesktopAdapter;
  }
}

export {};
