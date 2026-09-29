import { describe, expect, it, vi, afterEach } from "vitest";
import { PLAN_REVIEW_SENTINEL, type RpcFrame } from "@omp-ui/core";
import { HostBridge, HOST_ANSWER_WATCHDOG_MS, type HostBridgeDeps } from "./host-bridge";
import type { ConfinedPlanRead } from "./plan-file";

const PLAN_ABS = "/sessions/lineage/plan-abc-plan.md";

function reviewFrame(planAbsPath: string | null): RpcFrame {
  const payload: Record<string, unknown> = { title: "Ship it", planFilePath: "local://plan-abc-plan.md" };
  if (planAbsPath !== null) payload.planAbsPath = planAbsPath;
  return {
    type: "extension_ui_request",
    id: "e1",
    method: "select",
    title: PLAN_REVIEW_SENTINEL + JSON.stringify(payload),
  };
}

function toolCallFrame(id: string, toolName: string, args: unknown): RpcFrame {
  return { type: "host_tool_call", id, toolCallId: `tc-${id}`, toolName, arguments: args };
}

function uriRequestFrame(id: string, url: string, operation: "read" | "write" = "read"): RpcFrame {
  return { type: "host_uri_request", id, operation, url };
}

interface Fixture {
  bridge: HostBridge;
  sent: RpcFrame[];
  send: (frame: RpcFrame) => void;
  notices: { tabId: string; title: string | null; message: string }[];
  reads: { root: string; absPath: string }[];
  setRead: (read: ConfinedPlanRead) => void;
  setSnapshot: (snapshot: { text: string; sourceHash: string } | null) => void;
  setPlanRoot: (root: string | null) => void;
  setCapabilitySession: (sessionId: string | null) => void;
}

function fixture(): Fixture {
  const sent: RpcFrame[] = [];
  const notices: { tabId: string; title: string | null; message: string }[] = [];
  const reads: { root: string; absPath: string }[] = [];
  let read: ConfinedPlanRead = { ok: true, text: "# plan", sourceHash: "f".repeat(64), bytes: 6 };
  let snapshot: { text: string; sourceHash: string } | null = null;
  let planRoot: string | null = "/sessions/lineage";
  let capabilitySessionId: string | null = null;
  const deps: HostBridgeDeps = {
    readPlanFile: async (root, absPath) => {
      reads.push({ root, absPath });
      return read;
    },
    planSnapshot: () => snapshot,
    planRoot: () => planRoot,
    notify: (tabId, title, message) => {
      notices.push({ tabId, title, message });
      return "posted";
    },
    capabilitySessionId: () => capabilitySessionId,
    log: () => {},
  };
  return {
    bridge: new HostBridge(deps),
    sent,
    send: (frame) => sent.push(frame),
    notices,
    reads,
    setRead: (next) => {
      read = next;
    },
    setSnapshot: (next) => {
      snapshot = next;
    },
    setPlanRoot: (next) => {
      planRoot = next;
    },
    setCapabilitySession: (next) => {
      capabilitySessionId = next;
    },
  };
}

