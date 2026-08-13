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
