import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { BROWSER_PANE_MAX_CDP_CLIENTS, BROWSER_PANE_ROOT_VERSION_WINDOW_MS } from "@omp-ui/core";
import { mintRemoteToken } from "@omp-ui/server";
import {
  createBridgeListener,
  createBridgeSession,
  gateBridgeRequest,
  type BridgeFrame,
  type BridgeListener,
  type BridgeRequest,
} from "./browser-pane-bridge";
import type { PaneContents, PaneDebugger } from "./browser-pane-contents";

// U5: the root shim replayed against real omp 18.1.21 + puppeteer 25.3 traffic
// captured through the #526 prototype. U6: the request gate and one real
// loopback listener.
//
// Promises use the executor form (not Promise.withResolvers): the node tsconfig
// lib is ES2022.

// ---------------------------------------------------------------- fixture

interface TargetInfo {
  targetId: string;
  type: string;
  attached?: boolean;
}
/** `Target.attachedToTarget` / `detachedFromTarget` / `targetCreated` params as CDP defines them. */
interface TargetEventParams {
  sessionId?: string;
  targetId?: string;
  targetInfo?: TargetInfo;
}
type MessageListener = (event: unknown, method: string, params: unknown, sessionId?: string) => void;

interface FixtureRow {
  kind: "in" | "out" | "electron-cmd" | "electron-event" | "http" | "ws" | "note";
  client?: number;
  sessionId?: string;
  id?: number;
  method?: string;
  params?: TargetEventParams;
  result?: unknown;
  error?: { code: number; message: string };
  event?: string;
  pageId?: string;
  tabId?: string;
}

const FIXTURE = join(__dirname, "__fixtures__", "browser-pane-omp-traffic.jsonl");
// The fixture is this repo's own recording; its row shape is asserted once here.
const rows = readFileSync(FIXTURE, "utf8")
  .split("\n")
  .filter((line) => line !== "")
  .map((line) => JSON.parse(line) as FixtureRow);
const note = rows.find((r) => r.kind === "note" && r.pageId !== undefined);
if (note?.pageId === undefined || note.tabId === undefined) throw new Error("fixture lacks the ids note");
const PAGE_ID = note.pageId;
const TAB_ID = note.tabId;
const TAB_SESSION_1 = "5870D21A40B506636144CA44978694E7";
const PAGE_SESSION_1 = "C25DADA716CECF1F2237FE327A8DFA9E";

/** Root-shim methods the bridge answers itself; every other client command is forwarded. */
const INTERCEPTED_ROOT: Readonly<Record<string, true>> = {
  "Target.getBrowserContexts": true,
  "Target.setAutoAttach": true,
  "Target.createTarget": true,
  "Target.closeTarget": true,
  "Browser.close": true,
};
const INTERCEPTED_SCOPED: Readonly<Record<string, true>> = {
  "Page.close": true,
  "Target.closeTarget": true,
};

/** Frames the bridge emits carry CDP params; the tests read them as such. */
function eventParams(frame: BridgeFrame): TargetEventParams {
  const params = frame.params as TargetEventParams;
  return params;
}

/**
 * Electron's debugger as the fixture saw it: answers the bridge's own Target
 * commands from a small model, emits the fixture's attach/detach events at the
 * moment the corresponding command runs (Chromium notifies before it replies),
 * and answers forwarded client commands with the reply the fixture recorded.
 */
class FixtureDebugger implements PaneDebugger {
  readonly commands: Array<{ method: string; params: TargetEventParams; sessionId: string | undefined }> =
    [];
  readonly consumed = new Set<number>();
  /** Fixture index the replay driver is at; event lookups scan forward from here. */
  cursor = 0;
  /** The client command being handled — its recorded reply answers forwarded commands. */
  current: { client: number; id: number } | null = null;
  private readonly targets = new Map<string, TargetInfo>();
  private readonly listeners: MessageListener[] = [];
  private readonly replies = new Map<string, FixtureRow>();

  constructor() {
    for (const row of rows) {
      if (row.kind === "out" && row.id !== undefined && row.client !== undefined) {
        this.replies.set(`${row.client}:${row.id}`, row);
      }
      const info = row.params?.targetInfo;
      if (row.kind === "electron-event" && row.method === "Target.targetCreated" && info !== undefined) {
        if (this.targets.size < 2) this.targets.set(info.targetId, info);
      }
    }
  }

  attach(): void {}
  detach(): void {}
  isAttached(): boolean {
    return true;
  }
  on(event: "message", cb: MessageListener): void;
  on(event: "detach", cb: (event: unknown, reason: string) => void): void;
  on(event: string, cb: MessageListener | ((event: unknown, reason: string) => void)): void {
    // Overload dispatch: the "message" signature is the one stored.
    if (event === "message") this.listeners.push(cb as MessageListener);
  }

