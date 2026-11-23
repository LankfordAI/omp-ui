import { useState } from "react";
import { supportsHostControls } from "@omp-ui/core/host-controls";
import { queueChipCount } from "../lib/queue-chip";
import { findOwner, useStore } from "../store";
import { HOST_CONTROLS_UPDATE_HINT } from "../store/slices/host-controls";
import { Chip } from "./ui";

/**
 * Continue / interrupt-and-deliver-queue for sessions steered through another
 * host (issue #1272): the remote composer's two run verbs, riding omp 19.1's
 * `resume` and `abort_and_deliver_queue` to the owning instance. They appear
 * where the host's TUI shortcuts are out of reach but its composer already is
 * — a joined remote tab (fleet dispatch targets included): Continue for a run
 * parked idle, paused on background work, or waiting unanswered; Deliver-queue
 * (the TUI's empty Enter) while a turn streams and input queues behind it.
 *
 * Version-gated like the queue chip's promote/edit: an omp older than 19.1
 * sees no send at all, and once the host has answered "Unknown command" the
 * pair stays mounted but disabled with the upgrade hint. A refused verb is
 * never retried and never re-sent as `abort` + `prompt` — that would
 * duplicate work omp already queued (docs/rpc.md).
 */
export function HostRunControls({ tabId, disabled }: { tabId: string; disabled: boolean }) {
  const instanceId = useStore((s) => findOwner(s.state, tabId)?.instanceId ?? null);
  const running = useStore((s) => s.rpc[tabId]?.status === "running");
  const awaitingWork = useStore((s) => s.rpc[tabId]?.awaitingAsyncWork === true);
  const ompVersion = useStore((s) => s.rpc[tabId]?.capabilities?.ompVersion ?? null);
  const latched = useStore((s) => s.rpc[tabId]?.hostControlsUnsupported === true);
  const queued = useStore((s) => {
    const session = s.rpc[tabId]?.session;
    return session ? queueChipCount(session) : 0;
  });
  const continueRun = useStore((s) => s.continueRun);
  const deliverQueue = useStore((s) => s.deliverQueue);
  // One verb at a time: both settle on omp's ack, and a double click could
  // stack two continuations behind the same queued input.
  const [pending, setPending] = useState<null | "continue" | "deliver">(null);

  if (instanceId === null) return null;
  const gated = supportsHostControls(ompVersion);
  if (!gated && !latched) return null;
  const blocked = latched || disabled || pending !== null;
  // One affordance at a time, matching what the session needs right now:
  // Deliver-queue owns a streaming turn with parked input (the TUI's empty
  // Enter); Continue owns the parked moments — idle, or the run paused with
  // only background work able to wake it. A streaming turn with nothing
  // queued belongs to Stop, and neither verb shows there.
  const deliverVisible = running && queued > 0;
  const continueVisible = !deliverVisible && (!running || awaitingWork);
  if (!continueVisible && !deliverVisible) return null;

  const act = (verb: "continue" | "deliver"): void => {
    setPending(verb);
    void (verb === "continue" ? continueRun(tabId) : deliverQueue(tabId)).finally(() =>
      setPending(null),
    );
  };
  const hint = latched ? HOST_CONTROLS_UPDATE_HINT : undefined;

  return (
    <span className="flex min-w-0 shrink items-center gap-1" title={hint}>
      {continueVisible && (
        <button
          type="button"
          disabled={blocked}
          title={
            hint ??
            (running
              ? "continue the agent (omp's . / c) — a running turn is interrupted first, and queued input continues the run instead"
              : "continue the parked run (omp's . / c); a prompt the model has not answered runs again as is")
          }
          onClick={() => act("continue")}
          className={"rounded " + (blocked ? "cursor-not-allowed opacity-60" : "")}
        >
          <Chip mono tone="signal">
            {pending === "continue" ? "continue…" : "continue"}
          </Chip>
        </button>
      )}
      {deliverVisible && (
        <button
          type="button"
          disabled={blocked}
          title={
            hint ??
            "interrupt the streaming turn and continue it with the queued input now (the TUI's empty Enter) — a no-op while nothing is queued"
          }
          onClick={() => act("deliver")}
          className={"rounded " + (blocked ? "cursor-not-allowed opacity-60" : "")}
        >
          <Chip mono tone="copper">
            {pending === "deliver" ? "delivering…" : "deliver queue"}
          </Chip>
        </button>
      )}
    </span>
  );
}
