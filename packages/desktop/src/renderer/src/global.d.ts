import type { OmpBackend } from "@omp-ui/core/types";
import type { DesktopAdapter } from "@omp-ui/core/desktop-channels";
import type { HostBootstrap } from "@omp-ui/core/host-bootstrap-channels";

declare global {
  interface Window {
    ompBackend: OmpBackend;
    /** Present only inside a desktop client (issue #454). */
    ompDesktop?: DesktopAdapter;
    /** Present only inside a desktop client (issue #442 §11); the renderer boots from it. */
    ompHostBootstrap?: HostBootstrap;
  }
}

export {};