  emit(method: string, params: TargetEventParams | undefined, sessionId: string | undefined): void {
    const info = params?.targetInfo;
    if (method === "Target.targetInfoChanged" && (sessionId ?? "") === "" && info !== undefined) {
      this.targets.set(info.targetId, info);
    }
    for (const cb of this.listeners) cb({}, method, params, sessionId);
  }

  /** First not-yet-emitted event at or after the cursor matching `pred`, emitted now. */
  private takeEvent(pred: (row: FixtureRow) => boolean): FixtureRow | null {
    for (let i = this.cursor; i < rows.length; i++) {
      const row = rows[i] as FixtureRow;
      if (row.kind !== "electron-event" || this.consumed.has(i) || !pred(row)) continue;
      this.consumed.add(i);
      this.emit(row.method ?? "", row.params, row.sessionId);
      return row;
    }
    return null;
  }

  async sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown> {
    // The bridge only ever sends Target-domain params of this shape on its own behalf.
    const p = (params ?? {}) as TargetEventParams;
    this.commands.push({ method, params: p, sessionId });
    switch (method) {
      case "Target.getTargetInfo":
        return { targetInfo: this.targets.get(PAGE_ID) };
      case "Target.getTargets":
        return { targetInfos: [...this.targets.values()] };
      case "Target.setDiscoverTargets":
        return {};
      case "Target.attachToTarget": {
        const row = this.takeEvent(
          (r) =>
            r.sessionId === "" &&
            r.method === "Target.attachedToTarget" &&
            r.params?.targetInfo?.targetId === p.targetId,
        );
        if (row === null) throw new Error(`fixture has no attach event for ${String(p.targetId)}`);
        return { sessionId: row.params?.sessionId };
      }
      case "Target.setAutoAttach":
        if (sessionId !== undefined) {
          this.takeEvent((r) => r.sessionId === sessionId && r.method === "Target.attachedToTarget");
        }
        return {};
      case "Target.detachFromTarget": {
        const row = this.takeEvent(
          (r) =>
            r.sessionId === "" &&
            r.method === "Target.detachedFromTarget" &&
            r.params?.sessionId === p.sessionId,
        );
        if (row === null) throw new Error("No session with given id");
        return {};
      }
      default: {
        const reply =
          this.current === null
            ? undefined
            : this.replies.get(`${this.current.client}:${this.current.id}`);
        if (reply?.error !== undefined) throw new Error(reply.error.message);
        return reply?.result ?? {};
      }
    }
  }
}

interface Replay {
  debugger: FixtureDebugger;
  /** Frames each client received, in order. */
  out: Map<number, BridgeFrame[]>;
  closed: number[];
  forwarded: string[];
  settled: string[];
}

async function replayFixture(): Promise<Replay> {
  const debug = new FixtureDebugger();
  const out = new Map<number, BridgeFrame[]>();
  const closed: number[] = [];
  const forwarded: string[] = [];
  const settled: string[] = [];
  const session = createBridgeSession<number>({
    debugger: debug,
    onCommand: (method) => forwarded.push(method),
    onCommandSettled: (method) => settled.push(method),
    send: (client, frame) => {
      let frames = out.get(client);
      if (frames === undefined) {
        frames = [];
        out.set(client, frames);
      }
      frames.push(frame);
    },
    close: (client) => closed.push(client),
  });
  for (let i = 0; i < rows.length; i++) {
    debug.cursor = i;
    if (debug.consumed.has(i)) continue;
    const row = rows[i] as FixtureRow;
    switch (row.kind) {
      case "ws":
        if (row.event === "open") session.addClient(row.client ?? 0);
        if (row.event === "close") await session.removeClient(row.client ?? 0);
        break;
      case "electron-event":
        debug.emit(row.method ?? "", row.params, row.sessionId);
        break;
      case "in": {
        const client = row.client ?? 0;
        const id = row.id ?? 0;
        debug.current = { client, id };
        const frame: BridgeFrame = { id, method: row.method };
        if (row.params !== undefined) frame.params = row.params;
        if (row.sessionId !== undefined) frame.sessionId = row.sessionId;
        await session.handleClientMessage(client, JSON.stringify(frame));
        debug.current = null;
        break;
      }
      default:
        break;
    }
  }
  return { debugger: debug, out, closed, forwarded, settled };
}

function framesOf(replay: Replay, client: number): BridgeFrame[] {
  return replay.out.get(client) ?? [];
}

function replyIndex(frames: BridgeFrame[], id: number): number {
  return frames.findIndex((f) => f.id === id);
}

// ---------------------------------------------------------------- U5

