import type { OmpBackend } from "@omp-ui/core/types";
import type { DesktopBackendBridge } from "../../browser-pane-desktop-protocol";
import type { ArtifactHostBridge } from "../../artifact-runtime-protocol";

declare global {
  interface Window {
    ompBackend: OmpBackend | DesktopBackendBridge;
    ompArtifactHost?: ArtifactHostBridge;
  }
}

export {};