/** One microtask flush settles the resolvers' awaits. */
async function settled(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("HostBridge.notify", () => {
  it("answers the tool call once with the posted text", async () => {
    const f = fixture();
    expect(
      f.bridge.route("t1", toolCallFrame("h1", "omp-ui_notify", { message: "  build done  " }), f.send),
    ).toBe(true);
    await settled();
    expect(f.notices).toEqual([{ tabId: "t1", title: null, message: "  build done  " }]);
    expect(f.sent).toEqual([
      { type: "host_tool_result", id: "h1", result: { content: [{ type: "text", text: "posted" }] } },
    ]);
  });

  it("passes an explicit title through", async () => {
    const f = fixture();
    f.bridge.route("t1", toolCallFrame("h1", "omp-ui_notify", { message: "x", title: "Heads up" }), f.send);
    await settled();
    expect(f.notices[0].title).toBe("Heads up");
  });

  it("refuses an unknown tool with an error result", async () => {
    const f = fixture();
    f.bridge.route("t1", toolCallFrame("h1", "evil_tool", {}), f.send);
    await settled();
    expect(f.sent[0]).toMatchObject({ type: "host_tool_result", id: "h1", isError: true });
    expect(JSON.stringify(f.sent[0])).toContain("evil_tool");
  });

  it("refuses a missing or blank message", async () => {
    const f = fixture();
    f.bridge.route("t1", toolCallFrame("h1", "omp-ui_notify", {}), f.send);
    f.bridge.route("t1", toolCallFrame("h2", "omp-ui_notify", { message: "   " }), f.send);
    await settled();
    expect(f.sent).toHaveLength(2);
    for (const frame of f.sent) expect(frame).toMatchObject({ isError: true });
    expect(f.notices).toHaveLength(0);
  });

  it("reports a throwing notifier as an error result", async () => {
    const sent: RpcFrame[] = [];
    const bridge = new HostBridge({
      ...fixtureDeps(),
      notify: () => {
        throw new Error("dbus down");
      },
    });
    bridge.route("t1", toolCallFrame("h1", "omp-ui_notify", { message: "x" }), (frame) => sent.push(frame));
    await settled();
    expect(sent[0]).toMatchObject({ type: "host_tool_result", id: "h1", isError: true });
  });
});

describe("HostBridge omp-ui://plan", () => {
  it("answers no-plan-before-any-proposal", async () => {
    const f = fixture();
    f.bridge.route("t1", uriRequestFrame("u1", "omp-ui://plan"), f.send);
    await settled();
    expect(f.sent[0]).toMatchObject({
      type: "host_uri_result",
      id: "u1",
      isError: true,
      error: "no plan has been proposed for this session yet",
    });
  });

  it("serves the captured plan file through the confined reader", async () => {
    const f = fixture();
    f.bridge.noteFrame("t1", reviewFrame(PLAN_ABS));
    f.bridge.route("t1", uriRequestFrame("u1", "omp-ui://plan"), f.send);
    await settled();
    expect(f.reads).toEqual([{ root: "/sessions/lineage", absPath: PLAN_ABS }]);
    expect(f.sent[0]).toEqual({
      type: "host_uri_result",
      id: "u1",
      content: "# plan",
      contentType: "text/markdown",
    });
  });

  it("prefers the validated snapshot while a gate holds the plan", async () => {
    const f = fixture();
    f.bridge.noteFrame("t1", reviewFrame(PLAN_ABS));
    f.setSnapshot({ text: "<html>validated</html>", sourceHash: "a".repeat(64) });
    f.bridge.route("t1", uriRequestFrame("u1", "omp-ui://plan"), f.send);
    await settled();
    expect(f.reads).toHaveLength(0);
    expect(f.sent[0]).toMatchObject({ content: "<html>validated</html>" });
  });

  it("maps a confined-read failure to an error result naming the reason", async () => {
    const f = fixture();
    f.bridge.noteFrame("t1", reviewFrame(PLAN_ABS));
    f.setRead({ ok: false, reason: "outside" });
    f.bridge.route("t1", uriRequestFrame("u1", "omp-ui://plan"), f.send);
    await settled();
    expect(f.sent[0]).toMatchObject({ isError: true, error: "the plan file could not be read (outside)" });
  });

  it("answers unreadable when the record is gone", async () => {
    const f = fixture();
    f.bridge.noteFrame("t1", reviewFrame(PLAN_ABS));
    f.setPlanRoot(null);
    f.bridge.route("t1", uriRequestFrame("u1", "omp-ui://plan"), f.send);
    await settled();
    expect(f.sent[0]).toMatchObject({ isError: true, error: "the plan file could not be read (unreadable)" });
  });

  it("refuses unknown schemes and resources, and any write", async () => {
    const f = fixture();
    f.bridge.route("t1", uriRequestFrame("u1", "local://x/y.md"), f.send);
    f.bridge.route("t1", uriRequestFrame("u2", "omp-ui://settings"), f.send);
    f.bridge.route("t1", uriRequestFrame("u3", "omp-ui://plan", "write"), f.send);
    await settled();
    expect(f.sent[0]).toMatchObject({ isError: true, error: 'omp-ui registers no scheme "local://"' });
    expect(f.sent[1]).toMatchObject({ isError: true, error: 'unknown omp-ui resource "settings"; available: plan' });
    expect(f.sent[2]).toMatchObject({ isError: true, error: "the omp-ui:// scheme is read-only" });
  });

  it("clears the plan when the live session changes identity (#374 rule)", () => {
    const f = fixture();
    f.bridge.noteFrame("t1", reviewFrame(PLAN_ABS));
    f.setCapabilitySession("session-a");
    // Same session id: nothing changed, the plan survives.
    f.bridge.noteFrame("t1", { type: "session_info_update", sessionId: "session-a" });
    expect(f.bridge.planPath("t1")).toBe(PLAN_ABS);
    // A different id: the plan belonged to the predecessor.
    f.bridge.noteFrame("t1", { type: "session_info_update", sessionId: "session-b" });
    expect(f.bridge.planPath("t1")).toBeNull();
  });
});

describe("HostBridge exactly-one-result discipline", () => {
  it("marks the id answered synchronously, before any await settles", () => {
    const f = fixture();
    // The renderer stub can answer the moment the frame reaches it: the
    // rpcSend fence must already see the id when route() returns.
    f.bridge.route("t1", uriRequestFrame("u1", "omp-ui://plan"), f.send);
    expect(f.bridge.answeredIds("t1").has("u1")).toBe(true);
  });

  it("settles a cancel silently and answers nothing late", async () => {
    const sent: RpcFrame[] = [];
    // Executor form: the node tsconfig lib predates ES2024. The read must
    // still be pending when the cancel arrives — a settled answer would
    // already have left the pending map the cancel targets.
    const bridge = new HostBridge({
      ...fixtureDeps(),
      readPlanFile: () => new Promise<ConfinedPlanRead>(() => {}),
    });
    bridge.noteFrame("t1", reviewFrame(PLAN_ABS));
    bridge.route("t1", uriRequestFrame("u1", "omp-ui://plan"), (frame) => sent.push(frame));
    bridge.route("t1", { type: "host_uri_cancel", id: "c1", targetId: "u1" }, (frame) => sent.push(frame));
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(sent).toHaveLength(0);
    // The cancelled id stays fenced so the renderer stub cannot answer late.
    expect(bridge.answeredIds("t1").has("u1")).toBe(true);
  });

  it("answers once when a watchdog fires and ignores the late real answer", async () => {
    vi.useFakeTimers();
    const sent: RpcFrame[] = [];
    // Executor form (not Promise.withResolvers): the node tsconfig lib predates ES2024.
    let releaseRead: (read: ConfinedPlanRead) => void = () => {};
    const read = new Promise<ConfinedPlanRead>((resolve) => {
      releaseRead = resolve;
    });
    const bridge = new HostBridge({ ...fixtureDeps(), readPlanFile: () => read });
    // A plan read that blocks forever is the stuck case the watchdog exists for.
    bridge.noteFrame("t1", reviewFrame(PLAN_ABS));
    bridge.route("t1", uriRequestFrame("u1", "omp-ui://plan"), (frame) => sent.push(frame));
    await vi.advanceTimersByTimeAsync(HOST_ANSWER_WATCHDOG_MS);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      type: "host_uri_result",
      id: "u1",
      isError: true,
      error: "omp-ui could not answer this request in time",
    });
    // The late real answer lands on a deleted pending entry — no second frame.
    releaseRead({ ok: true, text: "late", sourceHash: "b".repeat(64), bytes: 4 });
    vi.useRealTimers();
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    expect(sent).toHaveLength(1);
  });

  it("abandons pending answers on forget without sending", async () => {
    vi.useFakeTimers();
    const sent: RpcFrame[] = [];
    const bridge = new HostBridge({
      ...fixtureDeps(),
      // Executor form: the node tsconfig lib predates ES2024.
      readPlanFile: () => new Promise<ConfinedPlanRead>(() => {}),
    });
    bridge.noteFrame("t1", reviewFrame(PLAN_ABS));
    bridge.route("t1", uriRequestFrame("u1", "omp-ui://plan"), (frame) => sent.push(frame));
    bridge.forget("t1");
    await vi.advanceTimersByTimeAsync(HOST_ANSWER_WATCHDOG_MS + 1_000);
    expect(sent).toHaveLength(0);
    expect(bridge.answeredIds("t1").size).toBe(0);
    expect(bridge.planPath("t1")).toBeNull();
  });

  it("routes nothing else and answers nothing else", () => {
    const f = fixture();
    expect(f.bridge.route("t1", { type: "agent_end" }, f.send)).toBe(false);
    expect(f.bridge.route("t1", { type: "response", id: "r1", success: true }, f.send)).toBe(false);
    expect(f.sent).toHaveLength(0);
    expect(f.bridge.answeredIds("t1").size).toBe(0);
  });

  it("caps the answered-id set at its bound (FIFO)", () => {
    const f = fixture();
    for (let i = 0; i < 600; i += 1) {
      f.bridge.route("t1", toolCallFrame(`h${i}`, "missing_tool", {}), f.send);
    }
    expect(f.bridge.answeredIds("t1").size).toBe(512);
    // The oldest evicted; the newest kept.
    expect(f.bridge.answeredIds("t1").has("h0")).toBe(false);
    expect(f.bridge.answeredIds("t1").has("h599")).toBe(true);
  });
});

function fixtureDeps(): HostBridgeDeps {
  return {
    readPlanFile: async () => ({ ok: false, reason: "unreadable" as const }),
    planSnapshot: () => null,
    planRoot: () => "/sessions/lineage",
    notify: () => "posted",
    capabilitySessionId: () => null,
    log: () => {},
  };
}
