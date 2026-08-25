import type {
  OwnedSessionRecord,
  PtyHandle,
  RpcClient,
  SessionMode,
} from "@omp-ui/core";

/**
 * One live session's process handles, exit plumbing, and record — plus the
 * per-concern bookkeeping that has not yet moved to a tracker (issue #297
 * shrinks this bag commit by commit).
 */
export interface LiveEntry {
  kind: SessionMode;
  pty?: PtyHandle;
  rpc?: RpcClient;
  record: OwnedSessionRecord;
  /** Suppresses this process's pty:exit — set for a mode-switch kill and for a delete. */
  suppressExit?: boolean;
  /** Detaches the pty:data listener — a killed process must not write into its successor. */
  detachPtyData?: () => void;
  /** Resolves once the child's exit has been observed. */
  readonly exited: Promise<void>;
  /** Resolver for `exited`, called from the exit handler. */
  readonly markExited: () => void;
  // --- hibernation bookkeeping (issue #246) ---
  /** True once the first frame has arrived; the idle clock arms only then. */
  hibernateArmed: boolean;
  /** agent_start minus agent_end; >0 means a turn is running. */
  turnsRunning: number;
  /** Set by notePlanVerdict; cleared by the next agent_end or (lazily) once
   * lapsed — a check is scheduled at the lapse so quiet sessions lapse too
   * (issue #247). */
  settleSuspendedUntil: number | null;
  /** In-flight pre-kill probe; matched against the response frame's id. */
  probeId: string | null;
  probeResolve: ((state: { parked: number; streaming: boolean } | null) => void) | null;
  // --- stream-stall watchdog bookkeeping (issue #248, reworked in #253) ---
  /** Start of the currently eligible model-stream silence interval. */
  stallSilenceSince: number | null;
  /** Open local tool executions; the silence clock is suspended while > 0. */
  openToolCount: number;
  /** Label of the last model-stream checkpoint, for the abort notice. */
  stallCheckpointLabel: string | null;
  /** Turns this live process has had aborted as stalled; appears in the notice. */
  stallAbortCount: number;
}

export function liveEntry(
  fields: Omit<
    LiveEntry,
    | "exited"
    | "markExited"
    | "hibernateArmed"
    | "turnsRunning"
    | "settleSuspendedUntil"
    | "probeId"
    | "probeResolve"
    | "stallSilenceSince"
    | "openToolCount"
    | "stallCheckpointLabel"
    | "stallAbortCount"
  >,
): LiveEntry {
  // Executor form (not Promise.withResolvers): the node tsconfig lib is
  // ES2022, same convention as advisor-stats-live.test.ts.
  let markExited = (): void => {};
  const exited = new Promise<void>((resolve) => {
    markExited = () => resolve();
  });
  return {
    ...fields,
    exited,
    markExited,
    hibernateArmed: false,
    turnsRunning: 0,
    settleSuspendedUntil: null,
    probeId: null,
    probeResolve: null,
    stallSilenceSince: null,
    openToolCount: 0,
    stallCheckpointLabel: null,
    stallAbortCount: 0,
  };
}
