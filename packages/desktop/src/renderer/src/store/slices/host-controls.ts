// Remote host controls (issue #1272, omp 19.1): continue / interrupt-and-deliver-queue
// and omp's own model picker (`get_model_picker` → `set_model`) for sessions this
// app steers remotely — joined remote-instance tabs, fleet dispatch targets — the
// surfaces whose composer already rides `rpc:send` to the owning host.
//
// Rejection discipline (docs/rpc.md): an omp without these verbs answers
// `Unknown command: <type>`. The first such answer latches the tab's control
// off (`hostControlsUnsupported`) until the process is replaced — nothing is
// ever retried with a fallback verb, because a `prompt`/`steer` retry would
// duplicate work omp already queued. Never fall back; never re-send.
import {
  HOST_CONTROLS_MIN_OMP,
  modelPickerCommand,
  parseDeliverQueueResult,
  parseModelPickerResult,
  setModelFromRowCommand,
  supportsHostControls,
  type ModelPickerRow,
} from "@omp-ui/core/host-controls";
import { parseModelInfo } from "../../lib/rpc-types";
import type { ModelPickerView } from "../../lib/host-controls";
import { backend } from "../../backend";
import type { UiStore } from "../types";
import { respData, RpcCommandAbandonedError, type GetState, type StoreMachinery } from "./shared";

/** omp's dispatch answer for a verb its build does not know (rpc-mode.ts). */
const UNKNOWN_COMMAND_PREFIX = "Unknown command:";

/** The hint every refused host-control shows: the verbs shipped together in
 *  omp 19.1, so one sentence serves continue, deliver-queue, and the picker. */
export const HOST_CONTROLS_UPDATE_HINT = `this omp has no remote host controls — update omp to ${HOST_CONTROLS_MIN_OMP} or later`;

export type HostControlsSlice = Pick<
  UiStore,
  | "continueRun"
  | "deliverQueue"
  | "openHostModelPicker"
  | "closeHostModelPicker"
  | "queryModelPicker"
  | "pickModelRow"
>;

