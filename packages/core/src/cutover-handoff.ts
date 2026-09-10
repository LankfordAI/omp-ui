import * as path from "node:path";
import { writeTextDurably } from "./atomic-write";

/**
 * The note a legacy Electron authority leaves for the host it is handing its
 * data root to (issue #442 §5.5). The desktop client writes it while it still
 * holds Chromium's `SingletonLock` on the legacy userData dir; the host
 * (`@omp-ui/host` `consumeCutoverHandoff`) accepts it only when the writer is
 * provably that live process. The note grants no authority.
 */
export interface CutoverHandoffV1 {
  schemaVersion: 1;
  pid: number;
  processStartMs: number;
  legacyUserData: string;
  targetDataRoot: string;
  /** 256-bit base64url. */
  nonce: string;
  createdAtMs: number;
}

export const CUTOVER_HANDOFF_MAX_AGE_MS = 10 * 60_000;
export const CUTOVER_NONCE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export function cutoverHandoffPath(dataRoot: string): string {
  return path.join(dataRoot, "cutover-handoff.json");
}

/** Durable and private (0600): the host must be able to trust every byte it reads back. */
export function writeCutoverHandoff(record: CutoverHandoffV1): void {
  if (!CUTOVER_NONCE_PATTERN.test(record.nonce)) {
    throw new Error(`cutover nonce is not filename-safe: ${record.nonce}`);
  }
  writeTextDurably(cutoverHandoffPath(record.targetDataRoot), `${JSON.stringify(record, null, 2)}\n`, 0o600);
}

export function isCutoverHandoff(value: unknown): value is CutoverHandoffV1 {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>; // shape-checked field by field below
  return (
    v.schemaVersion === 1 &&
    typeof v.pid === "number" &&
    Number.isInteger(v.pid) &&
    v.pid > 0 &&
    typeof v.processStartMs === "number" &&
    typeof v.legacyUserData === "string" &&
    typeof v.targetDataRoot === "string" &&
    typeof v.nonce === "string" &&
    CUTOVER_NONCE_PATTERN.test(v.nonce) &&
    typeof v.createdAtMs === "number"
  );
}