describe("browser pane bridge root shim (omp 18.1.21 + puppeteer replay)", () => {
  let replay: Replay;
  const ready = replayFixture().then((r) => {
    replay = r;
  });

  it("answers every client command exactly once, under the client's own id and session", async () => {
    await ready;
    for (const row of rows) {
      if (row.kind !== "in") continue;
      const replies = framesOf(replay, row.client ?? 0).filter((f) => f.id === row.id);
      expect(replies, `client ${row.client} id ${row.id} ${row.method}`).toHaveLength(1);
      expect(replies[0]?.sessionId).toBe(row.sessionId);
    }
  });

  it("answers Target.getBrowserContexts with no contexts", async () => {
    await ready;
    for (const client of replay.out.keys()) {
      const frames = framesOf(replay, client);
      expect(frames[replyIndex(frames, 1)]).toEqual({ id: 1, result: { browserContextIds: [] } });
    }
  });

  it("announces a synthetic browser target, then the real tab, then the page on setDiscoverTargets", async () => {
    await ready;
    const frames = framesOf(replay, 1);
    const created = frames
      .slice(0, replyIndex(frames, 2))
      .filter((f) => f.method === "Target.targetCreated")
      .map((f) => eventParams(f).targetInfo);
    expect(created.map((t) => t?.type)).toEqual(["browser", "tab", "page"]);
    expect(created.map((t) => t?.targetId)).toEqual(["omp-ui-bridge-browser", TAB_ID, PAGE_ID]);
    expect(created[0]?.attached).toBe(true);
    expect(frames[replyIndex(frames, 2)]).toEqual({ id: 2, result: {} });
  });

  it("attaches the tab on the client's behalf and delivers attachedToTarget before the setAutoAttach reply", async () => {
    await ready;
    for (const client of replay.out.keys()) {
      const frames = framesOf(replay, client);
      const attach = frames.findIndex(
        (f) =>
          f.method === "Target.attachedToTarget" &&
          f.sessionId === undefined &&
          eventParams(f).targetInfo?.type === "tab",
      );
      const reply = replyIndex(frames, 3);
      expect(attach, `client ${client}`).toBeGreaterThanOrEqual(0);
      expect(attach, `client ${client}`).toBeLessThan(reply);
      expect(frames[reply]).toEqual({ id: 3, result: {} });
    }
    // The root setAutoAttach itself never reaches Electron.
    expect(
      replay.debugger.commands.filter(
        (c) => c.method === "Target.setAutoAttach" && c.sessionId === undefined,
      ),
    ).toEqual([]);
  });

  it("forwards nested attach events under their tab session with the session id intact", async () => {
    await ready;
    const frames = framesOf(replay, 1);
    const nested = frames.findIndex(
      (f) => f.method === "Target.attachedToTarget" && f.sessionId === TAB_SESSION_1,
    );
    expect(nested).toBeGreaterThanOrEqual(0);
    expect(eventParams(frames[nested] as BridgeFrame).targetInfo?.type).toBe("page");
    expect(nested).toBeLessThan(replyIndex(frames, 4));
  });

  it("forwards session-scoped commands verbatim with their session ids and reports each once", async () => {
    await ready;
    const scopedIn = rows
      .filter(
        (r) => r.kind === "in" && r.sessionId !== undefined && INTERCEPTED_SCOPED[r.method ?? ""] !== true,
      )
      .map((r) => `${r.sessionId}:${r.method}`)
      .sort();
    const scopedSent = replay.debugger.commands
      .filter((c) => c.sessionId !== undefined)
      .map((c) => `${c.sessionId}:${c.method}`)
      .sort();
    expect(scopedSent).toEqual(scopedIn);

    const expectedForwarded = rows
      .filter(
        (r) =>
          r.kind === "in" &&
          (r.sessionId === undefined
            ? INTERCEPTED_ROOT[r.method ?? ""] !== true
            : INTERCEPTED_SCOPED[r.method ?? ""] !== true),
      )
      .map((r) => r.method);
    expect(replay.forwarded).toEqual(expectedForwarded);
    // Target.getTargets is answered locally and never settles.
    expect(replay.settled).toEqual(expectedForwarded.filter((m) => m !== "Target.getTargets"));
  });

  it("relays an Electron rejection as a CDP error under the client's id", async () => {
    await ready;
    const frames = framesOf(replay, 1);
    expect(frames[replyIndex(frames, 86)]).toEqual({
      id: 86,
      sessionId: "5BB8EEE01B060F26C304C2FEE9C6CAFB",
      error: { code: -32000, message: "'OMP.claimTarget' wasn't found" },
    });
  });

  it("aliases Target.createTarget to the one page", async () => {
    await ready;
    const frames = framesOf(replay, 1);
    expect(frames[replyIndex(frames, 83)]).toEqual({ id: 83, result: { targetId: PAGE_ID } });
    expect(frames[replyIndex(frames, 84)]).toEqual({ id: 84, result: { targetId: PAGE_ID } });
    expect(replay.debugger.commands.filter((c) => c.method === "Target.createTarget")).toEqual([]);
  });

  it("fakes Target.closeTarget for that client only and leaves the pane untouched", async () => {
    await ready;
    const frames = framesOf(replay, 1);
    const start = replyIndex(frames, 87) + 1;
    const end = replyIndex(frames, 88);
    expect(frames.slice(start, end)).toEqual([
      {
        method: "Target.detachedFromTarget",
        sessionId: TAB_SESSION_1,
        params: { sessionId: PAGE_SESSION_1, targetId: PAGE_ID },
      },
      {
        method: "Target.detachedFromTarget",
        params: { sessionId: TAB_SESSION_1, targetId: TAB_ID },
      },
      { method: "Target.targetDestroyed", params: { targetId: PAGE_ID } },
      { method: "Target.targetDestroyed", params: { targetId: TAB_ID } },
    ]);
    expect(frames[end]).toEqual({ id: 88, result: { success: true } });
    // Other clients never hear about it; Electron never gets a close.
    for (const client of [2, 3, 4, 5, 6]) {
      expect(framesOf(replay, client).some((f) => f.method === "Target.targetDestroyed")).toBe(false);
    }
    expect(
      replay.debugger.commands.filter(
        (c) => c.method === "Target.closeTarget" || c.method === "Page.close",
      ),
    ).toEqual([]);
  });

  it("answers Browser.close and closes only that client's socket, never Electron", async () => {
    await ready;
    const frames = framesOf(replay, 1);
    expect(frames[replyIndex(frames, 89)]).toEqual({ id: 89, result: {} });
    expect(replay.closed).toEqual([1]);
    expect(replay.debugger.commands.filter((c) => c.method === "Browser.close")).toEqual([]);
  });

  it("detaches a departing client's sessions from Electron, tolerating dead nested ones", async () => {
    await ready;
    const detached = replay.debugger.commands
      .filter((c) => c.method === "Target.detachFromTarget")
      .map((c) => c.params.sessionId);
    // Client 2 left holding its tab session and the page nested under it.
    expect(detached).toContain("4F33A24A7607AF0CDEA3008EE261DA05");
    expect(detached).toContain("043DE06FAE7E6BDEBADB294CE24E7679");
  });
});

