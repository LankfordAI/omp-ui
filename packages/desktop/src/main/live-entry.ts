import type {
  OwnedSessionRecord,
  PtyHandle,
  RpcClient,
} from "@omp-ui/core";

const NOOP_DETACH_PTY_DATA = (): void => {};

export interface LiveEntryBase {
  record: OwnedSessionRecord;
  /** Suppresses this process's exit — set for a mode-switch kill and for a delete. */
  suppressExit?: boolean;
  /** Resolves once the child's exit has been observed. */
  readonly exited: Promise<void>;
  /** Resolver for `exited`, called from the exit handler. */
  readonly markExited: () => void;
}

export interface PtyLiveEntry extends LiveEntryBase {
  readonly kind: "pty";
  readonly pty: PtyHandle;
  /** Detaches the pty:data listener — a killed process must not write into its successor. */
  detachPtyData: () => void;
}

export interface RpcLiveEntry extends LiveEntryBase {
  readonly kind: "rpc-ui";
  rpc: RpcClient | null;
}

export type LiveEntry = PtyLiveEntry | RpcLiveEntry;

function createLiveEntryBase(record: OwnedSessionRecord): LiveEntryBase {
  // Executor form (not Promise.withResolvers): the node tsconfig lib is
  // ES2022, same convention as advisor-stats-live.test.ts.
  let markExited = (): void => {};
  const exited = new Promise<void>((resolve) => {
    markExited = () => resolve();
  });
  return { record, exited, markExited };
}

export function createPtyLiveEntry(
  record: OwnedSessionRecord,
  pty: PtyHandle,
): PtyLiveEntry {
  return {
    ...createLiveEntryBase(record),
    kind: "pty",
    pty,
    detachPtyData: NOOP_DETACH_PTY_DATA,
  };
}

export function wirePtyData(
  entry: PtyLiveEntry,
  pty: PtyHandle,
  send: (data: Buffer) => void,
): void {
  entry.detachPtyData = pty.onData(send);
}

export function createRpcLiveEntry(record: OwnedSessionRecord): RpcLiveEntry {
  return { ...createLiveEntryBase(record), kind: "rpc-ui", rpc: null };
}

export function wireRpc(entry: RpcLiveEntry, rpc: RpcClient): void {
  if (entry.rpc !== null) throw new Error("rpc live entry is already wired");
  entry.rpc = rpc;
}
