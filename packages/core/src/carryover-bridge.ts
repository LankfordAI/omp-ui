import * as path from "node:path";
import { writeLineageArtifact } from "./lineage-artifact";
import { CARRYOVER_CONTEXT_CHAR_MAX } from "./carryover-context";
import { hiddenContextArmMessage, hiddenContextExtensionSource } from "./hidden-context-extension";

/**
 * The restart carryover (#824) as one hidden custom message (#896,
 * ADR-0060), never `--append-system-prompt`: omp resolves that flag as
 * `appendSystemPrompt ?? <APPEND_SYSTEM.md lookup>`, so any value replaces
 * the user's own APPEND_SYSTEM.md. Armed only on the launch that carries a
 * digest; never re-sent on compaction, branch, or /new, because the digest is
 * earlier conversation, not standing context.
 */

export const CARRYOVER_CONTEXT_COMMAND = "omp-ui-carryover-context";
export const CARRYOVER_CONTEXT_CUSTOM_TYPE = "omp-ui:carryover-context";
/** The extension file lives beside the transcript so it dies with the lineage. */
const EXTENSION = "omp-ui-carryover-context.ts";

export function carryoverContextExtensionPath(lineageDir: string): string {
  return path.join(lineageDir, EXTENSION);
}

/** Rewritten on every rpc spawn, like every generated bridge. */
export function writeCarryoverContextExtension(lineageDir: string): string {
  return writeLineageArtifact(
    lineageDir,
    carryoverContextExtensionPath(lineageDir),
    hiddenContextExtensionSource({
      command: CARRYOVER_CONTEXT_COMMAND,
      customType: CARRYOVER_CONTEXT_CUSTOM_TYPE,
      textMax: CARRYOVER_CONTEXT_CHAR_MAX,
      label: "omp-ui carryover context",
      resendOn: [],
    }),
  );
}

export function carryoverContextArmMessage(text: string): string {
  return hiddenContextArmMessage(CARRYOVER_CONTEXT_COMMAND, text);
}