// ---------------------------------------------------------------- stub debugger

type CommandHandler = (method: string, params: object, sessionId?: string) => Promise<unknown>;

/** A debugger over one tab and one page; `handler` overrides the default replies. */
class StubDebugger implements PaneDebugger {
  private readonly listeners: MessageListener[] = [];
  constructor(private readonly handler: CommandHandler | null = null) {}
  attach(): void {}
  detach(): void {}
  isAttached(): boolean {
    return true;
  }
  on(event: "message", cb: MessageListener): void;
  on(event: "detach", cb: (event: unknown, reason: string) => void): void;
  on(event: string, cb: MessageListener | ((event: unknown, reason: string) => void)): void {
    // Overload dispatch: the "message" signature is the one stored.
    if (event === "message") this.listeners.push(cb as MessageListener);
  }
  emit(method: string, params: unknown, sessionId: string): void {
    for (const cb of this.listeners) cb({}, method, params, sessionId);
  }
  async sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown> {
    if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "P", type: "page" } };
    if (method === "Target.getTargets") {
      return { targetInfos: [{ targetId: "T", type: "tab" }, { targetId: "P", type: "page" }] };
    }
    return this.handler === null ? {} : this.handler(method, params ?? {}, sessionId);
  }
}

describe("createBridgeSession ownership", () => {
  it("buffers a root attach that arrives before the reply naming its owner", async () => {
    const out: BridgeFrame[] = [];
    const debug: StubDebugger = new StubDebugger(async (method) => {
      if (method !== "Target.attachToTarget") return {};
      // Chromium notifies before it replies.
      debug.emit(
        "Target.attachedToTarget",
        { sessionId: "S1", targetInfo: { targetId: "P", type: "page" }, waitingForDebugger: false },
        "",
      );
      await Promise.resolve();
      return { sessionId: "S1" };
    });
    const session = createBridgeSession<string>({
      debugger: debug,
      onCommand: () => {},
      onCommandSettled: () => {},
      send: (_c, frame) => out.push(frame),
      close: () => {},
    });
    session.addClient("a");
    session.addClient("b");
    await session.handleClientMessage(
      "a",
      JSON.stringify({ id: 7, method: "Target.attachToTarget", params: { targetId: "P", flatten: true } }),
    );
    expect(out.map((f) => f.method ?? f.id)).toEqual(["Target.attachedToTarget", 7]);
    // Events on the claimed session route to its owner only.
    debug.emit("Runtime.consoleAPICalled", { type: "log" }, "S1");
    expect(out).toHaveLength(3);
    expect(out[2]).toEqual({ method: "Runtime.consoleAPICalled", params: { type: "log" }, sessionId: "S1" });
  });

  it("reports a forwarded command as settled after Electron answers, with its params, and also when it fails", async () => {
    const out: BridgeFrame[] = [];
    const sent: string[] = [];
    const settled: Array<[string, object]> = [];
    let release: () => void = () => {};
    let reached: () => void = () => {};
    const electronBusy = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const debug = new StubDebugger(async (method) => {
      if (method === "Page.captureScreenshot") {
        reached();
        return new Promise<unknown>((resolve) => {
          release = () => resolve({ data: "" });
        });
      }
      if (method === "Page.bogus") throw new Error("'Page.bogus' wasn't found");
      return {};
    });
    const session = createBridgeSession<string>({
      debugger: debug,
      onCommand: (method) => sent.push(method),
      onCommandSettled: (method, params) => settled.push([method, params]),
      send: (_c, frame) => out.push(frame),
      close: () => {},
    });
    session.addClient("a");
    const params = { clip: { x: 0, y: 0, width: 8, height: 8, scale: 1 }, captureBeyondViewport: true };
    const pending = session.handleClientMessage(
      "a",
      JSON.stringify({ id: 1, method: "Page.captureScreenshot", params, sessionId: "S1" }),
    );
    // Electron has the command and has not answered: sent, not settled.
    await electronBusy;
    expect(sent).toEqual(["Page.captureScreenshot"]);
    expect(settled).toEqual([]);
    release();
    await pending;
    expect(settled).toEqual([["Page.captureScreenshot", params]]);
    expect(out.at(-1)).toEqual({ id: 1, sessionId: "S1", result: { data: "" } });

    await session.handleClientMessage("a", JSON.stringify({ id: 2, method: "Page.bogus", sessionId: "S1" }));
    expect(out.at(-1)).toMatchObject({ id: 2, error: { code: -32000 } });
    expect(settled.at(-1)).toEqual(["Page.bogus", {}]);
  });
});

