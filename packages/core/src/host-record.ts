import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeTextDurably } from "./atomic-write";
import type { ProtocolRange } from "./types";

/**
 * `<dataRoot>/host.json` (issue #442 §10.4): how a local client — the desktop
 * shell or the control CLI — finds and authenticates to the running host. Mode
 * 0600: it carries both loopback credentials.
 */
export interface HostConnectionRecordV1 {
  schemaVersion: 1;
  dataRoot: string;
  hostVersion: string;
  hostProtocol: number;
  protocolRange: ProtocolRange;
  /** `http://127.0.0.1:<port>` */
  endpoint: string;
  /** `omp1.desk.<base64url 32B>` — grants the desktop role. */
  desktopCredential: string;
  /** `omp1.ctl.<base64url 32B>` — grants a browser-role connection the control plane. */
  controlCredential: string;
  pid: number;
  processStartMs: number;
  startedAtMs: number;
  incarnation: number;
}

const DESKTOP_PREFIX = "omp1.desk.";
const CONTROL_PREFIX = "omp1.ctl.";

export function hostRecordPath(dataRoot: string): string {
  return path.join(dataRoot, "host.json");
}

/** Durable and 0600: a client that reads a record must be able to trust every byte of it. */
export function writeHostRecord(record: HostConnectionRecordV1): void {
  writeTextDurably(hostRecordPath(record.dataRoot), `${JSON.stringify(record, null, 2)}\n`, 0o600);
}

/** null when the file is missing, malformed, from another schema, or has a field of the wrong type. */
export function readHostRecord(dataRoot: string): HostConnectionRecordV1 | null {
  let text: string;
  try {
    text = fs.readFileSync(hostRecordPath(dataRoot), "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return isHostConnectionRecordV1(parsed) ? parsed : null;
}

export function deleteHostRecord(dataRoot: string): void {
  fs.rmSync(hostRecordPath(dataRoot), { force: true });
}

export function mintDesktopCredential(): string {
  return DESKTOP_PREFIX + randomBytes(32).toString("base64url");
}

export function mintControlCredential(): string {
  return CONTROL_PREFIX + randomBytes(32).toString("base64url");
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

function isProtocolRange(v: unknown): v is ProtocolRange {
  return (
    typeof v === "object" &&
    v !== null &&
    isFiniteNumber((v as ProtocolRange).min) &&
    isFiniteNumber((v as ProtocolRange).max)
  );
}

function isHostConnectionRecordV1(v: unknown): v is HostConnectionRecordV1 {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return (
    r.schemaVersion === 1 &&
    typeof r.dataRoot === "string" &&
    typeof r.hostVersion === "string" &&
    isFiniteNumber(r.hostProtocol) &&
    isProtocolRange(r.protocolRange) &&
    typeof r.endpoint === "string" &&
    typeof r.desktopCredential === "string" &&
    typeof r.controlCredential === "string" &&
    isFiniteNumber(r.pid) &&
    isFiniteNumber(r.processStartMs) &&
    isFiniteNumber(r.startedAtMs) &&
    isFiniteNumber(r.incarnation)
  );
}
