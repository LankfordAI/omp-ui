import type { OmpBackend } from "@omp-ui/core/types";
import type { DesktopBackendBridge } from "../../browser-pane-desktop-protocol";

declare global {
  interface Window {
    ompBackend: OmpBackend | DesktopBackendBridge;
  }
}

export {};