// ---------------------------------------------------------------- target scoping (#531)

/** A debugger whose root lists the whole app: the omp-ui renderer beside two same-context panes. */
class AppDebugger extends StubDebugger {
  /** The tab that reports page P when asked to auto-attach; the other pane's tab reports P2. */
  readonly pagesByTab: Readonly<Record<string, string>> = { T: "P", T2: "P2" };
  async sendCommand(method: string, params?: object, sessionId?: string): Promise<unknown> {
    if (method === "Target.getTargetInfo") {
      return { targetInfo: { targetId: "P", type: "page", url: "about:blank", browserContextId: "pane" } };
    }
    if (method === "Target.getTargets") {
      return {
        targetInfos: [
          { targetId: "RT", type: "tab", url: "file:///renderer/index.html", browserContextId: "default" },
          { targetId: "RP", type: "page", url: "file:///renderer/index.html", browserContextId: "default" },
          { targetId: "T2", type: "tab", url: "about:blank", browserContextId: "pane" },
          { targetId: "P2", type: "page", url: "about:blank", browserContextId: "pane" },
          { targetId: "T", type: "tab", url: "about:blank", browserContextId: "pane" },
          { targetId: "P", type: "page", url: "about:blank", browserContextId: "pane" },
        ],
      };
    }
    if (method === "Target.attachToTarget") {
      const targetId = params !== undefined && "targetId" in params ? String(params.targetId) : "";
      return { sessionId: `S-${targetId}` };
    }
    if (method === "Target.setAutoAttach" && sessionId !== undefined) {
      const tab = sessionId.slice(2);
      const page = this.pagesByTab[tab];
      if (page !== undefined) {
        this.emit(
          "Target.attachedToTarget",
          { sessionId: `S-${page}`, targetInfo: { targetId: page, type: "page" }, waitingForDebugger: false },
          sessionId,
        );
      }
      return {};
    }
    return {};
  }
}

