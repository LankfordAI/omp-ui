// Remote host controls slice tests (issue #1272, omp 19.1): frame construction
// per verb, the version gate, and the rejection latch — including the rule
// that a refused verb is never retried and never re-sent as another verb.
import { beforeEach, describe, expect, it } from "vitest";
import type { CapabilitySnapshot } from "@omp-ui/core/capabilities";
import type { ModelPickerRow } from "@omp-ui/core/host-controls";
import { emptySessionRuntime } from "../../lib/rpc-types";
import { rpcTabState } from "../../test/fixtures";
import { h } from "../../test/store-harness";

const withVersion = (ompVersion: string): CapabilitySnapshot =>
  ({ ompVersion }) as unknown as CapabilitySnapshot;

/** Answers every outstanding command with `data`, so method promises settle.
 *  The shared `h.sent` log is kept intact: assertions read it afterwards. */
const settleAll = async (data: unknown = {}): Promise<void> => {
  for (let wave = 0; wave < 3; wave++) {
    await h.flushMicrotasks();
    for (const { tabId, cmd } of [...h.sent]) h.respond(tabId, cmd, data);
  }
};

const sentOf = (type: string): Record<string, unknown>[] =>
  h.sent.filter(({ cmd }) => cmd.type === type).map(({ cmd }) => cmd);

const useHost = (patch: Parameters<typeof rpcTabState>[0] = {}): void => {
  h.useStore.setState({
    rpc: {
      [h.TAB]: rpcTabState({
        capabilities: withVersion("19.1.0"),
        ...patch,
      }),
    },
  });
};

beforeEach(() => {
  h.backendState = h.stateWithRecord("sess-1");
  h.useStore.setState({ state: h.backendState, rpc: { [h.TAB]: rpcTabState() } });
  h.sent.length = 0;
});

describe("continueRun", () => {
  it("sends resume and re-reads state once the continuation is under way", async () => {
    useHost();
    const promise = h.useStore.getState().continueRun(h.TAB);
    expect(sentOf("resume")).toHaveLength(1);
    await settleAll();
    await expect(promise).resolves.toBe(true);
    // The post-ack get_state re-read settles the running state; no other
    // verb may ride a continue (no prompt/abort fallback).
    const types = h.sent.map(({ cmd }) => cmd.type);
    expect(types).toContain("get_state");
    expect(types).not.toContain("prompt");
    expect(types).not.toContain("abort");
    expect(types).not.toContain("steer");
  });

  it("sends nothing to an omp older than 19.1 and reports refusal", async () => {
    h.useStore.setState({
      rpc: { [h.TAB]: rpcTabState({ capabilities: withVersion("19.0.1") }) },
    });
    await expect(h.useStore.getState().continueRun(h.TAB)).resolves.toBe(false);
    expect(h.sent).toEqual([]);
  });

  it("treats an unknown version as old", async () => {
    useHost({ capabilities: null });
    await expect(h.useStore.getState().continueRun(h.TAB)).resolves.toBe(false);
    expect(h.sent).toEqual([]);
  });

  it("latches off on \"Unknown command\" and sends nothing further — never a fallback", async () => {
    useHost();
    const promise = h.useStore.getState().continueRun(h.TAB);
    h.respond(h.TAB, sentOf("resume")[0]!, "Unknown command: resume", false);
    await expect(promise).resolves.toBe(false);
    expect(h.useStore.getState().rpc[h.TAB]!.hostControlsUnsupported).toBe(true);
    // A second attempt — and the sibling verbs — stay silent.
    await expect(h.useStore.getState().continueRun(h.TAB)).resolves.toBe(false);
    await expect(h.useStore.getState().deliverQueue(h.TAB)).resolves.toBe(false);
    expect(sentOf("resume")).toHaveLength(1);
    expect(sentOf("abort_and_deliver_queue")).toHaveLength(0);
    expect(sentOf("prompt")).toHaveLength(0);
  });

  it("keeps a non-refusal failure on the banner without latching", async () => {
    useHost();
    const promise = h.useStore.getState().continueRun(h.TAB);
    h.respond(h.TAB, sentOf("resume")[0]!, "Nothing to resume", false);
    await expect(promise).resolves.toBe(false);
    expect(h.useStore.getState().rpc[h.TAB]!.hostControlsUnsupported).toBeUndefined();
    expect(h.useStore.getState().rpc[h.TAB]!.failure?.message).toContain("Nothing to resume");
  });

  it("refuses while the tab accepts no commands", async () => {
    useHost({ status: "starting" });
    await expect(h.useStore.getState().continueRun(h.TAB)).resolves.toBe(false);
    expect(h.sent).toEqual([]);
  });
});

