import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { isWithin } from "@omp-ui/core";

/**
 * The one confined plan-artifact reader (issue #312 follow-up). Both the
 * preflight gate and ordinary `plan:read` run through it so validation and
 * presentation can never disagree about WHICH bytes they read. The path is
 * confined on two axes: realpath containment under the lineage root (so a
 * symlink cannot escape) and a regular-file check (so a fifo or device is
 * never streamed). At most {@link PLAN_ARTIFACT_BYTE_LIMIT}+1 bytes are read;
 * the cap guards the verifier, not the author — exceeding it is an
 * application limitation, never an instruction to shorten the plan.
 */
export const PLAN_ARTIFACT_BYTE_LIMIT = 8 * 1024 * 1024;
/** Cap on the PREPARED document the verifier will accept (32 MiB). */
export const PLAN_PREPARED_BYTE_LIMIT = 32 * 1024 * 1024;

export type ConfinedPlanRead =
  | { ok: true; text: string; sourceHash: string; bytes: number }
  | { ok: false; reason: "outside" | "unreadable" | "over-limit" };

/**
 * Read one plan artifact confined to `root` (the session's lineage dir,
 * realpath'd), returning the exact bytes' UTF-8 text and their SHA-256 hash.
 * `absPath` is also realpath'd; a symlink that resolves OUTSIDE the root
 * fails closed, and a symlink inside the root is judged by its TARGET.
 */
export async function readConfinedPlanFile(
  root: string,
  absPath: string,
): Promise<ConfinedPlanRead> {
  const rootReal = await realpathOrNull(root);
  if (rootReal === null) return { ok: false, reason: "unreadable" };
  const targetReal = await realpathOrNull(path.resolve(absPath));
  if (targetReal === null || !isWithin(rootReal, targetReal)) {
    return { ok: false, reason: "outside" };
  }
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(targetReal);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  if (!stat.isFile()) return { ok: false, reason: "unreadable" };
  if (stat.size > PLAN_ARTIFACT_BYTE_LIMIT) return { ok: false, reason: "over-limit" };
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(targetReal, fs.constants.O_RDONLY);
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    // The +1 byte: a file that GREW past the cap between stat and read is
    // detected, not silently truncated.
    const buffer = Buffer.alloc(PLAN_ARTIFACT_BYTE_LIMIT + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > PLAN_ARTIFACT_BYTE_LIMIT) return { ok: false, reason: "over-limit" };
    const bytes = buffer.subarray(0, bytesRead);
    return {
      ok: true,
      text: bytes.toString("utf8"),
      sourceHash: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytesRead,
    };
  } catch {
    return { ok: false, reason: "unreadable" };
  } finally {
    await handle.close().catch(() => {});
  }
}

async function realpathOrNull(target: string): Promise<string | null> {
  try {
    return await fs.promises.realpath(target);
  } catch {
    return null;
  }
}