describe("createBridgeSession target scoping", () => {
  function appSession(out: BridgeFrame[], commands: string[]) {
    const debug = new AppDebugger();
    const session = createBridgeSession<string>({
      debugger: debug,
      onCommand: (method) => commands.push(method),
      onCommandSettled: () => {},
      send: (_c, frame) => out.push(frame),
      close: () => {},
    });
    session.addClient("a");
    return { debug, session };
  }
  const message = (id: number, method: string, params: object = {}): string =>
    JSON.stringify({ id, method, params });

  it("announces only the pane's own tab and page, found among other panes by probing the tab", async () => {
    const out: BridgeFrame[] = [];
    const { session } = appSession(out, []);
    await session.handleClientMessage("a", message(1, "Target.setDiscoverTargets", { discover: true }));
    const created = out.filter((f) => f.method === "Target.targetCreated").map((f) => f.params);
    expect(created).toEqual([
      expect.objectContaining({ targetInfo: expect.objectContaining({ targetId: "omp-ui-bridge-browser" }) }),
      expect.objectContaining({ targetInfo: expect.objectContaining({ targetId: "T" }) }),
      expect.objectContaining({ targetInfo: expect.objectContaining({ targetId: "P" }) }),
    ]);
    await session.handleClientMessage("a", message(2, "Target.getTargets"));
    expect(out.at(-1)).toEqual({
      id: 2,
      result: {
        targetInfos: [
          expect.objectContaining({ targetId: "omp-ui-bridge-browser" }),
          expect.objectContaining({ targetId: "T" }),
          expect.objectContaining({ targetId: "P" }),
        ],
      },
    });
  });

  it("refuses to attach to or name a target the pane does not own", async () => {
    const out: BridgeFrame[] = [];
    const commands: string[] = [];
    const { session } = appSession(out, commands);
    await session.handleClientMessage("a", message(1, "Target.attachToTarget", { targetId: "RP", flatten: true }));
    expect(out.at(-1)).toEqual({ id: 1, error: { code: -32000, message: "No target with given id found" } });
    await session.handleClientMessage("a", message(2, "Target.activateTarget", { targetId: "RT" }));
    expect(out.at(-1)).toEqual({ id: 2, error: { code: -32000, message: "No target with given id found" } });
    expect(commands).toEqual([]);
    await session.handleClientMessage("a", message(3, "Target.attachToTarget", { targetId: "P", flatten: true }));
    expect(out.at(-1)).toEqual({ id: 3, result: { sessionId: "S-P" } });
  });

  it("never broadcasts another target's lifecycle events to a discovering client", async () => {
    const out: BridgeFrame[] = [];
    const { debug, session } = appSession(out, []);
    await session.handleClientMessage("a", message(1, "Target.setDiscoverTargets", { discover: true }));
    const before = out.length;
    debug.emit("Target.targetInfoChanged", { targetInfo: { targetId: "RP", type: "page", url: "file:///x" } }, "");
    debug.emit("Target.targetDestroyed", { targetId: "RT" }, "");
    debug.emit("Target.targetCreated", { targetInfo: { targetId: "P3", type: "page", url: "about:blank" } }, "");
    expect(out).toHaveLength(before);
    debug.emit("Target.targetInfoChanged", { targetInfo: { targetId: "P", type: "page", url: "http://x/" } }, "");
    expect(out.at(-1)?.method).toBe("Target.targetInfoChanged");
  });
});

// ---------------------------------------------------------------- U6: gate

const TOKEN = mintRemoteToken();
const PORT = 41234;

function gateInput(overrides: Partial<BridgeRequest>): BridgeRequest {
  return {
    remoteAddress: "127.0.0.1",
    host: `127.0.0.1:${PORT}`,
    origin: undefined,
    url: `/${TOKEN}`,
    port: PORT,
    token: TOKEN,
    tokenHitAt: null,
    now: 100_000,
    clients: 0,
    ...overrides,
  };
}

