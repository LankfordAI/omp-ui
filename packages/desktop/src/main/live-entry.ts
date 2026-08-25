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
  /** Set by notePlanVerdict; cleared by the next agent_end or (lazily) once
   * lapsed — a check is scheduled at the lapse so quiet sessions lapse too
   * (issue #247). */
  settleSuspendedUntil: number | null;
  /** In-flight pre-kill probe; matched against the response frame's id. */
  probeId: string | null;
  probeResolve: ((state: { parked: number; streaming: boolean } | null) => void) | null;
}

export function liveEntry(
  fields: Omit<
    LiveEntry,
    | "exited"
    | "markExited"
    | "hibernateArmed"
    | "settleSuspendedUntil"
    | "probeId"
    | "probeResolve"
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
    settleSuspendedUntil: null,
    probeId: null,
    probeResolve: null,
  };
}
