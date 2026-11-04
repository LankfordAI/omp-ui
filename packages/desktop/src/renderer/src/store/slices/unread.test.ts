// @vitest-environment jsdom
// The Needs-attention marks (issue #1037): newest-wins marking, the wholesale
// clears, prune, the localStorage mirror and its re-hydration, the out-of-view
// predicate, and the focus/visibility clear. Built from the real slice factory
// on a bare store so api.subscribe's activeTabId hook is exercised too.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { create, type StateCreator } from "zustand";
import type { UiStore } from "../types";
import type { UnreadSlice } from "./unread";
import {
  createUnreadSlice,
  firstAssistantText,
  installUnreadViewListeners,
  unreadRaisePredicate,
} from "./unread";

const KEY = "omp-ui.unreadSessions";

/** The slice state plus the one field its clear-on-view subscriber reads. */
type TestState = UnreadSlice & Pick<UiStore, "activeTabId">;

function makeStore() {
  // The real factory, mounted on a slice-sized store: it only ever reads
  // activeTabId beyond its own surface, so the shape cast is sound here.
  return create<TestState>()(
    createUnreadSlice as unknown as StateCreator<TestState, [], []>,
  );
}

/** Deterministic Date.now: each mark stamps `base + n` in call order. */
function clockFrom(base: number): void {
  let n = 0;
  vi.spyOn(Date, "now").mockImplementation(() => base + n++);
}

afterEach(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  localStorage.clear();
});

describe("markUnread / clearUnread", () => {
  it("overwrites newest-wins: the second mark re-stamps atMs and the snippet", () => {
    clockFrom(1_000);
    const s = makeStore();
    s.getState().markUnread("a", "first answer");
    expect(s.getState().unread.a).toEqual({ atMs: 1_000, snippet: "first answer" });
    s.getState().markUnread("a", "final answer");
    expect(s.getState().unread.a).toEqual({ atMs: 1_001, snippet: "final answer" });
    expect(Object.keys(s.getState().unread)).toEqual(["a"]);
  });

  it("mirrors every mark and clear to localStorage as tabId → atMs", () => {
    clockFrom(50);
    const s = makeStore();
    s.getState().markUnread("a", "one");
    s.getState().markUnread("b", null);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ a: 50, b: 51 });
    s.getState().clearUnread("a");
    expect(s.getState().unread.a).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ b: 51 });
  });

  it("hydrates at creation from the mirror, snippetless", () => {
    localStorage.setItem(KEY, JSON.stringify({ a: 7, bad: "x" }));
    const s = makeStore();
    expect(s.getState().unread).toEqual({ a: { atMs: 7, snippet: null } });
  });

  it("round-trips marks through the mirror into a freshly created slice", () => {
    clockFrom(5);
    const first = makeStore();
    first.getState().markUnread("a", "gone after restart");
    const revived = makeStore(); // hydration is creation-time: fresh store, fresh read
    expect(revived.getState().unread).toEqual({ a: { atMs: 5, snippet: null } });
  });

  it("survives garbage in the key", () => {
    localStorage.setItem(KEY, "{not json");
    expect(makeStore().getState().unread).toEqual({});
  });
});

describe("the 200-mark cap", () => {
  it("drops the oldest marks when marking past the cap", () => {
    clockFrom(1);
    const s = makeStore();
    for (let i = 0; i < 201; i++) s.getState().markUnread(`t${i}`, null);
    const unread = s.getState().unread;
    expect(Object.keys(unread)).toHaveLength(200);
    expect(unread.t0).toBeUndefined();
    expect(unread.t200).toBeDefined();
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(
      Object.fromEntries(Object.entries(unread).map(([tabId, m]) => [tabId, m.atMs])),
    );
  });

  it("drops the oldest marks when hydrating past the cap", () => {
    const mirror: Record<string, number> = {};
    for (let i = 0; i < 250; i++) mirror[`t${i}`] = i + 1;
    localStorage.setItem(KEY, JSON.stringify(mirror));
    const unread = makeStore().getState().unread;
    expect(Object.keys(unread)).toHaveLength(200);
    expect(unread.t49).toBeUndefined();
    expect(unread.t50).toEqual({ atMs: 51, snippet: null });
  });
});