describe("gateBridgeRequest", () => {
  it("forbids anything not from loopback, not addressed to 127.0.0.1:PORT, or carrying an Origin", () => {
    expect(gateBridgeRequest(gateInput({ remoteAddress: "192.168.1.20" }))).toEqual({ kind: "forbidden" });
    expect(gateBridgeRequest(gateInput({ remoteAddress: undefined }))).toEqual({ kind: "forbidden" });
    expect(gateBridgeRequest(gateInput({ host: `localhost:${PORT}` }))).toEqual({ kind: "forbidden" });
    expect(gateBridgeRequest(gateInput({ host: `127.0.0.1:${PORT + 1}` }))).toEqual({ kind: "forbidden" });
    expect(gateBridgeRequest(gateInput({ origin: "http://evil" }))).toEqual({ kind: "forbidden" });
    expect(gateBridgeRequest(gateInput({ origin: "null" }))).toEqual({ kind: "forbidden" });
    // Forbidden wins even over a perfectly formed tokened path.
    expect(
      gateBridgeRequest(gateInput({ origin: "http://127.0.0.1", url: `/${TOKEN}/json/version` })),
    ).toEqual({ kind: "forbidden" });
  });

  it("accepts every loopback address form", () => {
    for (const remoteAddress of ["127.0.0.1", "::ffff:127.0.0.1", "::1"]) {
      expect(gateBridgeRequest(gateInput({ remoteAddress }))).toEqual({ kind: "upgrade" });
    }
  });

  it("does not know paths under a wrong or missing token", () => {
    const other = mintRemoteToken();
    expect(gateBridgeRequest(gateInput({ url: `/${other}` }))).toEqual({ kind: "not-found" });
    expect(gateBridgeRequest(gateInput({ url: `/${other}/json/version` }))).toEqual({ kind: "not-found" });
    expect(gateBridgeRequest(gateInput({ url: `/${TOKEN.slice(0, -1)}` }))).toEqual({ kind: "not-found" });
    expect(gateBridgeRequest(gateInput({ url: `/${TOKEN}/json/list` }))).toEqual({ kind: "not-found" });
    expect(gateBridgeRequest(gateInput({ url: "/" }))).toEqual({ kind: "not-found" });
    expect(gateBridgeRequest(gateInput({ url: "/json/list" }))).toEqual({ kind: "not-found" });
  });

  it("answers the root /json/version only within the window after a tokened hit", () => {
    expect(gateBridgeRequest(gateInput({ url: `/${TOKEN}/json/version` }))).toEqual({
      kind: "version",
      tokened: true,
    });
    const hit = 100_000;
    expect(gateBridgeRequest(gateInput({ url: "/json/version", tokenHitAt: null, now: hit }))).toEqual({
      kind: "not-found",
    });
    expect(
      gateBridgeRequest(
        gateInput({ url: "/json/version", tokenHitAt: hit, now: hit + BROWSER_PANE_ROOT_VERSION_WINDOW_MS }),
      ),
    ).toEqual({ kind: "version", tokened: false });
    expect(
      gateBridgeRequest(
        gateInput({
          url: "/json/version",
          tokenHitAt: hit,
          now: hit + BROWSER_PANE_ROOT_VERSION_WINDOW_MS + 1,
        }),
      ),
    ).toEqual({ kind: "not-found" });
  });

  it("reports busy for the client past the cap", () => {
    expect(gateBridgeRequest(gateInput({ clients: BROWSER_PANE_MAX_CDP_CLIENTS - 1 }))).toEqual({
      kind: "upgrade",
    });
    expect(gateBridgeRequest(gateInput({ clients: BROWSER_PANE_MAX_CDP_CLIENTS }))).toEqual({ kind: "busy" });
  });
});

// ---------------------------------------------------------------- U6: listener

function fakePane(userAgent: string): PaneContents {
  // Only the two members the bridge reads exist; the host owns the rest of the seam.
  const pane = { debugger: new StubDebugger(), userAgent } as unknown as PaneContents;
  return pane;
}

interface Harness {
  listener: BridgeListener;
  token: string;
  counts: number[];
  /** Resolves when `onClientCount` next reports `n`. */
  countReached: (n: number) => Promise<void>;
  firstClientCalls: () => number;
}

const open: BridgeListener[] = [];
const sockets: WebSocket[] = [];

afterEach(() => {
  for (const ws of sockets) ws.terminate();
  sockets.length = 0;
  for (const l of open) l.close();
  open.length = 0;
});

async function serve(opts: { now?: () => number; userAgent?: string } = {}): Promise<Harness> {
  const token = mintRemoteToken();
  const counts: number[] = [];
  const waiters: Array<{ n: number; resolve: () => void }> = [];
  let firstClientCalls = 0;
  let pane: PaneContents | null = null;
  const listener = await createBridgeListener({
    token,
    onFirstClient: async () => {
      firstClientCalls += 1;
      pane = fakePane(opts.userAgent ?? "PaneUA/1");
    },
    pane: () => pane,
    onClientCount: (n) => {
      counts.push(n);
      for (const w of waiters.splice(0)) {
        if (w.n === n) w.resolve();
        else waiters.push(w);
      }
    },
    onCommand: () => {},
    onCommandSettled: () => {},
    appVersion: "9.9.9",
    now: opts.now,
  });
  open.push(listener);
  return {
    listener,
    token,
    counts,
    countReached: (n) => new Promise<void>((resolve) => waiters.push({ n, resolve })),
    firstClientCalls: () => firstClientCalls,
  };
}

function connect(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  const ws = new WebSocket(url, { headers });
  sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("close", () => reject(new Error("closed before open")));
    ws.once("error", () => {
      /* the close handler settles */
    });
  });
}

function nextJson(ws: WebSocket): Promise<BridgeFrame> {
  return new Promise((resolve) => {
    ws.once("message", (raw: Buffer) => resolve(JSON.parse(raw.toString("utf8")) as BridgeFrame));
  });
}

