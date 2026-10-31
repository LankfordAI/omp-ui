// The device pane wire contract (issue #1006, ADR-0086). Pure — zero imports —
// because renderer, desktop main, and the server all share it: the renderer
// imports it via the @omp-ui/core/device-pane subpath exactly like
// browser-pane.ts. Frames reuse the browser pane's generic "8-byte header +
// JPEG" encoding (encodeBrowserPaneFrameHeader / decodeBrowserPaneFrame).

export const DEVICE_PANE_FPS = 30;
export const DEVICE_PANE_JPEG_QUALITY = 80;
/** Long-edge cap of the requested stream size, in device pixels. */
export const DEVICE_PANE_MAX_EDGE = 1280;
/** How long an agent device command keeps the state at `acting` after it settles. */
export const DEVICE_PANE_ACTING_MS = 1_500;
/** One agent-device invocation's wall-clock bound; under HOST_ANSWER_WATCHDOG_MS (60 s). */
export const DEVICE_TOOL_TIMEOUT_MS = 50_000;
export const DEVICE_TOOL_NAME = "omp-ui_device";

export type DevicePaneAgentState = "detached" | "attached" | "acting";

/** One Android Emulator target as main sees it. */
export interface DeviceTarget {
  /** adb serial, e.g. "emulator-5554"; null for an AVD that is not running. */
  serial: string | null;
  avd: string;
  state: "running" | "booting" | "stopped";
}

export type DeviceSdkStatus =
  | { status: "ready"; sdkRoot: string }
  | { status: "missing"; missing: Array<"sdk" | "adb" | "emulator"> };

export interface DeviceInventory {
  sdk: DeviceSdkStatus;
  /** Running emulators first (serial order), then stopped AVDs (name order). */
  targets: DeviceTarget[];
}

export interface DevicePaneState {
  /** The serial bound to this tab; null when none. */
  serial: string | null;
  avd: string | null;
  phase: "unbound" | "booting" | "connecting" | "streaming" | "error";
  agent: DevicePaneAgentState;
  error: string | null;
  /** Session-level posture, like BrowserPaneState.open (#556). */
  open: boolean;
  /** Native display size in device pixels; null until known. */
  display: { width: number; height: number } | null;
}

export type DevicePaneEnsureResult =
  | { status: "missing-session" | "not-live" | "terminal" }
  | { status: "available"; state: DevicePaneState; inventory: DeviceInventory };

export type DevicePaneAction =
  | { action: "bind"; serial: string }
  | { action: "boot"; avd: string }
  | { action: "unbind" }
  | { action: "power-off" }
  | { action: "refresh" };

export type DeviceButton = "back" | "home" | "recents" | "power";

export const DEVICE_BUTTONS: readonly DeviceButton[] = ["back", "home", "recents", "power"];

/** Renderer input; x/y are unit coordinates [0,1] over the painted frame. */
export type DevicePaneInputEvent =
  | { type: "touch"; phase: "down" | "move" | "up"; x: number; y: number; pointer: number }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number }
  | { type: "key"; phase: "down" | "up"; key: string }
  | { type: "text"; text: string }
  | { type: "button"; button: DeviceButton };

/** Strict serial grammar: emulator serials only in v1. */
export const DEVICE_SERIAL_PATTERN = "^emulator-\\d{1,5}$";
/** AVD names as `avdmanager` accepts them. */
export const DEVICE_AVD_PATTERN = "^[A-Za-z0-9._-]{1,128}$";

// Bundled device profiles re-exported here so the renderer reaches them via @omp-ui/core/device-pane.
export { DEVICE_PROFILES, findDeviceProfileByAvd, type DeviceProfile } from "./device-profiles";
