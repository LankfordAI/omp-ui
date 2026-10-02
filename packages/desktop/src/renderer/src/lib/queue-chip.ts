import { compareVersions } from "@omp-ui/core/semver";
import { stripTrailingAttachmentRoutingContext } from "./attachment-routing";
import { splitDocumentContext } from "./document-context";
import { splitResolvedMentionContext } from "./mentions";
import type { SessionRuntime } from "./rpc-types";

/**
 * What the composer's queue chip should say. omp's `queuedMessageCount` counts
 * every displayable queued item — user follow-ups and steers, but also advisor
 * cards, agent-authored custom entries, and deferred messages (issue #181) —
 * and omp only drains queued follow-ups at a clean turn end: after a user
 * interrupt they park until an explicit new prompt. So the honest label
 * depends on whether a turn is actually running: while idle, nothing is
 * "waiting for the current turn" — everything counted is parked.
 */
export interface QueueChipView {
  /** Chip text: "queued: N" while a turn runs, "parked: N" once idle. */
  label: string;
  /** Tooltip stating what the count means in this state. */
  title: string;
}

export function queueChipView(
  running: boolean,
  queued: number,
): QueueChipView | null {
  if (queued <= 0) return null;
  if (running) {
    return {
      label: `queued: ${queued}`,
      title: "messages waiting for the current turn to finish",
    };
  }
  return {
    label: `parked: ${queued}`,
    title:
      "queued items do not run while the agent is idle — sending a new prompt runs parked follow-ups",
  };
}

/** First omp release with `promote_queued_message` (upstream CHANGELOG 18.4.6). */
export const PROMOTE_QUEUED_MIN_OMP = "18.4.6";

/** Unknown version hides the action: an older runtime rejects the verb. */
export function supportsPromoteQueued(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, PROMOTE_QUEUED_MIN_OMP) >= 0;
}

/**
 * The chip's number. `queue_update` lands immediately while the count waits
 * for a get_state, and live-steered messages are listed but not counted —
 * so show whichever is larger.
 */
export function queueChipCount(session: SessionRuntime): number {
  const q = session.queuedMessages;
  const listed = q === null ? 0 : q.steering.length + q.followUp.length;
  return Math.max(session.queuedMessageCount, listed);
}

/**
 * Queue-chip text is omp-ui's wire message verbatim. Display it the way the
 * transcript does (transcript.ts userContentFromContent): routing suffix,
 * then document block, then resolved mention blocks. Promote still sends the
 * RAW text — omp matches it exactly.
 */
export function queueEntryDisplayText(raw: string): string {
  const routed = stripTrailingAttachmentRoutingContext(raw);
  const { text: docless } = splitDocumentContext(routed);
  return splitResolvedMentionContext(docless).text;
}