function get(port: number, path: string, host?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path, method: "GET", headers: host === undefined ? {} : { host } },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("createBridgeListener", () => {
  it("destroys an upgrade carrying an Origin header and accepts the tokened one", async () => {
    const h = await serve();
    const wsUrl = `ws://127.0.0.1:${h.listener.port}/${h.token}`;
    await expect(connect(wsUrl, { origin: "http://evil" })).rejects.toThrow("closed before open");
    expect(h.listener.clientCount()).toBe(0);
    expect(h.firstClientCalls()).toBe(0);

    const ws = await connect(wsUrl);
    expect(h.listener.clientCount()).toBe(1);
    expect(h.firstClientCalls()).toBe(1);
    expect(h.counts).toEqual([1]);
    const reply = nextJson(ws);
    ws.send(JSON.stringify({ id: 1, method: "Target.getBrowserContexts" }));
    expect(await reply).toEqual({ id: 1, result: { browserContextIds: [] } });

    const gone = h.countReached(0);
    ws.close();
    await gone;
    expect(h.counts).toEqual([1, 0]);
    expect(h.listener.clientCount()).toBe(0);
  });

  it("refuses an upgrade on the wrong token path", async () => {
    const h = await serve();
    await expect(connect(`ws://127.0.0.1:${h.listener.port}/${mintRemoteToken()}`)).rejects.toThrow(
      "closed before open",
    );
    expect(h.listener.clientCount()).toBe(0);
  });

  it("serves /json/version on the tokened path, then bare within the window, with the debugger URL", async () => {
    let clock = 1_000;
    const h = await serve({ now: () => clock, userAgent: "Mozilla/5.0 Pane" });
    expect((await get(h.listener.port, "/json/version")).status).toBe(404);

    const tokened = await get(h.listener.port, `/${h.token}/json/version`);
    expect(tokened.status).toBe(200);
    expect(JSON.parse(tokened.body)).toEqual({
      Browser: "omp-ui-browser-pane/9.9.9",
      "Protocol-Version": "1.3",
      "User-Agent": "Mozilla/5.0 Pane",
      webSocketDebuggerUrl: `ws://127.0.0.1:${h.listener.port}/${h.token}`,
    });

    clock += BROWSER_PANE_ROOT_VERSION_WINDOW_MS;
    const bare = await get(h.listener.port, "/json/version");
    expect(bare.status).toBe(200);
    expect(JSON.parse(bare.body)).toMatchObject({
      webSocketDebuggerUrl: `ws://127.0.0.1:${h.listener.port}/${h.token}`,
    });

    clock += 1;
    expect((await get(h.listener.port, "/json/version")).status).toBe(404);
    expect((await get(h.listener.port, `/${h.token}/json/list`)).status).toBe(404);
  });

  it("creates the page for the first tokened version hit and refuses a foreign Host", async () => {
    const h = await serve();
    expect(h.firstClientCalls()).toBe(0);
    expect((await get(h.listener.port, `/${h.token}/json/version`)).status).toBe(200);
    expect(h.firstClientCalls()).toBe(1);
    expect((await get(h.listener.port, `/${h.token}/json/version`)).status).toBe(200);
    expect(h.firstClientCalls()).toBe(1);
    expect(
      (await get(h.listener.port, `/${h.token}/json/version`, `evil.example:${h.listener.port}`)).status,
    ).toBe(403);
  });

  it("gives each listener its own token and port; the old token opens nothing on the new one", async () => {
    const a = await serve();
    const b = await serve();
    expect(a.token).not.toBe(b.token);
    expect(a.listener.port).not.toBe(b.listener.port);
    expect(a.listener.url).toBe(`http://127.0.0.1:${a.listener.port}/${a.token}`);
    expect(b.listener.url).toBe(`http://127.0.0.1:${b.listener.port}/${b.token}`);
    expect((await get(b.listener.port, `/${a.token}/json/version`)).status).toBe(404);
    expect((await get(b.listener.port, `/${b.token}/json/version`)).status).toBe(200);
    await expect(connect(`ws://127.0.0.1:${b.listener.port}/${a.token}`)).rejects.toThrow(
      "closed before open",
    );
  });

  it("turns away the client past the cap with 503 while the others stay connected", async () => {
    const h = await serve();
    const wsUrl = `ws://127.0.0.1:${h.listener.port}/${h.token}`;
    const clients: WebSocket[] = [];
    for (let i = 0; i < BROWSER_PANE_MAX_CDP_CLIENTS; i++) clients.push(await connect(wsUrl));
    expect(h.listener.clientCount()).toBe(BROWSER_PANE_MAX_CDP_CLIENTS);
    const extra = new WebSocket(wsUrl);
    sockets.push(extra);
    const status = await new Promise<number>((resolve) => {
      extra.once("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0));
      extra.once("error", () => resolve(-1));
    });
    expect(status).toBe(503);
    expect(clients.every((ws) => ws.readyState === WebSocket.OPEN)).toBe(true);
  });

  it("close() terminates every client and frees the port", async () => {
    const h = await serve();
    const ws = await connect(`ws://127.0.0.1:${h.listener.port}/${h.token}`);
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));
    h.listener.close();
    open.length = 0;
    await closed;
    await expect(get(h.listener.port, "/json/version")).rejects.toThrow();
  });
});
