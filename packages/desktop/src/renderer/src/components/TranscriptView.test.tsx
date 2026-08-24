// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  planProposalItem,
  type CommandItem,
  type RenderItem,
  type ToolItem,
} from "../lib/transcript";
// Statically imported even though the module is mocked: vi.mock hoists above
// imports, so this binding is the mock, not the window.ompBackend reader.
import { backend } from "../backend";
import { rpcTabState } from "../test/fixtures";
import { useStore } from "../store";
import { TranscriptView, type FindState } from "./TranscriptView";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

/** Parent-driven ToolCard renders, for the row-memoization contract (issue #187). */
const toolCardRenders = vi.hoisted((): string[] => []);
vi.mock("./ToolCard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ToolCard")>();
  return {
    ...actual,
    ToolCard: function ToolCardProbe({ item, tabId }: { item: ToolItem; tabId?: string }) {
      toolCardRenders.push(item.id);
      return <actual.ToolCard item={item} tabId={tabId} />;
    },
  };
});

// jsdom has no ResizeObserver, and TranscriptView's mount effect constructs
// one unconditionally. The stub records the callback so tests can fire it the
// way a browser would.
let resizeCallback: ResizeObserverCallback | null = null;
class ResizeObserverStub {
  constructor(cb: ResizeObserverCallback) {
    resizeCallback = cb;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;

// NoticeLine's open/reveal actions call the bridge directly; the module reads
// window.ompBackend at load, so mock the module instead of the global.
vi.mock("../backend", () => ({
  backend: {
    openPath: vi.fn(async () => {}),
    showPathInFolder: vi.fn(async () => {}),
  },
}));

function assistant(id: string, text: string): RenderItem {
  return { kind: "assistant", id, text, thinking: "", streaming: false };
}

function render(items: RenderItem[], tabId?: string): { el: HTMLDivElement; root: Root } {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  act(() => {
    root.render(<TranscriptView items={items} tabId={tabId} />);
  });
  return { el, root };
}

// jsdom does no layout: scrollHeight/clientHeight are defined per test and
// scrollTop is settable, which is enough to drive the follow-mode machine.
function scrollEl(el: HTMLDivElement): HTMLDivElement {
  const scroller = el.querySelector<HTMLDivElement>(".overflow-y-auto");
  if (!scroller) throw new Error("scroll container not found");
  return scroller;
}

function setGeometry(scroller: HTMLDivElement, scrollHeight: number, clientHeight: number) {
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: scrollHeight });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: clientHeight });
}

function scrollTo(scroller: HTMLDivElement, top: number) {
  scroller.scrollTop = top;
  act(() => {
    scroller.dispatchEvent(new Event("scroll"));
  });
}

describe("TranscriptView error containment", () => {
  it("renders healthy rows normally", () => {
    const { el, root } = render([assistant("a1", "hello")]);
    expect(el.textContent).toContain("hello");
    expect(el.textContent).not.toContain("message failed to render");
    act(() => root.unmount());
  });

  it("collapses a throwing row to a broken-row card and keeps its siblings", () => {
    // `notes: undefined` poisons AdvisoryNotes the same way the stale-HMR
    // table bug did: a field the renderer `.map`s over is missing.
    const poisoned = {
      kind: "advisory",
      id: "bad",
      notes: undefined,
    } as unknown as RenderItem;

    // React logs caught errors loudly in dev; silence for the assertion.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { el, root } = render([assistant("a1", "before"), poisoned, assistant("a2", "after")]);
    spy.mockRestore();

    expect(el.textContent).toContain("before");
    expect(el.textContent).toContain("after");
    expect(el.textContent).toContain("message failed to render");
    act(() => root.unmount());
  });
});

