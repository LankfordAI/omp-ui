import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, vi, afterEach } from "vitest";
import { PLAN_REVIEW_SENTINEL, PLAN_STATUS_KEY, parseVaultDetails, type ObsidianListEntry, type OwnedSessionRecord, type RpcFrame, type SessionsResourceDeps, type VaultRegistry, type VaultToolDetails } from "@omp-ui/core";
import { HostBridge, HOST_ANSWER_WATCHDOG_MS, type HostBridgeDeps, type VaultBridgeDeps, type VaultTabContext } from "./host-bridge";
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
    expect(f.sent[1]).toMatchObject({ isError: true, error: 'unknown omp-ui resource "settings"; available: plan, sessions' });
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

describe("HostBridge omp-ui://sessions", () => {
  const DAY_REFUSAL = "day must be a calendar date in YYYY-MM-DD form, for example 2026-10-06";

  function sessionRecord(patch: Partial<OwnedSessionRecord> = {}): OwnedSessionRecord {
    return {
      tabId: "tab-1",
      sessionId: "sess-1",
      lineageDir: "omp-ui--proj--11111111-2222-3333-4444-555555555555",
      projectCwd: "/abs/proj",
      worktree: null,
      planImplementationSource: null, experiment: null,
      launchedAt: new Date(2026, 9, 6, 9).toISOString(),
      mode: "rpc-ui",
      compactionMethod: null,
      approvalMode: null,
      serviceTier: null,
      model: null,
      thinkingLevel: null,
      advisor: false,
      advisorModel: null,
      subagentModels: null,
      proposedPlans: [],
      autoTitled: false,
      cachedTitle: "Ship the day index",
      cachedModified: new Date(2026, 9, 6, 10, 30).toISOString(),
      agentMode: "build",
      ...patch,
    };
  }

  function sessionsFixture(records: OwnedSessionRecord[] = [sessionRecord()]): {
    bridge: HostBridge;
    sent: RpcFrame[];
    send: (frame: RpcFrame) => void;
  } {
    const sessions: SessionsResourceDeps = {
      records: () => records,
      projects: () => [],
      locate: async () => ({ where: "missing" }),
      now: () => new Date(2026, 9, 6, 12),
    };
    const sent: RpcFrame[] = [];
    return { bridge: new HostBridge({ ...fixtureDeps(), sessions }), sent, send: (frame) => sent.push(frame) };
  }

  async function read(f: { bridge: HostBridge; sent: RpcFrame[]; send: (frame: RpcFrame) => void }, url: string): Promise<RpcFrame> {
    const id = `u${f.sent.length + 1}`;
    f.bridge.route("t1", uriRequestFrame(id, url), f.send);
    await vi.waitFor(() => expect(f.sent.find((frame) => frame.id === id)).toBeDefined());
    return f.sent.find((frame) => frame.id === id) as RpcFrame;
  }

  it("answers that the index is off when no sessions deps are wired", async () => {
    const f = fixture();
    f.bridge.route("t1", uriRequestFrame("u1", "omp-ui://sessions"), f.send);
    f.bridge.route("t1", uriRequestFrame("u2", "omp-ui://sessions/x/summary"), f.send);
    await settled();
    for (const id of ["u1", "u2"]) {
      expect(f.sent.find((frame) => frame.id === id)).toMatchObject({
        type: "host_uri_result",
        isError: true,
        error: "the session index is not available in this session",
      });
    }
  });

  it("refuses an impossible day as an error result", async () => {
    const f = sessionsFixture();
    expect(await read(f, "omp-ui://sessions?day=2026-02-30")).toMatchObject({
      type: "host_uri_result",
      isError: true,
      error: DAY_REFUSAL,
    });
  });

  it("serves the requested day's index as markdown, ignoring other query keys", async () => {
    const f = sessionsFixture();
    const frame = await read(f, "omp-ui://sessions?day=2026-10-06&x=1");
    expect(frame).toMatchObject({ type: "host_uri_result", contentType: "text/markdown" });
    expect(frame.isError).toBeUndefined();
    const content = frame.content as string;
    expect(content.startsWith("# Sessions on 2026-10-06")).toBe(true);
    expect(content).toContain("Ship the day index");
  });

  it("defaults to now()'s local day without a query", async () => {
    const f = sessionsFixture();
    const frame = await read(f, "omp-ui://sessions");
    const content = frame.content as string;
    expect(content.startsWith("# Sessions on 2026-10-06")).toBe(true);
    expect(content).toContain("omp-ui://sessions/sess-1/summary");
  });

  it("refuses an unknown session id", async () => {
    const f = sessionsFixture();
    expect(await read(f, "omp-ui://sessions/nope/summary")).toMatchObject({
      isError: true,
      error: 'no omp-ui session has id "nope"',
    });
  });

  it("serves a known session's summary, with the unavailable line when the transcript is missing", async () => {
    const f = sessionsFixture();
    const frame = await read(f, "omp-ui://sessions/sess-1/summary");
    expect(frame).toMatchObject({ type: "host_uri_result", contentType: "text/markdown" });
    const content = frame.content as string;
    expect(content).toContain("## Where it landed");
    expect(content).toContain("Summary unavailable: the transcript could not be read.");
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

const vaultFixtures: Array<{ root: string; bridge: HostBridge }> = [];
afterEach(() => {
  for (const f of vaultFixtures.splice(0)) {
    for (const tabId of ["t1", "t2"]) f.bridge.forget(tabId);
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

function vaultFixture(overrides: Partial<VaultBridgeDeps> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-host-vault-"));
  const vaultRoot = path.join(root, "vault-a");
  const otherRoot = path.join(root, "vault-b");
  for (const folder of [vaultRoot, otherRoot]) {
    fs.mkdirSync(path.join(folder, "omp-ui", "Project"), { recursive: true });
    fs.mkdirSync(path.join(folder, "Reference"));
    fs.writeFileSync(path.join(folder, "omp-ui", "Project", "Source.md"), "---\r\nowner: human\r\n---\r\n# Source\r\n\r\nOriginal body.\r\n");
    fs.writeFileSync(path.join(folder, "Reference", "Target.md"), "# Target\nUseful reference.\n");
  }
  let registry: VaultRegistry = {
    vaults: [
      { name: "A", path: vaultRoot, homeFolder: "omp-ui/", allowWritesOutsideHome: false },
      { name: "B", path: otherRoot, homeFolder: "omp-ui/", allowWritesOutsideHome: false },
    ],
    defaultWriteVault: "A",
  };
  let context: VaultTabContext | null = { projectName: "Project", project: { key: null, folder: "Project", indexTitle: "Project Index", legacy: null }, pinnedVault: null, lineage: "019a38bf-bbaa-7111-8123-123456789abc" };
  const logs: string[] = [];
  const sent: RpcFrame[] = [];
  const deps: VaultBridgeDeps = {
    context: () => context,
    registry: () => registry,
    guard: () => ({ home: path.join(root, "home"), userData: path.join(root, "data"), agentDir: path.join(root, "agent"), sessionsRoot: path.join(root, "sessions"), archiveRoot: path.join(root, "archive") }),
    obsidianList: async () => [{ id: "0123456789abcdef", path: fs.realpathSync.native(vaultRoot), open: true }],
    appVersion: "test-765",
    now: () => new Date(2026, 9, 6, 12),
    mainLog: (line) => logs.push(line),
    ...overrides,
  };
  const bridge = new HostBridge({ ...fixtureDeps(), vault: deps });
  vaultFixtures.push({ root, bridge });
  let nextId = 0;
  function call(action: string, args: unknown, tabId = "t1"): Promise<RpcFrame> {
    const id = `vault-${++nextId}`;
    // The desktop tsconfig lib predates ES2024 Promise.withResolvers.
    return new Promise((resolve) => {
      bridge.route(tabId, toolCallFrame(id, `omp-ui_vault_${action}`, args), (frame) => {
        sent.push(frame);
        resolve(frame);
      });
    });
  }
  return { root, vaultRoot, otherRoot, bridge, logs, sent, call,
    setRegistry: (value: VaultRegistry) => { registry = value; },
    registry: () => registry,
    setContext: (value: VaultTabContext | null) => { context = value; },
  };
}

function isResultRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resultText(frame: RpcFrame): string {
  if (!isResultRecord(frame.result) || !Array.isArray(frame.result.content)) throw new Error("missing result content");
  return frame.result.content.flatMap((item) => isResultRecord(item) && item.type === "text" && typeof item.text === "string" ? [item.text] : []).join("\n");
}

function resultDetails(frame: RpcFrame): VaultToolDetails {
  if (!isResultRecord(frame.result)) throw new Error("missing result");
  const details = parseVaultDetails(frame.result.details);
  if (details === null) throw new Error("missing vault details");
  return details;
}

function resultHash(frame: RpcFrame): string {
  const hash = resultDetails(frame).baseHash;
  if (hash === undefined) throw new Error("missing baseHash");
  return hash;
}

const SOURCE = "omp-ui/Project/Source.md";

describe("HostBridge knowledge vault real filesystem dispatch", () => {
  it("dispatches all seven tools, chains returned hashes, and preserves foreign frontmatter", async () => {
    const f = vaultFixture();
    const search = await f.call("search", { query: "Useful reference" });
    expect(resultDetails(search)).toMatchObject({ action: "search", vaultName: "A", vaultId: "0123456789abcdef", matchedFiles: 1, path: null });
    expect(resultText(search)).toContain("Reference/Target.md");
    const read = await f.call("read", { path: "Target" });
    expect(resultDetails(read)).toMatchObject({ path: "Reference/Target.md", createdByOmpUi: false });
    expect(resultText(read)).toContain("Useful reference.\n");
    const list = await f.call("list", {});
    expect(resultText(list)).toContain(SOURCE);
    expect(resultText(list)).not.toContain("Reference/Target.md");
    const created = await f.call("create", { title: "new finding", body: "# New Finding\n\nFinding body.", tags: ["decision"] });
    expect(created.isError).not.toBe(true);
    expect(resultDetails(created)).toMatchObject({ path: "omp-ui/Project/New Finding.md", indexNotePath: "omp-ui/Project/Project Index.md", createdByOmpUi: true });
    expect(fs.readFileSync(path.join(f.vaultRoot, "omp-ui/Project/Project Index.md"), "utf8")).toContain("- [[omp-ui/Project/New Finding|New Finding]]\n");
    const appended = await f.call("append", { path: SOURCE, text: "Added detail.  \n" });
    expect(appended.isError).not.toBe(true);
    const edited = await f.call("edit", { path: SOURCE, content: "# Source\n\nChanged body.\n", baseHash: resultHash(appended) });
    expect(edited.isError).not.toBe(true);
    expect(resultDetails(edited).diff).toContain("Changed body.");
    const linked = await f.call("link", { path: SOURCE, to: "Target", baseHash: resultHash(edited) });
    expect(linked.isError).not.toBe(true);
    expect(resultDetails(linked).diff).toContain("- [[Target]]");
    const bytes = fs.readFileSync(path.join(f.vaultRoot, SOURCE));
    expect(bytes.toString()).toMatch(/^---\r\nowner: human\r\n---\r\n/);
    expect(resultHash(linked)).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(f.bridge.vaultCallCounts()).toEqual({ t1: { search: 1, read: 1, list: 1, create: 1, append: 1, edit: 1, link: 1 } });
    expect(f.logs).toEqual([
      "[vault] A create omp-ui/Project/New Finding.md", `[vault] A append ${SOURCE}`,
      `[vault] A edit ${SOURCE}`, `[vault] A link ${SOURCE}`,
    ]);
  });

  it("returns image content without inventing markdown ownership", async () => {
    const f = vaultFixture();
    const data = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    fs.mkdirSync(path.join(f.vaultRoot, "Images"));
    fs.writeFileSync(path.join(f.vaultRoot, "Images", "Diagram.png"), data);
    const image = await f.call("read", { path: "Diagram.png" });
    expect(image).toMatchObject({ result: { content: [
      { type: "text", text: expect.stringContaining("Images/Diagram.png") },
      { type: "image", data: data.toString("base64"), mimeType: "image/png" },
    ] } });
    expect(resultDetails(image)).toMatchObject({ path: "Images/Diagram.png", createdByOmpUi: null });
    expect(f.logs).toEqual([]);
  });

  it("creates normally while Plan is enabled and supports project:false without an Index", async () => {
    const f = vaultFixture();
    f.bridge.noteFrame("t1", { type: "extension_ui_request", method: "setStatus", statusKey: PLAN_STATUS_KEY, statusText: JSON.stringify({ enabled: true, planAbsPath: PLAN_ABS }) });
    expect(f.bridge.planPath("t1")).toBe(PLAN_ABS);
    const created = await f.call("create", { title: "Shared Note", body: "Shared body", project: false });
    expect(created.isError).not.toBe(true);
    expect(resultDetails(created)).toMatchObject({ path: "omp-ui/Shared Note.md" });
    expect(resultDetails(created).indexNotePath).toBeUndefined();
    expect(fs.readFileSync(path.join(f.vaultRoot, "omp-ui/Shared Note.md"), "utf8")).not.toContain("project:");
    expect(fs.existsSync(path.join(f.vaultRoot, "omp-ui/Project/Project Index.md"))).toBe(false);
  });

  it("logs notes adopted into a keyed project's folder", async () => {
    const f = vaultFixture();
    f.setContext({
      projectName: "app",
      project: { key: "acme/app", folder: "Acme/app", indexTitle: "app Index", legacy: { suffixed: "app-acme", plain: "app" } },
      pinnedVault: null,
      lineage: "lineage",
    });
    fs.mkdirSync(path.join(f.vaultRoot, "omp-ui", "app-acme"));
    fs.writeFileSync(path.join(f.vaultRoot, "omp-ui", "app-acme", "Old.md"), "---\nomp-ui: true\n---\nbody\n");
    const created = await f.call("create", { title: "Fresh", body: "Fresh body" });
    expect(created.isError).not.toBe(true);
    expect(resultDetails(created).adopted).toEqual(["omp-ui/Acme/app/Old.md"]);
    expect(fs.existsSync(path.join(f.vaultRoot, "omp-ui", "Acme", "app", "Old.md"))).toBe(true);
    expect(f.logs).toEqual([
      "[vault] A create omp-ui/Acme/app/Fresh.md",
      "[vault] A create adopted 1 notes into omp-ui/Acme/app",
    ]);
  });

  it("uses explicit vault, then pin, then default and snapshots selection across setup", async () => {
    const f = vaultFixture();
    f.setContext({ projectName: "Project", project: { key: null, folder: "Project", indexTitle: "Project Index", legacy: null }, pinnedVault: "B", lineage: "lineage" });
    expect(resultDetails(await f.call("read", { path: SOURCE })).vaultName).toBe("B");
    expect(resultDetails(await f.call("read", { path: SOURCE, vault: "A" })).vaultName).toBe("A");
    const broken = await f.call("create", { title: "x", body: "x", vault: "Unknown" });
    expect(resultText(broken)).toBe('unknown vault "Unknown"; registered: A, B');
    expect(f.logs.at(-1)).toBe('[vault] Unknown create refused: unknown vault "Unknown"; registered: A, B');
    f.setContext({ projectName: "Project", project: { key: null, folder: "Project", indexTitle: "Project Index", legacy: null }, pinnedVault: "Removed", lineage: "lineage" });
    expect(resultText(await f.call("read", { path: SOURCE }))).toBe('this project\'s knowledge home names vault "Removed", which is no longer registered; registered: A, B');
    f.setContext(null);
    expect(resultText(await f.call("read", { path: SOURCE }))).toBe("this session's record is gone");
    f.setContext({ projectName: null, project: { key: null, folder: "Project", indexTitle: "Project Index", legacy: null }, pinnedVault: null, lineage: "lineage" });
    f.setRegistry({ vaults: [], defaultWriteVault: null });
    expect(resultText(await f.call("read", { path: SOURCE }))).toBe("no vault is registered; add one in Settings, Knowledge vault");
  });

  it("reports absent integration and counts only exact known names", async () => {
    const f = fixture();
    f.bridge.route("t1", toolCallFrame("known", "omp-ui_vault_read", { path: "x" }), f.send);
    f.bridge.route("t1", toolCallFrame("unknown", "omp-ui_vault_write", {}), f.send);
    f.bridge.route("t1", toolCallFrame("notify", "omp-ui_notify", { message: "ok" }), f.send);
    await settled();
    expect(resultText(f.sent[0])).toBe("the knowledge vault is not available in this session");
    expect(resultText(f.sent[1])).toContain('unknown host tool "omp-ui_vault_write"');
    expect(f.bridge.vaultCallCounts()).toEqual({ t1: { read: 1 } });
    f.bridge.forget("t1");
  });

  it.each([
    ["search", [], "arguments"], ["search", { query: " " }, "query"],
    ["search", { query: "x", limit: 0 }, "limit"], ["search", { query: "x", limit: 51 }, "limit"],
    ["search", { query: "x", limit: 1.5 }, "limit"], ["search", { query: "x", limit: "1" }, "limit"],
    ["read", { path: " " }, "path"], ["read", { path: SOURCE, vault: null }, "vault"],
    ["list", { folder: [] }, "folder"], ["create", { title: "x" }, "body"],
    ["create", { title: " ", body: "x" }, "title"], ["create", { title: "x", body: "x", tags: [1] }, "tags"],
    ["create", { title: "x", body: "x", project: "false" }, "project"],
    ["append", { path: SOURCE, text: null }, "text"], ["edit", { path: SOURCE, content: "x", baseHash: null }, "baseHash"],
    ["edit", { path: SOURCE, content: [] }, "content"], ["link", { path: SOURCE, to: " " }, "to"],
  ] satisfies Array<[string, unknown, string]>)("checks %s arguments without mutation or logging values", async (action, args, field) => {
    const f = vaultFixture();
    const before = fs.readFileSync(path.join(f.vaultRoot, SOURCE));
    const result = await f.call(action, args);
    expect(result.isError).toBe(true);
    expect(resultText(result)).toContain(`omp-ui_vault_${action} requires ${field} (`);
    expect(fs.readFileSync(path.join(f.vaultRoot, SOURCE))).toEqual(before);
    expect(f.bridge.vaultCallCounts().t1).toEqual({ [action]: 1 });
  });
});

describe("HostBridge vault authorization and safety", () => {
  it("requires an exact canonical token scoped to tab and vault, not a title fallback or case fold", async () => {
    const f = vaultFixture();
    const read = await f.call("read", { path: "Source" });
    const hash = resultHash(read);
    expect(resultDetails(read).path).toBe(SOURCE);
    for (const [source, vault, tabId] of [
      ["Source", "A", "t1"], ["omp-ui/Project/source.md", "A", "t1"],
      [SOURCE, "B", "t1"], [SOURCE, "A", "t2"],
    ]) {
      const result = await f.call("edit", { path: source, vault, content: "refused", baseHash: hash }, tabId);
      expect(result.isError).toBe(true);
      expect(resultText(result)).toContain("first; omp-ui_vault_edit needs the baseHash");
    }
    const edited = await f.call("edit", { path: "  omp-ui\\Project\\Source  ", content: "Authorized body.\n", baseHash: hash });
    expect(edited.isError).not.toBe(true);
    const linked = await f.call("link", { path: SOURCE, to: "Target", baseHash: resultHash(edited) });
    expect(linked.isError).not.toBe(true);
  });

  it("distinguishes no read, missing hash, stale latest-read hash, and changed disk bytes", async () => {
    const f = vaultFixture();
    const first = await f.call("edit", { path: SOURCE, content: "x", baseHash: "f".repeat(64) });
    expect(resultText(first)).toContain(`read ${SOURCE} first;`);
    const read = await f.call("read", { path: SOURCE });
    const beforeMissing = fs.readFileSync(path.join(f.vaultRoot, SOURCE));
    const missing = await f.call("link", { path: SOURCE, to: "Target" });
    expect(missing.isError).toBe(true);
    expect(fs.readFileSync(path.join(f.vaultRoot, SOURCE))).toEqual(beforeMissing);
    fs.appendFileSync(path.join(f.vaultRoot, SOURCE), "Disk change.\n");
    const before = fs.readFileSync(path.join(f.vaultRoot, SOURCE));
    const changed = await f.call("edit", { path: SOURCE, content: "x", baseHash: resultHash(read) });
    expect(resultText(changed)).toContain(`${SOURCE} changed since you read it; read it again before editing`);
    expect(fs.readFileSync(path.join(f.vaultRoot, SOURCE))).toEqual(before);
    const latest = await f.call("read", { path: SOURCE });
    const stale = await f.call("edit", { path: SOURCE, content: "x", baseHash: resultHash(read) });
    expect(resultText(stale)).toContain(`baseHash is not from your latest read of ${SOURCE}; read it again`);
    expect((await f.call("edit", { path: SOURCE, content: "latest body", baseHash: resultHash(latest) })).isError).not.toBe(true);
  });

  it("updates append/create tokens but never authorizes the incidental Index write", async () => {
    const f = vaultFixture();
    const appended = await f.call("append", { path: SOURCE, text: "No read necessary." });
    expect((await f.call("edit", { path: SOURCE, content: "chained", baseHash: resultHash(appended) })).isError).not.toBe(true);
    const created = await f.call("create", { title: "New Note", body: "created" });
    expect((await f.call("edit", { path: resultDetails(created).path, content: "chained create", baseHash: resultHash(created) })).isError).not.toBe(true);
    const index = "omp-ui/Project/Project Index.md";
    const indexHash = createHash("sha256").update(fs.readFileSync(path.join(f.vaultRoot, index))).digest("hex");
    expect(resultText(await f.call("edit", { path: index, content: "no token", baseHash: indexHash }))).toContain(`read ${index} first`);
  });

  it.each(["../outside", "/absolute.md", "C:\\outside.md", ".hidden/Note", "Reference/../Target", "omp-ui/.hidden/Note"])("refuses unsafe explicit source %s without changing the note", async (source) => {
    const f = vaultFixture();
    const before = fs.readFileSync(path.join(f.vaultRoot, SOURCE));
    expect((await f.call("read", { path: source })).isError).toBe(true);
    expect((await f.call("append", { path: source, text: "must not write" })).isError).toBe(true);
    expect(fs.readFileSync(path.join(f.vaultRoot, SOURCE))).toEqual(before);
    expect(fs.existsSync(path.join(f.root, "outside.md"))).toBe(false);
  });

  it("refuses vault escapes, home-to-sibling symlinks, and writes outside home", async () => {
    const f = vaultFixture();
    const outside = path.join(f.root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "Note.md"), "Outside bytes");
    fs.symlinkSync(outside, path.join(f.vaultRoot, "Escape"), "dir");
    expect((await f.call("read", { path: "Escape/Note" })).isError).toBe(true);
    expect((await f.call("append", { path: "Escape/Note", text: "x" })).isError).toBe(true);
    const own = fs.readFileSync(path.join(f.vaultRoot, "Reference/Target.md"));
    const denied = await f.call("append", { path: "Reference/Target", text: "x" });
    expect(resultText(denied)).toContain("omp-ui writes only inside omp-ui/ in vault A; Reference/Target.md is outside it");
    expect(fs.readFileSync(path.join(f.vaultRoot, "Reference/Target.md"))).toEqual(own);
    fs.rmSync(path.join(f.vaultRoot, "omp-ui"), { recursive: true });
    fs.symlinkSync(path.join(f.vaultRoot, "Reference"), path.join(f.vaultRoot, "omp-ui"), "dir");
    expect((await f.call("create", { title: "No Escape", body: "x", project: false })).isError).toBe(true);
    expect(fs.existsSync(path.join(f.vaultRoot, "Reference/No Escape.md"))).toBe(false);
    expect(fs.readFileSync(path.join(outside, "Note.md"), "utf8")).toBe("Outside bytes");
  });

  it("checks removed roots without consuming quota and leaves notify and a later read usable", async () => {
    const f = vaultFixture();
    fs.renameSync(f.vaultRoot, `${f.vaultRoot}-mounted`);
    const failure = await f.call("create", { title: "No Root", body: "x" });
    expect(resultText(failure)).toContain("vault A is unreachable at its registered folder; check that the drive is mounted");
    expect(resultText(failure)).not.toContain(f.root);
    const notify: RpcFrame[] = [];
    f.bridge.route("t1", toolCallFrame("notify-after-failure", "omp-ui_notify", { message: "still alive" }), (frame) => notify.push(frame));
    expect(resultText(notify[0])).toBe("posted");
    fs.renameSync(`${f.vaultRoot}-mounted`, f.vaultRoot);
    expect((await f.call("read", { path: SOURCE })).isError).not.toBe(true);
    for (let i = 0; i < 25; i += 1) {
      expect(resultText(await f.call("edit", { path: SOURCE, content: "x" }))).not.toContain("write limit");
    }
    expect(resultText(await f.call("edit", { path: SOURCE, content: "x" }))).toContain("vault write limit reached");
  });

  it("never exposes a refused protected root and does not fall back to another vault", async () => {
    const f = vaultFixture({ guard: () => ({ home: os.tmpdir(), userData: os.tmpdir(), agentDir: "missing-agent", sessionsRoot: "missing-session", archiveRoot: "missing-archive" }) });
    const refused = await f.call("read", { path: SOURCE });
    expect(refused.isError).toBe(true);
    expect(resultText(refused)).toContain("omp-ui cannot use this vault: it is inside omp-ui's data folder");
    expect(resultText(refused)).not.toContain(f.root);
  });
});

function deferred<T>() {
  let resolveValue: ((value: T) => void) | undefined;
  // The desktop tsconfig lib predates ES2024 Promise.withResolvers.
  const promise = new Promise<T>((resolve) => { resolveValue = resolve; });
  return { promise, release: (value: T): void => {
    if (resolveValue === undefined) throw new Error("resolver was not initialized");
    resolveValue(value);
  } };
}

describe("HostBridge vault quota, diagnostics, and cancellation", () => {
  it("reserves 25 concurrent writes per tab before awaited setup, never 26", async () => {
    const lookup = deferred<ObsidianListEntry[]>();
    const reserved = deferred<void>();
    let lookups = 0;
    const f = vaultFixture({ obsidianList: () => {
      lookups += 1;
      if (lookups === 25) reserved.release(undefined);
      return lookup.promise;
    } });
    const requests = Array.from({ length: 26 }, (_, i) => f.call("create", { title: `Concurrent ${i}`, body: "body", project: false }));
    await reserved.promise;
    // Only 25 calls reach the awaited lookup: reservation was synchronous.
    expect(lookups).toBe(25);
    lookup.release([]);
    const results = await Promise.all(requests);
    expect(results.filter((result) => result.isError !== true)).toHaveLength(25);
    const refused = results.filter((result) => result.isError === true);
    expect(refused).toHaveLength(1);
    expect(resultText(refused[0])).toContain("vault write limit reached for this turn (25); continue in the next turn");
    expect(f.logs).toHaveLength(26);
    expect(f.bridge.vaultCallCounts()).toEqual({ t1: { create: 26 } });
    expect((await f.call("create", { title: "Other Tab", body: "body", project: false }, "t2")).isError).not.toBe(true);
  });

  it("counts post-reservation refusals, resets only quota on turn_start, and clears all state on forget", async () => {
    const f = vaultFixture();
    const read = await f.call("read", { path: SOURCE });
    for (let i = 0; i < 25; i += 1) {
      expect(resultText(await f.call("link", { path: SOURCE, to: "Target" }))).toContain("needs the baseHash");
    }
    expect(resultText(await f.call("edit", { path: SOURCE, content: "x", baseHash: resultHash(read) }))).toContain("write limit");
    f.bridge.noteFrame("t1", { type: "turn_start" });
    const edited = await f.call("edit", { path: SOURCE, content: "token survived the turn", baseHash: resultHash(read) });
    expect(edited.isError).not.toBe(true);
    const snapshot = f.bridge.vaultCallCounts();
    expect(snapshot).toEqual({ t1: { read: 1, link: 25, edit: 2 } });
    snapshot.t1.read = 999;
    snapshot.extra = { create: 123 };
    expect(f.bridge.vaultCallCounts()).toEqual({ t1: { read: 1, link: 25, edit: 2 } });
    f.bridge.forget("t1");
    expect(f.bridge.vaultCallCounts()).toEqual({});
    expect(f.bridge.answeredIds("t1").size).toBe(0);
    expect(resultText(await f.call("edit", { path: SOURCE, content: "forgotten", baseHash: resultHash(edited) }))).toContain(`read ${SOURCE} first`);
    expect(f.bridge.vaultCallCounts()).toEqual({ t1: { edit: 1 } });
  });

  it("does not charge malformed writes against the turn limit", async () => {
    const f = vaultFixture();
    for (let i = 0; i < 26; i += 1) await f.call("create", { title: "Malformed" });
    for (let i = 0; i < 25; i += 1) {
      expect(resultText(await f.call("edit", { path: SOURCE, content: "missing token" }))).toContain("needs the baseHash");
    }
    expect(resultText(await f.call("edit", { path: SOURCE, content: "missing token" }))).toContain("write limit");
  });

  it("ignores unknown fields and logs only one-line identity or controlled refusal without body/diff/secrets", async () => {
    const f = vaultFixture();
    const secret = `sk-${"a".repeat(25)}`;
    const created = await f.call("create", { title: "Logged Note", body: "PRIVATE_BODY_MARKER", extra: secret });
    expect(created.isError).not.toBe(true);
    const edit = await f.call("edit", { path: resultDetails(created).path, content: "PRIVATE_DIFF_MARKER", baseHash: resultHash(created), unknown: "PRIVATE_UNKNOWN_MARKER" });
    expect(edit.isError).not.toBe(true);
    const refusal = await f.call("append", { path: SOURCE, text: `Do not store ${secret}` });
    expect(resultText(refusal)).toContain("openai-key secret shape");
    expect(resultText(refusal)).not.toContain(secret);
    const injected = await f.call("create", { title: "unused", body: "PRIVATE_REFUSAL_MARKER", vault: "missing\r\nvault" });
    expect(injected.isError).toBe(true);
    expect(f.logs).toHaveLength(4);
    expect(f.logs[0]).toBe("[vault] A create omp-ui/Project/Logged Note.md");
    expect(f.logs[1]).toBe("[vault] A edit omp-ui/Project/Logged Note.md");
    expect(f.logs[2]).toContain("[vault] A append refused: refused: the text matches the openai-key secret shape;");
    expect(f.logs[3]).toContain("[vault] missing\\r\\nvault create refused: unknown vault");
    for (const line of f.logs) {
      expect(line).not.toMatch(/[\r\n]/);
      expect(line).not.toContain("PRIVATE_");
      expect(line).not.toContain(secret);
      expect(line).not.toContain(f.root);
    }
    expect(isResultRecord(created.result) && isResultRecord(created.result.details) && "extra" in created.result.details).toBe(false);
    expect(f.bridge.vaultCallCounts()).toEqual({ t1: { create: 2, edit: 1, append: 1 } });
  });

  it("uses a fixed setup exception reason instead of exposing dependency error bytes", async () => {
    const f = vaultFixture({ obsidianList: async () => { throw new Error("PRIVATE_NOTE_BYTES\nowner: secret"); } });
    const failed = await f.call("create", { title: "Setup Failure", body: "body" });
    expect(resultText(failed)).toBe("Vault A\n\nomp-ui could not complete the vault call (unexpected error)");
    expect(f.logs).toEqual(["[vault] A create refused: omp-ui could not complete the vault call (unexpected error)"]);
    expect(fs.existsSync(path.join(f.vaultRoot, "omp-ui/Project/Setup Failure.md"))).toBe(false);
  });

  it("keeps a registry and tab-context snapshot while obsidian setup is pending", async () => {
    const lookup = deferred<ObsidianListEntry[]>();
    const entered = deferred<void>();
    const f = vaultFixture({ obsidianList: () => { entered.release(undefined); return lookup.promise; } });
    const request = f.call("create", { title: "Snapshot Note", body: "snapshot" });
    await entered.promise;
    f.registry().vaults[0].name = "Changed";
    f.registry().vaults[0].path = f.otherRoot;
    f.setRegistry({ vaults: [], defaultWriteVault: null });
    f.setContext({ projectName: "Changed", project: { key: null, folder: "Other Project", indexTitle: "Other Project Index", legacy: null }, pinnedVault: "B", lineage: "other-lineage" });
    lookup.release([]);
    const created = await request;
    expect(created.isError).not.toBe(true);
    expect(resultDetails(created)).toMatchObject({ vaultName: "A", path: "omp-ui/Project/Snapshot Note.md" });
    expect(fs.existsSync(path.join(f.vaultRoot, "omp-ui/Project/Snapshot Note.md"))).toBe(true);
    expect(fs.existsSync(path.join(f.otherRoot, "omp-ui/Other Project/Snapshot Note.md"))).toBe(false);
  });

  it.each(["cancel", "forget", "watchdog"])("does not mutate or answer after %s during awaited setup", async (mode) => {
    const lookup = deferred<ObsidianListEntry[]>();
    const entered = deferred<void>();
    const f = vaultFixture({ obsidianList: () => { entered.release(undefined); return lookup.promise; } });
    const sent: RpcFrame[] = [];
    const send = (frame: RpcFrame): void => { sent.push(frame); };
    if (mode === "watchdog") vi.useFakeTimers();
    f.bridge.route("t1", toolCallFrame("awaited-setup", "omp-ui_vault_create", { title: "Cancelled Note", body: "must not write" }), send);
    expect(f.bridge.answeredIds("t1").has("awaited-setup")).toBe(true);
    await entered.promise;
    if (mode === "cancel") f.bridge.route("t1", { type: "host_tool_cancel", id: "cancel", targetId: "awaited-setup" }, send);
    else if (mode === "forget") f.bridge.forget("t1");
    else {
      await vi.advanceTimersByTimeAsync(HOST_ANSWER_WATCHDOG_MS);
      expect(sent).toHaveLength(1);
      expect(resultText(sent[0])).toBe("omp-ui could not answer this request in time");
    }
    lookup.release([]);
    vi.useRealTimers();
    await settled();
    expect(sent).toHaveLength(mode === "watchdog" ? 1 : 0);
    expect(f.logs).toEqual([]);
    expect(fs.existsSync(path.join(f.vaultRoot, "omp-ui/Project/Cancelled Note.md"))).toBe(false);
    expect(fs.existsSync(path.join(f.vaultRoot, "omp-ui/Project/Project Index.md"))).toBe(false);
    if (mode === "forget") {
      expect(f.bridge.vaultCallCounts()).toEqual({});
      expect(f.bridge.answeredIds("t1").size).toBe(0);
    }
  });

  it("does not recreate forgotten maps or authorize a reused tab after old setup completes", async () => {
    const oldLookup = deferred<ObsidianListEntry[]>();
    const entered = deferred<void>();
    let lookups = 0;
    const f = vaultFixture({ obsidianList: () => {
      lookups += 1;
      if (lookups === 1) {
        entered.release(undefined);
        return oldLookup.promise;
      }
      return Promise.resolve([]);
    } });
    const sent: RpcFrame[] = [];
    f.bridge.route("t1", toolCallFrame("old-read", "omp-ui_vault_read", { path: SOURCE }), (frame) => sent.push(frame));
    await entered.promise;
    f.bridge.forget("t1");
    const fresh = await f.call("read", { path: "Reference/Target.md" });
    expect(fresh.isError).not.toBe(true);
    oldLookup.release([]);
    await settled();
    expect(sent).toEqual([]);
    expect(f.bridge.vaultCallCounts()).toEqual({ t1: { read: 1 } });
    const oldHash = createHash("sha256").update(fs.readFileSync(path.join(f.vaultRoot, SOURCE))).digest("hex");
    expect(resultText(await f.call("edit", { path: SOURCE, content: "old read must not authorize", baseHash: oldHash }))).toContain(`read ${SOURCE} first`);
  });

  it("cancels before awaited root setup without entering lookup or recreating forgotten state", async () => {
    let lookups = 0;
    const f = vaultFixture({ obsidianList: async () => { lookups += 1; return []; } });
    const sent: RpcFrame[] = [];
    f.bridge.route("t1", toolCallFrame("cancel-before-root", "omp-ui_vault_create", { title: "Never Created", body: "must not write" }), (frame) => sent.push(frame));
    f.bridge.route("t1", { type: "host_tool_cancel", id: "cancel", targetId: "cancel-before-root" }, (frame) => sent.push(frame));
    f.bridge.forget("t1");
    expect((await f.call("read", { path: SOURCE }, "t2")).isError).not.toBe(true);
    await settled();
    expect(lookups).toBe(1);
    expect(sent).toEqual([]);
    expect(f.bridge.vaultCallCounts()).toEqual({ t2: { read: 1 } });
    expect(f.logs).toEqual([]);
    expect(fs.existsSync(path.join(f.vaultRoot, "omp-ui/Project/Never Created.md"))).toBe(false);
  });

  it("reports filesystem exception code and relative destination, never the raw message or absolute path", async () => {
    const f = vaultFixture({ obsidianList: async () => {
      throw Object.assign(new Error("PRIVATE_BYTES at /absolute/registered/root"), { code: "EACCES", path: "/absolute/registered/root" });
    } });
    const failure = await f.call("append", { path: SOURCE, text: "body" });
    expect(resultText(failure)).toBe(`Vault A · ${SOURCE}\n\nomp-ui could not complete the vault call (EACCES: ${SOURCE})`);
    expect(f.logs).toEqual([`[vault] A append refused: omp-ui could not complete the vault call (EACCES: ${SOURCE})`]);
  });

  it("applies a fresh write toggle and permits a prospective missing home without widening create", async () => {
    const f = vaultFixture();
    const registry = f.registry();
    registry.vaults[0].allowWritesOutsideHome = true;
    expect((await f.call("append", { path: "Reference/Target", text: "allowed outside home" })).isError).not.toBe(true);
    registry.vaults[0].homeFolder = "Missing/Nested/";
    const created = await f.call("create", { title: "Missing Home", body: "body", project: false });
    expect(created.isError).not.toBe(true);
    expect(resultDetails(created).path).toBe("Missing/Nested/Missing Home.md");
    expect(fs.existsSync(path.join(f.vaultRoot, "Missing/Nested/Missing Home.md"))).toBe(true);
    const read = await f.call("read", { path: SOURCE });
    registry.vaults[0].allowWritesOutsideHome = false;
    const denied = await f.call("edit", { path: SOURCE, content: "must be denied", baseHash: resultHash(read) });
    expect(resultText(denied)).toContain("omp-ui writes only inside Missing/Nested/ in vault A;");
  });
});
