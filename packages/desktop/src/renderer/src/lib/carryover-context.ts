import {
  CARRYOVER_MESSAGE_CHAR_CAP,
  renderCarryoverDigest,
  type CarryoverMessage,
} from "@omp-ui/core/carryover-context";
import type { RenderItem } from "./transcript";

/** Parser ceiling minus headroom: the composed digest can never be rejected
 *  by `parseSpawnRequest`'s 65_536-character guard (#824). */
const COMPOSED_CHAR_GUARD = 65_000;

/**
 * The digest a restart hands main when the successor may start with no omp
 * transcript to resume (#824). The only user-visible transcript fields carry
 * over: user/assistant prose. Tools, notices, advisories, IRC, plans,
 * commands, shell rows, and markers are process-local noise the next process
 * must not inherit. Returns null when nothing survives to seed.
 */
export function composeCarryoverContext(
  items: readonly RenderItem[],
): string | null {
  const messages: CarryoverMessage[] = [];
  for (const item of items) {
    if (item.kind !== "user" && item.kind !== "assistant") continue;
    // A streaming assistant that has yielded no text says nothing yet.
    const text = item.text.trim();
    if (text === "") continue;
    messages.push({
      role: item.kind,
      text:
        text.length > CARRYOVER_MESSAGE_CHAR_CAP
          ? `${text.slice(0, CARRYOVER_MESSAGE_CHAR_CAP)}…`
          : text,
    });
  }
  if (messages.length === 0) return null;
  const digest = renderCarryoverDigest(messages);
  if (digest === "") return null;
  if (digest.length <= COMPOSED_CHAR_GUARD) return digest;
  // Defensive: renderCarryoverDigest's own budget makes this unreachable;
  // stay under the parser ceiling anyway by dropping from the front on a
  // block boundary.
  const tail = digest.slice(digest.indexOf("<turn", digest.length - COMPOSED_CHAR_GUARD));
  return `(earlier messages omitted)\n\n${tail}`;
}
