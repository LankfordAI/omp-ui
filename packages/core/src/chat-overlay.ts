import * as path from "node:path";
import { removeLineageArtifact, writeLineageArtifact } from "./lineage-artifact";

/**
 * A Chat (ADR-0059) runs in a fresh scratch directory per chat. Under the
 * `per-project-tagged` memory scoping omp-ui seeds, every scratch cwd would
 * mint its own empty project bank, so nothing one chat learned would reach the
 * next. A per-run `--config` overlay (the ADR-0038 pattern, same as the
 * private pin) points every chat at omp's global bank instead.
 *
 * The overlay names only `mnemopi.scoping`; everything else stays the user's
 * config, and it deep-merges with the private overlay (ADR-0031) when a chat
 * is also private. Binds at process start; every spawn and resume re-derives
 * it from the record.
 */

const OVERLAY_NAME = "omp-ui-chat.yml";

export function chatOverlayPath(lineageDir: string): string {
  return path.join(lineageDir, OVERLAY_NAME);
}

/** Writes the global-bank pin for a chat, or removes a stale artifact and returns null. */
export function writeChatOverlay(lineageDir: string, chat: boolean): string | null {
  const file = chatOverlayPath(lineageDir);
  if (chat !== true) {
    removeLineageArtifact(file);
    return null;
  }
  return writeLineageArtifact(lineageDir, file, "mnemopi:\n  scoping: global\n");
}
