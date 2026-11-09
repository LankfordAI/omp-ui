// Shared browser-safe Android device pane protocol. No runtime platform dependencies.
import type { BrowserPaneFrameHeader } from "./browser-pane";

export const DEVICE_PANE_FPS = 30;
export const DEVICE_PANE_JPEG_QUALITY = 80;
export const DEVICE_PANE_MAX_EDGE = 1280;
export const DEVICE_PANE_ACTING_MS = 1_500;
export const DEVICE_TOOL_TIMEOUT_MS = 50_000;
export const DEVICE_TOOL_NAME = "omp-ui_device";
export type DevicePaneAgentState = "detached" | "attached" | "acting";
export type EmulatorPosture = "closed" | "half-open" | "open" | "flipped" | "tent";
export type EmulatorRotation = 0 | 1 | 2 | 3;
export interface DeviceSystemImage {
  packageId: string;
  api: number;
  abi: "x86_64" | "arm64-v8a";
  tag: "default" | "google_apis" | "google_apis_playstore";
  label: string;
}
export interface DeviceProfileOffer {
  id: string;
  name: string;
  family: "phone" | "tablet" | "book" | "flip" | "fold-out";
  minApi: number;
  available: boolean;
  reason: string | null;
  images: DeviceSystemImage[];
  defaultImagePackage: string | null;
  proposedAvd: string;
}
export interface DeviceTarget {
  serial: string | null;
  avd: string;
  state: "running" | "booting" | "stopped";
  friendlyName?: string;
  api?: number;
  availabilityReason?: string | null;
  layoutReference?: string;
}
export type DeviceSdkStatus =
  | { status: "ready"; sdkRoot: string }
  | { status: "missing"; missing: Array<"sdk" | "adb" | "emulator"> };
export interface DeviceInventory {
  sdk: DeviceSdkStatus;
  targets: DeviceTarget[];
  profiles: DeviceProfileOffer[];
  images: DeviceSystemImage[];
  creation: { available: boolean; reason: string | null; sdkRoot: string | null; installCommand: string | null };
}
export interface DevicePaneState {
  serial: string | null;
  avd: string | null;
  phase: "unbound" | "provisioning" | "booting" | "connecting" | "streaming" | "error";
  agent: DevicePaneAgentState;
  error: string | null;
  open: boolean;
  display: { width: number; height: number } | null;
  bindingId: string | null;
  geometryRevision: number;
  rotation: EmulatorRotation | null;
  posture: EmulatorPosture | null;
  hingeAngle: number | null;
  screen: "unknown" | "active" | "inactive";
  inputReady: boolean;
  capabilities: {
    rotation: { available: boolean; reason: string | null };
    postures: {
      available: boolean;
      reason: string | null;
      supported: Array<{ posture: EmulatorPosture; nativeId: number; minAngle: number; maxAngle: number; targetAngle: number }>;
    };
  };
  operation: {
    kind: "create" | "boot" | "bind" | "rotate" | "set-posture" | "refresh" | "power-off";
    stage: "creating" | "starting" | "connecting" | "rotating" | "changing-posture";
    rotation?: EmulatorRotation;
    posture?: EmulatorPosture;
    avd?: string;
  } | null;
  actionError: string | null;
}
export type DevicePaneEnsureResult =
  | { status: "missing-session" | "not-live" | "terminal" }
  | { status: "available"; protocolVersion: 2; state: DevicePaneState; inventory: DeviceInventory };
export type DevicePaneAction =
  | { action: "bind"; serial: string }
  | { action: "boot"; avd: string }
  | { action: "create"; profileId: string; imagePackage: string; avd: string }
  | { action: "rotate"; bindingId: string; rotation: EmulatorRotation }
  | { action: "set-posture"; bindingId: string; posture: EmulatorPosture }
  | { action: "unbind" | "power-off"; bindingId: string }
  | { action: "refresh"; bindingId: string | null };
export type DeviceButton = "back" | "home" | "recents" | "power";
export const DEVICE_BUTTONS: readonly DeviceButton[] = ["back", "home", "recents", "power"];
export type DevicePaneInputEvent = { bindingId: string; geometryRevision: number } & (
  | { type: "touch"; phase: "down" | "move" | "up"; x: number; y: number; pointer: number }
  | { type: "wheel"; x: number; y: number; dx: number; dy: number }
  | { type: "key"; phase: "down" | "up"; key: string }
  | { type: "text"; text: string }
  | { type: "button"; button: DeviceButton }
);
export const DEVICE_SERIAL_PATTERN = "^emulator-\\d{1,5}(?![\\s\\S])";
export const DEVICE_AVD_PATTERN = "^[A-Za-z0-9._-]{1,128}(?![\\s\\S])";
/** Canonical UUID text, with RFC variant and a defined UUID version. */
export const DEVICE_BINDING_ID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\\s\\S])";
const bindingPattern = new RegExp(DEVICE_BINDING_ID_PATTERN);
export const DEVICE_PANE_FRAME_HEADER_BYTES = 28;
export interface DevicePaneFrameHeader extends BrowserPaneFrameHeader {
  bindingId: string;
  geometryRevision: number;
}
function validRevision(value: number): boolean {
  return Number.isInteger(value) && value > 0 && value <= 0xffff_ffff;
}
export function encodeDevicePaneFrameHeader(header: DevicePaneFrameHeader): Uint8Array {
  const dsf = Math.round(header.dsf * 100);
  if (![header.width, header.height].every((n) => Number.isInteger(n) && n > 0 && n <= 0xffff)
    || !Number.isFinite(header.dsf) || header.dsf <= 0 || dsf < 1 || dsf > 0xffff
    || !bindingPattern.test(header.bindingId) || !validRevision(header.geometryRevision)) {
    throw new RangeError("Invalid device pane frame header");
  }
  const bytes = new Uint8Array(DEVICE_PANE_FRAME_HEADER_BYTES);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, header.width);
  view.setUint16(2, header.height);
  view.setUint16(4, dsf);
  view.setUint16(6, 0x4450);
  const uuid = header.bindingId.replaceAll("-", "");
  for (let i = 0; i < 16; i++) bytes[8 + i] = Number.parseInt(uuid.slice(i * 2, i * 2 + 2), 16);
  view.setUint32(24, header.geometryRevision);
  return bytes;
}
export function decodeDevicePaneFrame(bytes: Uint8Array): { header: DevicePaneFrameHeader; jpeg: Uint8Array } | null {
  if (bytes.length <= DEVICE_PANE_FRAME_HEADER_BYTES) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint16(0);
  const height = view.getUint16(2);
  const dsf = view.getUint16(4) / 100;
  const geometryRevision = view.getUint32(24);
  if (!width || !height || !dsf || view.getUint16(6) !== 0x4450 || !validRevision(geometryRevision)) return null;
  let uuid = "";
  for (let i = 8; i < 24; i++) uuid += bytes[i]!.toString(16).padStart(2, "0");
  const bindingId = `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
  if (!bindingPattern.test(bindingId)) return null;
  return { header: { width, height, dsf, bindingId, geometryRevision }, jpeg: bytes.subarray(DEVICE_PANE_FRAME_HEADER_BYTES) };
}

// Pure catalog helpers used by the chooser; no SDK filesystem or runtime imports.
export { proposeAvdName, isNativeDeviceProfile } from "./device-profiles";
