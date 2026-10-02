// The Agents pane's steer/kill verbs (issues #684, #713): each rides omp's
// native rpc command, and its response alone settles it.
import { beforeEach, describe, expect, it } from "vitest";
import { rpcTabState, tabInfo } from "../../test/fixtures";
import { h } from "../../test/store-harness";

const runtime = () => h.useStore.getState().rpc[h.TAB];
const sentOf = (type: string) =>
  h.sent.filter(({ cmd }) => cmd.type === type).map(({ cmd }) => cmd);

beforeEach(() => {
  h.backendState = h.stateWithRecord("sess-1");
  h.sent.length = 0;
  h.useStore.setState({
    state: h.backendState,
    tabs: [tabInfo({ tabId: h.TAB, mode: "rpc-ui" })],
    rpc: { [h.TAB]: rpcTabState() },
  });
});

describe("subagent control verbs (issue #713)", () => {
  it("steer sends one trimmed steer_subagent, holds busy until its response, and adds no row", async () => {
    const promise = h.useStore.getState().steerSubagent(h.TAB, "agent-1", "  try the other route ");
    const [cmd] = sentOf("steer_subagent");
    expect(cmd).toMatchObject({ subagentId: "agent-1", message: "try the other route" });
    expect(runtime()?.subagentControlBusy).toEqual({ "agent-1": "steer" });
    h.respond(h.TAB, cmd!, undefined);
    await promise;
    expect(runtime()?.subagentControlBusy).toEqual({});
    expect(runtime()?.subagentControlError).toBeNull();
    expect(runtime()?.items).toEqual([]);
    expect(sentOf("prompt")).toEqual([]);
  });

  it("kill sends cancel_subagent and re-reads the roster only after it settles", async () => {
    const promise = h.useStore.getState().killSubagent(h.TAB, "agent-1");
    expect(sentOf("get_subagents")).toEqual([]);
    h.respond(h.TAB, sentOf("cancel_subagent")[0]!, { cancelled: true });
    await promise;
    expect(sentOf("cancel_subagent")[0]).toMatchObject({ subagentId: "agent-1" });
    expect(sentOf("get_subagents")).toHaveLength(1);
  });

  it("an agent omp no longer runs (cancelled: false) settles without a notice", async () => {
    const promise = h.useStore.getState().killSubagent(h.TAB, "agent-1");
    h.respond(h.TAB, sentOf("cancel_subagent")[0]!, { cancelled: false });
    await promise;
    expect(runtime()?.subagentControlError).toBeNull();
  });

  it("shows omp's refusal sentence verbatim", async () => {
    const promise = h.useStore.getState().steerSubagent(h.TAB, "agent-1", "go");
    h.respond(h.TAB, sentOf("steer_subagent")[0]!, "Subagent not running: agent-1", false);
    await promise;
    expect(runtime()?.subagentControlError).toBe("Subagent not running: agent-1");
    expect(runtime()?.subagentControlBusy).toEqual({});
  });

  it("an omp without the verb gets the update hint and no fallback frame", async () => {
    const promise = h.useStore.getState().steerSubagent(h.TAB, "agent-1", "go");
    h.respond(h.TAB, sentOf("steer_subagent")[0]!, "Unknown command: steer_subagent", false);
    await promise;
    expect(runtime()?.subagentControlError).toContain("18.4.9");
    expect(h.sent.map(({ cmd }) => cmd.type)).toEqual(["steer_subagent"]);
  });

  it("an empty steer sends nothing", async () => {
    await h.useStore.getState().steerSubagent(h.TAB, "agent-1", "   ");
    expect(h.sent).toEqual([]);
  });

  it("refuses a second verb for the same agent while one is in flight", async () => {
    const promise = h.useStore.getState().killSubagent(h.TAB, "agent-1");
    await h.useStore.getState().steerSubagent(h.TAB, "agent-1", "too soon");
    expect(sentOf("steer_subagent")).toEqual([]);
    h.respond(h.TAB, sentOf("cancel_subagent")[0]!, { cancelled: true });
    await promise;
  });

  it("clears a stale failure when a new dispatch starts", async () => {
    const first = h.useStore.getState().steerSubagent(h.TAB, "agent-1", "go");
    h.respond(h.TAB, sentOf("steer_subagent")[0]!, "Subagent not running: agent-1", false);
    await first;
    const second = h.useStore.getState().killSubagent(h.TAB, "agent-1");
    expect(runtime()?.subagentControlError).toBeNull();
    h.respond(h.TAB, sentOf("cancel_subagent")[0]!, { cancelled: true });
    await second;
  });
});