export function createHostControlsSlice(
  get: GetState,
  m: StoreMachinery,
): HostControlsSlice {
  /** Latch the tab's host controls off for this process lifetime. */
  const latchUnsupported = (tabId: string): void => {
    m.patchRpc(tabId, { hostControlsUnsupported: true });
  };

  /** True when the tab already refused one of these verbs this process. */
  const latched = (tabId: string): boolean =>
    get().rpc[tabId]?.hostControlsUnsupported === true;

  /**
   * The gate before the send, exactly as `abortAgent` picks its verb from
   * the host version (issue #776's discipline): an omp the roster reports as
   * older than 19.1 never sees a command it would only reject, and an
   * unknown version is treated as old. The latch covers the reverse lie — a
   * runtime that claims 19.1 but answers `Unknown command`.
   */
  const gateOpen = (tabId: string): boolean =>
    supportsHostControls(get().rpc[tabId]?.capabilities?.ompVersion ?? null);

  /** Send permission: gated, not yet latched by a refusal. */
  const allowed = (tabId: string): boolean => !latched(tabId) && gateOpen(tabId);

  /**
   * `runCommand` swallows the failure text into the tab's banner; this reads
   * the banner back so an old-host refusal can latch the control, while every
   * other failure keeps surfacing there unchanged.
   */
  const refusedUnknown = (tabId: string, command: string): boolean => {
    const failure = get().rpc[tabId]?.failure;
    return (
      failure?.command === command &&
      failure.message.includes(UNKNOWN_COMMAND_PREFIX)
    );
  };

  const continueRun = async (tabId: string): Promise<boolean> => {
    if (!m.acceptsCommands(tabId) || !allowed(tabId)) return false;
    const response = await m.runCommand(tabId, { type: "resume" });
    if (response === null) {
      if (refusedUnknown(tabId, "resume")) latchUnsupported(tabId);
      return false;
    }
    // omp answers once the continuation is under way; re-read so the tab's
    // running state settles without waiting for the next pushed frame.
    void get().refreshState(tabId);
    return true;
  };

  const deliverQueue = async (tabId: string): Promise<boolean> => {
    if (!m.acceptsCommands(tabId) || !allowed(tabId)) return false;
    const response = await m.runCommand(tabId, { type: "abort_and_deliver_queue" });
    if (response === null) {
      if (refusedUnknown(tabId, "abort_and_deliver_queue")) latchUnsupported(tabId);
      return false;
    }
    // `aborted: false` is a success-shaped no-op (nothing streaming or
    // queued): say nothing and re-read nothing — the queue did not move. A
    // real interrupt-and-deliver settles the chip and the running state, so
    // only then does the tab re-read.
    if (parseDeliverQueueResult(respData(response)) === true) void get().refreshState(tabId);
    return true;
  };

  const openHostModelPicker = (tabId: string): void => {
    if (get().rpc[tabId] === undefined) return;
    const view: ModelPickerView = { query: "", rows: [], recent: 0, total: 0, loading: true, error: null };
    m.patchRpc(tabId, { modelPicker: view });
    void fetchPage(tabId, "");
  };

  const closeHostModelPicker = (tabId: string): void => {
    if (get().rpc[tabId]?.modelPicker === undefined) return;
    m.patchRpc(tabId, { modelPicker: undefined });
  };

  const queryModelPicker = (tabId: string, query: string): void => {
    const current = get().rpc[tabId]?.modelPicker;
    if (current === undefined) return;
    if (current.query === query && current.loading) return;
    m.patchRpc(tabId, { modelPicker: { ...current, query, loading: true, error: null } });
    void fetchPage(tabId, query);
  };

  /** One `get_model_picker` page. The latest keystroke owns the view: a
   *  response whose query no longer matches the tab's is dropped. */
  const fetchPage = async (tabId: string, query: string): Promise<void> => {
    if (!allowed(tabId)) {
      settlePickerError(tabId, query, HOST_CONTROLS_UPDATE_HINT);
      return;
    }
    try {
      const resp = await get().rpcCommand(tabId, modelPickerCommand(query), { quiet: true });
      if (get().rpc[tabId]?.modelPicker?.query !== query) return;
      const result = parseModelPickerResult(respData(resp));
      if (result === null) {
        settlePickerError(tabId, query, "the host returned no picker rows");
        return;
      }
      m.patchRpc(tabId, {
        modelPicker: { query, rows: result.rows, recent: result.recent, total: result.total, loading: false, error: null },
      });
    } catch (err) {
      if (err instanceof RpcCommandAbandonedError) return;
      const message = err instanceof Error ? err.message : String(err);
      if (message.startsWith(UNKNOWN_COMMAND_PREFIX)) {
        latchUnsupported(tabId);
        settlePickerError(tabId, query, HOST_CONTROLS_UPDATE_HINT);
        return;
      }
      settlePickerError(tabId, query, message);
    }
  };

  const settlePickerError = (tabId: string, query: string, error: string): void => {
    const current = get().rpc[tabId]?.modelPicker;
    if (current === undefined || current.query !== query) return;
    m.patchRpc(tabId, { modelPicker: { ...current, loading: false, error } });
  };

  const pickModelRow = async (
    tabId: string,
    row: ModelPickerRow,
    thinkingLevel?: string,
  ): Promise<boolean> => {
    if (!m.acceptsCommands(tabId) || !allowed(tabId)) return false;
    // A quick-role row carries `role`, which `set_model` takes back, and a
    // slider-chip pick names the level to run at; model rows otherwise ride
    // provider/modelId alone (docs/rpc.md).
    const response = await m.runCommand(tabId, setModelFromRowCommand(row, thinkingLevel));
    if (response === null) {
      if (refusedUnknown(tabId, "set_model")) latchUnsupported(tabId);
      return false;
    }
    const selected = parseModelInfo(respData(response));
    if (selected !== null) m.patchRpc(tabId, { model: selected });
    // Persist the selector for the session and its project exactly like
    // `setModel` does — under auto the SELECTOR persists, never the resolved
    // level; a role row's explicit level wins because that is what the pick
    // asked omp to run at. The picker row names what was asked for; omp's
    // response names what it actually runs — persist the running truth.
    const session = get().rpc[tabId]?.session;
    const selector = selected !== null ? `${selected.provider}/${selected.id}` : `${row.provider}/${row.id}`;
    const level =
      thinkingLevel !== undefined && thinkingLevel !== ""
        ? thinkingLevel
        : row.role !== undefined && row.thinkingLevel !== undefined
          ? row.thinkingLevel
          : session?.thinkingConfigured === "auto"
            ? "auto"
            : session?.thinkingLevel ?? null;
    await backend.setSessionModel(tabId, selector, level);
    m.patchRpc(tabId, { modelPicker: undefined });
    void get().refreshState(tabId);
    return true;
  };

  return { continueRun, deliverQueue, openHostModelPicker, closeHostModelPicker, queryModelPicker, pickModelRow };
}