describe("TranscriptView follow mode", () => {
  // Render with geometry in place and deliver the pin the browser produces
  // via the ResizeObserver's initial-observe callback (jsdom fires neither
  // layout nor the initial observe).
  function renderPinned(items: RenderItem[], scrollHeight: number, clientHeight: number) {
    const { el, root } = render(items);
    const scroller = scrollEl(el);
    setGeometry(scroller, scrollHeight, clientHeight);
    act(() => {
      resizeCallback!({} as never, {} as never);
    });
    return { el, root, scroller };
  }

  function jumpButton(el: HTMLDivElement): HTMLButtonElement {
    const button = [...el.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("jump to latest"),
    );
    if (!button) throw new Error("jump to latest button not found");
    return button;
  }

  it("stays pinned through a burst of new items", () => {
    const three = [assistant("a1", "one"), assistant("a2", "two"), assistant("a3", "three")];
    const { el, root, scroller } = renderPinned(three, 1000, 500);
    expect(scroller.scrollTop).toBe(1000);

    const six = [
      ...three,
      assistant("a4", "four"),
      assistant("a5", "five"),
      assistant("a6", "six"),
    ];
    setGeometry(scroller, 1400, 500);
    act(() => {
      root.render(<TranscriptView items={six} />);
    });
    expect(scroller.scrollTop).toBe(1400);

    // The echo of our own pin is not user intent: no "jump to latest".
    scrollTo(scroller, 1400);
    expect(el.textContent).not.toContain("jump to latest");
    act(() => root.unmount());
  });

  it("stays pinned when content resizes without new items", () => {
    const three = [assistant("a1", "one"), assistant("a2", "two"), assistant("a3", "three")];
    const { el, root, scroller } = renderPinned(three, 1000, 500);
    expect(scroller.scrollTop).toBe(1000);

    // ToolCard expansion grows the content without touching `items`.
    setGeometry(scroller, 1600, 500);
    act(() => {
      resizeCallback!({} as never, {} as never);
    });
    expect(scroller.scrollTop).toBe(1600);
    expect(el.textContent).not.toContain("jump to latest");
    act(() => root.unmount());
  });

  it("a deliberate scroll up exits follow mode and stays put", () => {
    const three = [assistant("a1", "one"), assistant("a2", "two"), assistant("a3", "three")];
    const { el, root, scroller } = renderPinned(three, 1400, 500);
    expect(scroller.scrollTop).toBe(1400);

    // Distance 600 > 64 and moving upward: deliberate leave of the tail.
    scrollTo(scroller, 300);
    expect(el.textContent).toContain("jump to latest");

    const five = [...three, assistant("a4", "four"), assistant("a5", "five")];
    setGeometry(scroller, 1800, 500);
    act(() => {
      root.render(<TranscriptView items={five} />);
    });
    expect(scroller.scrollTop).toBe(300);
    expect(el.textContent).toContain("jump to latest");
    act(() => root.unmount());
  });

  it("scrolling back to the bottom resumes follow", () => {
    const three = [assistant("a1", "one"), assistant("a2", "two"), assistant("a3", "three")];
    const { el, root, scroller } = renderPinned(three, 1800, 500);
    scrollTo(scroller, 300);
    expect(el.textContent).toContain("jump to latest");

    // Distance 50 ≤ 64: back at the tail, follow resumes and re-pins.
    scrollTo(scroller, 1250);
    expect(el.textContent).not.toContain("jump to latest");
    expect(scroller.scrollTop).toBe(1800);
    act(() => root.unmount());
  });

  it("scrolling back to the exact bottom resumes follow", () => {
    const three = [assistant("a1", "one"), assistant("a2", "two"), assistant("a3", "three")];
    const { el, root, scroller } = renderPinned(three, 1800, 500);
    scrollTo(scroller, 300);
    expect(el.textContent).toContain("jump to latest");

    // scrollTop 1800 is exactly the value the last pin wrote (the clamped
    // max, where a browser terminates "reach the bottom"). Without the guard
    // removal this event is misread as the pin's echo and follow stays off.
    scrollTo(scroller, 1800);
    expect(el.textContent).not.toContain("jump to latest");
    expect(scroller.scrollTop).toBe(1800);
    act(() => root.unmount());
  });

  it("resumes follow at the exact bottom and re-pins through a burst", () => {
    const three = [assistant("a1", "one"), assistant("a2", "two"), assistant("a3", "three")];
    const { el, root, scroller } = renderPinned(three, 1800, 500);
    scrollTo(scroller, 300);
    expect(el.textContent).toContain("jump to latest");

    // Exact-bottom re-entry resumes follow.
    scrollTo(scroller, 1800);
    expect(el.textContent).not.toContain("jump to latest");
    expect(scroller.scrollTop).toBe(1800);

    // A burst arriving right after re-entry must stay pinned.
    setGeometry(scroller, 2000, 500);
    act(() => {
      root.render(<TranscriptView items={[...three, assistant("a4", "four")]} />);
    });
    expect(scroller.scrollTop).toBe(2000);
    expect(el.textContent).not.toContain("jump to latest");
    act(() => root.unmount());
  });

  it("jump to latest resumes follow", () => {
    const three = [assistant("a1", "one"), assistant("a2", "two"), assistant("a3", "three")];
    const { el, root, scroller } = renderPinned(three, 1800, 500);
    scrollTo(scroller, 300);
    expect(el.textContent).toContain("jump to latest");

    act(() => {
      jumpButton(el).dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(el.textContent).not.toContain("jump to latest");
    expect(scroller.scrollTop).toBe(1800);
    act(() => root.unmount());
  });
});

describe("UsageStrip", () => {
  it("ends the receipt with the turn's local completion time", () => {
    const timestamp = new Date(2026, 7, 5, 14, 32, 7).getTime();
    const item: RenderItem = {
      kind: "assistant",
      id: "a1",
      text: "done",
      thinking: "",
      streaming: false,
      model: "openai/gpt-5.6-sol",
      usage: { input: 3, output: 268, cacheRead: 0, cacheWrite: 0, total: 271, cost: 0 },
      timestamp,
    };
    const { el, root } = render([item]);

    const at = new Date(timestamp);
    const expected = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const stamp = el.querySelector(".text-ink-faint span[title]");
    expect(stamp).not.toBeNull();
    expect(stamp!.textContent).toBe(expected);
    expect(stamp!.getAttribute("title")).toBe(at.toLocaleString());
    act(() => root.unmount());
  });
});

describe("NoticeLine path actions (issue #84)", () => {
  function notice(text: string, path?: string): RenderItem {
    return { kind: "notice", id: "n1", text, level: "info", ...(path === undefined ? {} : { path }) };
  }

  it("opens the file on text click and reveals it on the glyph click", () => {
    const { el, root } = render([notice("exported to /tmp/session.html", "/tmp/session.html")]);

    const open = el.querySelector<HTMLButtonElement>('button[title="open /tmp/session.html"]');
    const reveal = el.querySelector<HTMLButtonElement>('button[aria-label="reveal in file manager"]');
    expect(open).not.toBeNull();
    expect(reveal).not.toBeNull();
    expect(open!.textContent).toBe("exported to /tmp/session.html");

    act(() => {
      open!.click();
    });
    expect(vi.mocked(backend.openPath).mock.calls).toEqual([["/tmp/session.html"]]);
    expect(vi.mocked(backend.showPathInFolder).mock.calls).toEqual([]);

    act(() => {
      reveal!.click();
    });
    expect(vi.mocked(backend.showPathInFolder).mock.calls).toEqual([["/tmp/session.html"]]);
    act(() => root.unmount());
  });

  it("keeps a pathless notice inert text", () => {
    const { el, root } = render([notice("plan approved")]);
    expect(el.textContent).toContain("plan approved");
    expect(el.querySelector("button")).toBeNull();
    act(() => root.unmount());
  });
});

describe("PlanCard (issue #93)", () => {
  it("renders the inline plan proposal with its title and pending status", () => {
    const { el, root } = render([planProposalItem("Auth refresh", "local://auth-plan.md", null)]);
    expect(el.textContent).toContain("Auth refresh");
    expect(el.textContent).toContain("pending");
    // No text loaded yet — the card falls back to the plan's path.
    expect(el.textContent).toContain("local://auth-plan.md");
    act(() => root.unmount());
  });

  it("renders a loaded html plan through the guarded empty-sandbox iframe", () => {
    const html = "<h1>Auth refresh</h1><p>html-plan-body</p>";
    const item = {
      ...planProposalItem("Auth refresh", "local://auth-plan.html", null),
      text: html,
    };
    const { el, root } = render([item]);

    const disclosure = [...el.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
      button.textContent?.includes("show plan"),
    );
    expect(disclosure).toBeDefined();
    act(() => disclosure!.click());

    const frame = el.querySelector<HTMLIFrameElement>('iframe[title="proposed plan"]');
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute("sandbox")).toBe("");
    expect(frame!.getAttribute("srcdoc")).toContain(html);
    expect(frame!.getAttribute("srcdoc")).toContain('id="omp-ui-plan-guardrails"');
    act(() => root.unmount());
  });
});

describe("row memoization (issue #187)", () => {
  beforeEach(() => {
    toolCardRenders.length = 0;
  });

  it("re-renders only the changed tail row on a stream update", () => {
    const settled: RenderItem = {
      kind: "tool",
      id: "t1",
      toolCallId: "t1",
      name: "bash",
      args: { command: "make" },
      status: "done",
      resultText: "built",
    };
    const running: RenderItem = {
      kind: "tool",
      id: "t2",
      toolCallId: "t2",
      name: "bash",
      args: { command: "npm test" },
      status: "running",
    };
    const { el, root } = render([settled, running]);
    expect(toolCardRenders).toEqual(["t1", "t2"]);

    // Tail-only update: `reduceEvent` copies the changed item, so t1's row
    // props stay shallow-equal and memo skips it entirely.
    const finished = { ...running, status: "done" as const, resultText: "ok" };
    act(() => root.render(<TranscriptView items={[settled, finished]} />));

    expect(toolCardRenders).toEqual(["t1", "t2", "t2"]);
    expect(el.textContent).toContain("ok");
    act(() => root.unmount());
  });
});

describe("stream-stall indicator (issue #228)", () => {
  const TAB = "tab-stall";

  const runningTool: RenderItem = {
    kind: "tool",
    id: "t1",
    toolCallId: "t1",
    name: "bash",
    args: { command: "sleep 40" },
    status: "running",
  };

  beforeEach(() => {
    useStore.setState({ rpc: {} });
  });

  it("reads the tab's stall field into the running chip and freezes the sweep", () => {
    useStore.setState({
      rpc: { [TAB]: { ...rpcTabState(), status: "running", streamStallMs: 30_000 } },
    });
    const { el, root } = render([runningTool], TAB);
    expect(el.textContent).toContain("stalled 30.0s");
    // The chip stays copper ("running, attention") with its observation-only
    // tooltip (#228, #179) — it does not flip to an error tone.
    const chip = el.querySelector('span[title^="No model-stream frame"]');
    expect(chip?.className).toContain("text-copper");
    const sweep = el.querySelector(".animate-sweep");
    expect(sweep?.className).toContain("paused");
    act(() => root.unmount());
  });

  it("keeps the plain running chip and a live sweep without a stall field", () => {
    useStore.setState({
      rpc: { [TAB]: { ...rpcTabState(), status: "running" } },
    });
    const { el, root } = render([runningTool], TAB);
    expect(el.textContent).toContain("running");
    expect(el.textContent).not.toContain("stalled");
    const sweep = el.querySelector(".animate-sweep");
    expect(sweep?.className).not.toContain("paused");
    act(() => root.unmount());
  });

  it("mounts without a tab (SubagentView shape) and shows plain running", () => {
    const { el, root } = render([runningTool]);
    expect(el.textContent).toContain("running");
    expect(el.textContent).not.toContain("stalled");
    act(() => root.unmount());
  });
});

describe("command rows (slash-command parity)", () => {
  function command(status: CommandItem["status"], extra?: Partial<CommandItem>): RenderItem {
    return { kind: "command", id: `c-${status}`, name: "mcp", args: "reauth linear", status, ...extra };
  }

  const TAB = "tab-command";
  /** omp's verbatim refusal from its non-TUI slash handler (issue #243). */
  const TUI_REFUSAL = "/mcp reauth requires OAuth or browser flows only available in the TUI client.";

  function handoffButton(el: HTMLDivElement): HTMLButtonElement | undefined {
    return [...el.querySelectorAll("button")].find((b) => b.textContent === "run in omp TUI");
  }

  beforeEach(() => {
    useStore.setState({ rpc: {}, startTuiHandoff: vi.fn() });
  });

  it("shows the literal line with a live caret while running", () => {
    const { el, root } = render([command("running")]);
    expect(el.textContent).toContain("/mcp reauth linear");
    expect(el.querySelector(".animate-caret")).not.toBeNull();
    act(() => root.unmount());
  });

  it("omits the trailing space when args are empty", () => {
    const { el, root } = render([
      { kind: "command", id: "c0", name: "usage", args: "", status: "done" },
    ]);
    expect(el.textContent).toContain("/usage");
    expect(el.textContent).not.toContain("/usage ");
    act(() => root.unmount());
  });

  it("settles done to a quiet check", () => {
    const { el, root } = render([command("done")]);
    expect(el.textContent).toContain("✓");
    expect(el.querySelector(".animate-caret")).toBeNull();
    act(() => root.unmount());
  });

  it("renders failed in rose with the rpc error on a second line", () => {
    const { el, root } = render([command("failed", { error: "session is busy" })]);
    expect(el.textContent).toContain("session is busy");
    const line = [...el.querySelectorAll(".text-rose")];
    expect(line.length).toBeGreaterThanOrEqual(2); // command line + error line
    act(() => root.unmount());
  });

  it("renders agent status with no affix at all", () => {
    const { el, root } = render([command("agent")]);
    expect(el.textContent).toContain("/mcp reauth linear");
    expect(el.textContent).not.toContain("✓");
    expect(el.querySelector(".animate-caret")).toBeNull();
    act(() => root.unmount());
  });

  it("shows command_output as a selectable preformatted block", () => {
    const { el, root } = render([command("done", { output: "tokens: 1234\ncost: $0.02" })]);
    const pre = [...el.querySelectorAll("pre")].find((p) =>
      p.textContent?.includes("tokens: 1234"),
    );
    expect(pre).toBeDefined();
    expect(pre!.getAttribute("data-selectable")).not.toBeNull();
    expect(pre!.className).toContain("whitespace-pre-wrap");
    act(() => root.unmount());
  });

  it("keeps a command row out of the adjacent user group", () => {
    const user: RenderItem = { kind: "user", id: "u1", text: "hello" };
    const { el, root } = render([user, command("done")]);
    // The user bubble and the command slab are separate runs: the slab is
    // never inside the right-aligned user column.
    const slab = el.querySelector(".bg-sunken.font-mono");
    expect(slab).not.toBeNull();
    expect(slab!.closest(".items-end")).toBeNull();
    act(() => root.unmount());
  });

  it("offers the TUI handoff on omp's terminal-only refusal and stages the line", () => {
    const { el, root } = render([command("done", { output: TUI_REFUSAL })], TAB);
    const button = handoffButton(el);
    expect(button).toBeDefined();
    act(() => button!.click());
    expect(vi.mocked(useStore.getState().startTuiHandoff).mock.calls).toEqual([
      [TAB, "/mcp reauth linear"],
    ]);
    act(() => root.unmount());
  });

  it("leaves ordinary command output without a handoff button", () => {
    const { el, root } = render([command("done", { output: "linear  http  connected" })], TAB);
    expect(handoffButton(el)).toBeUndefined();
    act(() => root.unmount());
  });

  it("withholds the handoff in the subagent view, which owns no tab", () => {
    const { el, root } = render([command("done", { output: TUI_REFUSAL })]);
    expect(el.textContent).toContain("the TUI client");
    expect(handoffButton(el)).toBeUndefined();
    act(() => root.unmount());
  });
});

describe("in-session find (issue #270)", () => {
  // jsdom has no scrollIntoView; the jump effect centres the active row with
  // it, exactly like the palettes do.
  const scrollIntoViewSpy = vi.fn();
  // jsdom leaves scrollIntoView undefined; restore whatever was there (if
  // anything) after the suite.
  const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

  beforeEach(() => {
    scrollIntoViewSpy.mockClear();
    HTMLElement.prototype.scrollIntoView = scrollIntoViewSpy;
  });

  afterEach(() => {
    HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
  });

  function renderFind(items: RenderItem[], find?: FindState | null) {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const root = createRoot(el);
    act(() => {
      root.render(<TranscriptView items={items} find={find ?? null} />);
    });
    return { el, root };
  }

  function four() {
    return [
      assistant("a1", "one"),
      assistant("a2", "two"),
      assistant("a3", "three"),
      assistant("a4", "four"),
    ];
  }

  function wrapper(el: HTMLDivElement, id: string): HTMLElement {
    const node = el.querySelector<HTMLElement>(`[data-item-id="${id}"]`);
    if (!node) throw new Error(`row wrapper for ${id} not found`);
    return node;
  }

  it("washes matched rows, centres the active match, and exits follow mode", () => {
    const { el, root } = renderFind(four(), {
      ids: ["a1", "a2", "a3"],
      activeId: "a2",
      nonce: 1,
    });
    // The active match is mid-list: centreing it leaves the tail behind.
    expect(el.textContent).toContain("jump to latest");
    expect(wrapper(el, "a2").className).toBe("find-hit find-hit-active");
    expect(wrapper(el, "a1").className).toBe("find-hit");
    expect(wrapper(el, "a3").className).toBe("find-hit");
    // An unmatched row stays plain.
    expect(wrapper(el, "a4").className).toBe("");
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: "center" });
    act(() => root.unmount());
  });

  it("leaves follow mode untouched when the active match is the last row", () => {
    const { el, root } = renderFind(four(), {
      ids: ["a1", "a2", "a3", "a4"],
      activeId: "a4",
      nonce: 1,
    });
    expect(el.textContent).not.toContain("jump to latest");
    expect(wrapper(el, "a4").className).toBe("find-hit find-hit-active");
    expect(scrollIntoViewSpy).toHaveBeenCalledWith({ block: "center" });
    act(() => root.unmount());
  });

  it("re-fires the scroll on a nonce bump, and not on item churn without one", () => {
    const { root } = renderFind(four(), {
      ids: ["a1", "a2", "a3"],
      activeId: "a2",
      nonce: 5,
    });
    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);

    // Churn: a fresh items array with the same ids does not re-jump.
    act(() => {
      root.render(
        <TranscriptView items={four()} find={{ ids: ["a1", "a2", "a3"], activeId: "a2", nonce: 5 }} />,
      );
    });
    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(1);

    // A nonce bump does.
    act(() => {
      root.render(
        <TranscriptView items={four()} find={{ ids: ["a1", "a2", "a3"], activeId: "a2", nonce: 6 }} />,
      );
    });
    expect(scrollIntoViewSpy).toHaveBeenCalledTimes(2);
    act(() => root.unmount());
  });

  it("renders plain rows with no find prop: no wash, no scroll, no follow change", () => {
    const { el, root } = renderFind(four());
    expect(el.querySelector(".find-hit")).toBeNull();
    expect(el.textContent).not.toContain("jump to latest");
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
