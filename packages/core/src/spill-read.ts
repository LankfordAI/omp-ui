import * as fs from "node:fs";
import * as path from "node:path";
import { isWithin } from "./worktree";
import { SPILL_READ_MAX_BYTES, type SpillReadResult } from "./spill";

/**
 * Confined reader for one session spill (`local://<id>.log`, omp 19+), shared
 * by the desktop main and the headless lite member. The caller passes the
 * session's `local://` root exactly as its own transcript resolved it — never
 * a renderer-supplied path. Only numeric ids are accepted: the id is digits,
 * so no traversal is expressible, and the realpath must still land strictly
 * inside the root, so a symlink cannot escape it. Reads at most
 * {@link SPILL_READ_MAX_BYTES}; a larger file returns its head with
 * `truncated: true`. Spill bytes are omp-sanitized terminal text: undecodable
 * bytes become replacement characters rather than a failure — this is a viewer.
 */
const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
const decoder = new TextDecoder("utf-8");

/** Reads `<root>/<id>.log`; anything unreadable or non-regular is `{status:"missing"}`. */
export async function readSpillFile(localRoot: string, id: number): Promise<SpillReadResult> {
  if (!Number.isSafeInteger(id) || id < 0) return { status: "missing" };
  // Confinement compares resolved paths: a symlinked component above the root
  // must not make a legitimate spill look escaped (or an escape look legal).
  let realRoot: string;
  try {
    realRoot = await fs.promises.realpath(localRoot);
  } catch {
    return { status: "missing" };
  }
  const target = path.join(realRoot, `${id}.log`);
  let resolved: string;
  try {
    resolved = await fs.promises.realpath(target);
  } catch {
    return { status: "missing" };
  }
  if (!isWithin(realRoot, resolved)) return { status: "missing" };
  let handle: fs.promises.FileHandle;
  try {
    handle = await fs.promises.open(resolved, OPEN_FLAGS);
  } catch {
    return { status: "missing" };
  }
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile()) return { status: "missing" };
    const size = Number(stat.size);
    // One spare byte detects a file larger than the bound without reading it.
    const want = Math.min(size, SPILL_READ_MAX_BYTES) + 1;
    const buffer = Buffer.allocUnsafe(want);
    let total = 0;
    while (total < want) {
      const { bytesRead } = await handle.read(buffer, total, want - total, total);
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    const truncated = total > SPILL_READ_MAX_BYTES || size > total;
    return { status: "ok", text: decoder.decode(buffer.subarray(0, Math.min(total, SPILL_READ_MAX_BYTES))), truncated };
  } finally {
    await handle.close().catch(() => {});
  }
}