describe("pruneUnread", () => {
  it("drops marks whose tab is no longer live and mirrors the change", () => {
    clockFrom(10);
    const s = makeStore();
    s.getState().markUnread("a", null);
    s.getState().markUnread("b", null);
    s.getState().pruneUnread(new Set(["a"]));
    expect(Object.keys(s.getState().unread)).toEqual(["a"]);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual({ a: 10 });
  });

  it("is a no-op when every mark survives", () => {
    const s = makeStore();
    s.getState().markUnread("a", null);
    const before = s.getState().unread;
    localStorage.removeItem(KEY);
    s.getState().pruneUnread(new Set(["a"]));
    expect(s.getState().unread).toBe(before);
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe("clear on activeTabId change", () => {
  it("the one subscriber clears the mark of a tab that becomes active", () => {
    const s = makeStore();
    s.getState().markUnread("a", "hi");
    s.getState().markUnread("b", "yo");
    s.setState({ activeTabId: "a" });
    expect(s.getState().unread.a).toBeUndefined();
    expect(s.getState().unread.b).toBeDefined();
  });
});

describe("unreadRaisePredicate (the #271 out-of-view gate)", () => {
  it("raises unless the tab is active inside a focused, visible window", () => {
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    expect(unreadRaisePredicate("a", null)).toBe(true);
    expect(unreadRaisePredicate("a", "b")).toBe(true);
    expect(unreadRaisePredicate("a", "a")).toBe(false);
    hidden.mockReturnValue(true);
    expect(unreadRaisePredicate("a", "a")).toBe(true);
    hidden.mockReturnValue(false);
    focus.mockReturnValue(false);
    expect(unreadRaisePredicate("a", "a")).toBe(true);
  });
});

describe("installUnreadViewListeners", () => {
  it("clears the viewed tab's mark on window focus and on visibility return", () => {
    const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    const s = makeStore();
    const dispose = installUnreadViewListeners(s.getState);
    // Active first: the activation itself clears, and later marks belong to
    // the tab under view, which only the window events may clear.
    s.setState({ activeTabId: "a" });
    s.getState().markUnread("a", "back");
    window.dispatchEvent(new Event("focus"));
    expect(s.getState().unread.a).toBeUndefined();
    s.getState().markUnread("a", "back again");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(s.getState().unread.a).toBeUndefined();
    dispose();
    s.getState().markUnread("a", "after dispose");
    window.dispatchEvent(new Event("focus"));
    expect(s.getState().unread.a).toBeDefined();
    focus.mockRestore();
  });

  it("leaves marks alone while the window is blurred", () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(false);
    const s = makeStore();
    const dispose = installUnreadViewListeners(s.getState);
    s.setState({ activeTabId: "a" });
    // The setState above clears via the activeTabId hook; re-mark as a blurred
    // window would receive it, then fire the focus event with hasFocus false.
    s.getState().markUnread("a", "quiet");
    window.dispatchEvent(new Event("focus"));
    expect(s.getState().unread.a).toBeDefined();
    dispose();
  });
});

describe("firstAssistantText", () => {
  it("takes the first non-empty text block, trimmed and capped at 140 chars", () => {
    expect(firstAssistantText([{ type: "thinking", text: "hmm" }, { type: "text", text: "  real answer  "}])).toBe("real answer");
    expect(firstAssistantText("plain string reply")).toBe("plain string reply");
    expect(firstAssistantText([{ type: "text", text: "x".repeat(200) }])!).toHaveLength(140);
    expect(firstAssistantText([{ type: "text", text: "   " }, { type: "text", text: "next" }])).toBe("next");
    expect(firstAssistantText([{ type: "tool_use", id: "t" }])).toBeNull();
    expect(firstAssistantText(undefined)).toBeNull();
  });
});
