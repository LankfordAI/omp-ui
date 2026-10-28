import type {
  CapabilitySnapshot,
  ModelHold,
  OwnedSessionRecord,
  PtyHandle,
  RpcClient,
} from "@omp-ui/core";

const NOOP_DETACH_PTY_DATA = (): void => {};

export interface LiveEntryBase {
  record: OwnedSessionRecord;
  /** Suppresses this process's exit — set for a mode-switch kill, a delete, a hibernation, and the quit-time killAll. */
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
  /** Latest capability snapshot the bridge published; null until the first valid frame. */
  capabilities: CapabilitySnapshot | null;
  /** True when this spawn successfully wrote (and armed) the capabilities bridge. */
  capabilitiesBridgeLoaded: boolean;
  /** False when plan mode could not be installed for this process. */
  planBridgeLoaded: boolean;
  /** False when advisor accounting could not be installed for this process. */
  advisorStatsBridgeLoaded: boolean;
  /** True when this spawn minted the browser pane's bridge endpoint and armed the extension (#519). */
  browserPaneArmed: boolean;
  /** Set when this spawn booted unpinned because the pinned model's endpoint did not answer (#932); cleared by a successful set_model. */
  modelHold: ModelHold | null;
  /** Ids of set_model commands sent while held; a successful response to one lifts the hold. */
  readonly modelHoldPicks: Set<string>;
  /** True when this spawn wrote the fleet-wake bridge (ADR-0069). */
  fleetWakeBridgeLoaded: boolean;
  /** Wake ids already armed on this process; each staged wake is handed over once per process. */
  readonly fleetWakeSent: Set<string>;
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
  return {
    ...createLiveEntryBase(record),
    kind: "rpc-ui",
    rpc: null,
    capabilities: null,
    capabilitiesBridgeLoaded: false,
    planBridgeLoaded: false,
    advisorStatsBridgeLoaded: false,
    browserPaneArmed: false,
    modelHold: null,
    modelHoldPicks: new Set(),
    fleetWakeBridgeLoaded: false,
    fleetWakeSent: new Set(),
  };
}

export function wireRpc(entry: RpcLiveEntry, rpc: RpcClient): void {
  if (entry.rpc !== null) throw new Error("rpc live entry is already wired");
  entry.rpc = rpc;
}