describe("deliverQueue", () => {
  it("sends abort_and_deliver_queue; aborted:true re-reads state, with no abort/prompt fallback", async () => {
    useHost();
    const promise = h.useStore.getState().deliverQueue(h.TAB);
    expect(sentOf("abort_and_deliver_queue")).toHaveLength(1);
    await settleAll({ aborted: true });
    await expect(promise).resolves.toBe(true);
    const types = h.sent.map(({ cmd }) => cmd.type);
    expect(types).toContain("get_state");
    expect(types).not.toContain("abort");
    expect(types).not.toContain("prompt");
    expect(types).not.toContain("abort_and_prompt");
  });

  it("treats aborted:false as a success-shaped no-op — the queue did not move", async () => {
    useHost();
    const promise = h.useStore.getState().deliverQueue(h.TAB);
    h.respond(h.TAB, sentOf("abort_and_deliver_queue")[0]!, { aborted: false });
    await expect(promise).resolves.toBe(true);
    await h.flushMicrotasks();
    expect(sentOf("get_state")).toHaveLength(0);
  });

  it("latches off on \"Unknown command\" without retrying or falling back", async () => {
    useHost();
    const promise = h.useStore.getState().deliverQueue(h.TAB);
    h.respond(h.TAB, sentOf("abort_and_deliver_queue")[0]!, "Unknown command: abort_and_deliver_queue", false);
    await expect(promise).resolves.toBe(false);
    expect(h.useStore.getState().rpc[h.TAB]!.hostControlsUnsupported).toBe(true);
    expect(sentOf("abort")).toHaveLength(0);
    expect(sentOf("abort_and_deliver_queue")).toHaveLength(1);
  });

  it("sends nothing to an omp older than 19.1", async () => {
    h.useStore.setState({
      rpc: { [h.TAB]: rpcTabState({ capabilities: withVersion("19.0.1") }) },
    });
    await expect(h.useStore.getState().deliverQueue(h.TAB)).resolves.toBe(false);
    expect(h.sent).toEqual([]);
  });
});

