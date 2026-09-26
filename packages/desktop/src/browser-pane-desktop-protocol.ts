import type { OmpBackend } from "@omp-ui/core/types";

export type DesktopBackendBridge = Omit<OmpBackend, "onBrowserPaneFrame">;

export const DESKTOP_PANE_PORT_REQUEST = "browser-pane:desktop-port-request";
export const DESKTOP_PANE_PORT = "browser-pane:desktop-port";
export const DESKTOP_PANE_WINDOW_REQUEST = "omp-ui:browser-pane:desktop-port-request";
export const DESKTOP_PANE_WINDOW_PORT = "omp-ui:browser-pane:desktop-port";

export interface DesktopFrameDelivery {
  type: "frame";
  id: number;
  tabId: string;
  frame: Uint8Array;
}

/** Physical geometry of a local pane's tab-capture stream. */
export interface DesktopMediaGeometry {
  /** Page pixels to paint: the existing frame header's width/height/dsf. */
  width: number;
  height: number;
  dsf: number;
  /** Even compositor surface Chromium captures; content occupies its top-left width × height. */
  surfaceWidth: number;
  surfaceHeight: number;
}

export interface DesktopMediaLease {
  /** Single-use, requester-bound webContents.getMediaSourceId token (valid ~10 s). */
  sourceId: string;
  /** Page identity: a recreated or destroyed page advances it. */
  generation: number;
  geometry: DesktopMediaGeometry;
}

export type DesktopFrameReply =
  | { type: "ready" }
  | { type: "ack"; id: number }
  | { type: "media-lease-request"; requestId: number; tabId: string };

export type DesktopMediaMessage =
  | { type: "media-lease"; requestId: number; tabId: string; lease: DesktopMediaLease | null }
  | { type: "media-geometry"; tabId: string; generation: number; geometry: DesktopMediaGeometry }
  | { type: "media-ended"; tabId: string; generation: number };

export type DesktopPortMessage = DesktopFrameDelivery | DesktopMediaMessage;