describe("model picker", () => {
  const ROW: ModelPickerRow = { provider: "anthropic", id: "opus", name: "Opus", thinking: ["low", "high"], thinkingLevel: "high" };
  const PAGE = { rows: [ROW], recent: 1, total: 7 };

  it("opens with a blank-query get_model_picker and paints the rows", async () => {
    useHost();
    h.useStore.getState().openHostModelPicker(h.TAB);
    expect(sentOf("get_model_picker")).toEqual([{ type: "get_model_picker", id: sentOf("get_model_picker")[0]!.id }]);
    expect(h.useStore.getState().rpc[h.TAB]!.modelPicker).toMatchObject({ query: "", loading: true });
    h.respond(h.TAB, { id: sentOf("get_model_picker")[0]!.id }, PAGE);
    await h.flushMicrotasks();
    const view = h.useStore.getState().rpc[h.TAB]!.modelPicker;
    expect(view).toMatchObject({ query: "", loading: false, error: null, recent: 1, total: 7 });
    expect(view!.rows).toEqual([ROW]);
  });

  it("re-queries on typing and the latest keystroke owns the view", async () => {
    useHost();
    h.useStore.getState().openHostModelPicker(h.TAB);
    const openCmd = { id: sentOf("get_model_picker")[0]!.id };
    h.useStore.getState().queryModelPicker(h.TAB, "opus");
    h.useStore.getState().queryModelPicker(h.TAB, "opus-5");
    const queries = sentOf("get_model_picker").map((cmd) => cmd.query);
    expect(queries).toEqual([undefined, "opus", "opus-5"]);
    // The stale page for the first query must not paint over the newest one.
    h.respond(h.TAB, openCmd, PAGE);
    await h.flushMicrotasks();
    let view = h.useStore.getState().rpc[h.TAB]!.modelPicker;
    expect(view).toMatchObject({ query: "opus-5", rows: [], loading: true });
    const latest = { id: sentOf("get_model_picker")[2]!.id };
    h.respond(h.TAB, latest, PAGE);
    await h.flushMicrotasks();
    view = h.useStore.getState().rpc[h.TAB]!.modelPicker;
    expect(view).toMatchObject({ query: "opus-5", loading: false });
    expect(view!.rows).toEqual([ROW]);
  });

  it("close clears the view and a late response cannot reopen it", async () => {
    useHost();
    h.useStore.getState().openHostModelPicker(h.TAB);
    const openCmd = { id: sentOf("get_model_picker")[0]!.id };
    h.useStore.getState().closeHostModelPicker(h.TAB);
    expect(h.useStore.getState().rpc[h.TAB]!.modelPicker).toBeUndefined();
    h.respond(h.TAB, openCmd, PAGE);
    await h.flushMicrotasks();
    expect(h.useStore.getState().rpc[h.TAB]!.modelPicker).toBeUndefined();
  });

  it("an omp without the verb shows the update hint, latches off, and sends nothing further", async () => {
    useHost();
    h.useStore.getState().openHostModelPicker(h.TAB);
    h.respond(h.TAB, sentOf("get_model_picker")[0]!, "Unknown command: get_model_picker", false);
    await h.flushMicrotasks();
    const view = h.useStore.getState().rpc[h.TAB]!.modelPicker;
    expect(view?.error).toContain("update omp to 19.1.0");
    expect(view?.loading).toBe(false);
    expect(h.useStore.getState().rpc[h.TAB]!.hostControlsUnsupported).toBe(true);
    h.useStore.getState().queryModelPicker(h.TAB, "opus");
    await h.flushMicrotasks();
    expect(sentOf("get_model_picker")).toHaveLength(1);
  });

  it("an old host never receives get_model_picker, even when the dialog opens", async () => {
    h.useStore.setState({
      rpc: { [h.TAB]: rpcTabState({ capabilities: withVersion("19.0.1") }) },
    });
    h.useStore.getState().openHostModelPicker(h.TAB);
    await h.flushMicrotasks();
    expect(sentOf("get_model_picker")).toHaveLength(0);
    expect(h.useStore.getState().rpc[h.TAB]!.modelPicker?.error).toContain("update omp to 19.1.0");
  });

  it("picks a model row through set_model, persists the selector, and closes the dialog", async () => {
    useHost();
    const promise = h.useStore.getState().pickModelRow(h.TAB, ROW);
    expect(sentOf("set_model")).toEqual([
      { type: "set_model", provider: "anthropic", modelId: "opus", id: sentOf("set_model")[0]!.id },
    ]);
    await settleAll({ provider: "anthropic", id: "opus", name: "Opus" });
    await expect(promise).resolves.toBe(true);
    expect(h.mockBackend.setSessionModel).toHaveBeenCalledWith(h.TAB, "anthropic/opus", null);
    expect(h.useStore.getState().rpc[h.TAB]!.model).toMatchObject({ id: "opus" });
    expect(h.useStore.getState().rpc[h.TAB]!.modelPicker).toBeUndefined();
  });

  it("a quick-role row's role rides set_model and its explicit level persists", async () => {
    useHost();
    const roleRow: ModelPickerRow = { provider: "gate", id: "gaterati", name: "Gaterati", role: "advisor", thinkingLevel: "low" };
    const promise = h.useStore.getState().pickModelRow(h.TAB, roleRow);
    expect(sentOf("set_model")[0]).toMatchObject({ provider: "gate", modelId: "gaterati", role: "advisor" });
    await settleAll({ provider: "gate", id: "gaterati", name: "Gaterati" });
    await expect(promise).resolves.toBe(true);
    expect(h.mockBackend.setSessionModel).toHaveBeenCalledWith(h.TAB, "gate/gaterati", "low");
  });

  it("an explicit slider level rides the frame and wins the persisted record", async () => {
    useHost();
    const promise = h.useStore.getState().pickModelRow(h.TAB, ROW, "low");
    expect(sentOf("set_model")[0]).toMatchObject({ provider: "anthropic", modelId: "opus", thinkingLevel: "low" });
    await settleAll({ provider: "anthropic", id: "opus", name: "Opus" });
    await expect(promise).resolves.toBe(true);
    expect(h.mockBackend.setSessionModel).toHaveBeenCalledWith(h.TAB, "anthropic/opus", "low");
  });

  it("persists the auto selector, not the resolved level, when the session runs on auto", async () => {
    useHost({
      session: { ...emptySessionRuntime(), thinkingLevel: "high", thinkingConfigured: "auto" },
    });
    const promise = h.useStore.getState().pickModelRow(h.TAB, ROW);
    await settleAll({ provider: "anthropic", id: "opus", name: "Opus" });
    await expect(promise).resolves.toBe(true);
    // The row's slider value must not freeze the auto session to "high".
    expect(sentOf("set_model")[0]).not.toHaveProperty("thinkingLevel");
    expect(h.mockBackend.setSessionModel).toHaveBeenCalledWith(h.TAB, "anthropic/opus", "auto");
  });

  it("latches off when set_model comes back Unknown command", async () => {
    useHost();
    const promise = h.useStore.getState().pickModelRow(h.TAB, ROW);
    h.respond(h.TAB, sentOf("set_model")[0]!, "Unknown command: set_model", false);
    await expect(promise).resolves.toBe(false);
    expect(h.useStore.getState().rpc[h.TAB]!.hostControlsUnsupported).toBe(true);
    expect(h.mockBackend.setSessionModel).not.toHaveBeenCalled();
  });

  it("refuses the picker verbs before the gate opens", async () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ capabilities: withVersion("19.0.1") }) } });
    await expect(h.useStore.getState().pickModelRow(h.TAB, ROW)).resolves.toBe(false);
    expect(sentOf("set_model")).toHaveLength(0);
  });
});
