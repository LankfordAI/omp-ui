// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_VIEW_STORAGE_KEY,
  type DesktopViewStateV1,
  loadDesktopView,
  parseDesktopView,
  projectDesktopView,
  saveDesktopView,
  shouldRestoreDesktopView,
  desktopViewStorage,
} from "./desktop-view-state";

/**
 * Version-gated desktop view restoration (issue #99 tier 3).
 *
 * The snapshot the app writes is the contract an INSTALLED APPIMAGE will read
 * back after relaunch, so the round-trip (project → save → load) is asserted
 * exactly, and every malformed shape the parser can meet degrades to
 * "nothing to restore" rather than an exception.
 */

function setRaw(raw: string): void {
  window.localStorage.setItem(DESKTOP_VIEW_STORAGE_KEY, raw);
}

describe("desktop view state", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it("round-trips the exact v1 schema, hidden tab omitted, order preserved", () => {
    const snapshot = projectDesktopView(
      {
        tabs: [
          { tabId: "a", hidden: false },
          { tabId: "b", hidden: true },
          { tabId: "c", hidden: false },
        ],
        activeTabId: "c",
        focusedTabByProject: { "/proj-1": "a" },
        sidebarWidth: 416,
        inspectorWidth: 256,
      },
      "1.0.0",
    );
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.tabIds).toEqual(["a", "c"]);

    expect(saveDesktopView(window.localStorage, snapshot)).toBe(true);
    expect(snapshot.sidebarWidth).toBe(416);
    expect(snapshot.inspectorWidth).toBe(256);
    expect(loadDesktopView(window.localStorage)).toEqual(snapshot);
  });

  it("projection keeps visible order, drops hidden tabs, collapses duplicates", () => {
    const projected = projectDesktopView(
      {
        tabs: [
          { tabId: "x", hidden: false },
          { tabId: "y", hidden: true },
          { tabId: "x", hidden: false },
          { tabId: "z", hidden: false },
        ],
        activeTabId: "z",
        focusedTabByProject: {},
        sidebarWidth: 272,
        inspectorWidth: 304,
      },
      "1.0.0",
    );
    expect(projected.tabIds).toEqual(["x", "z"]);
    expect(projected.tabIds).not.toContain("y");
  });

  it("copies appVersion, activeTabId, and the focus map as-is", () => {
    const projected = projectDesktopView(
      {
        tabs: [{ tabId: "t", hidden: false }],
        activeTabId: "t",
        focusedTabByProject: { "/a": "t", "/b": "t" },
        sidebarWidth: 272,
        inspectorWidth: 304,
      },
      "2.1.0",
    );
    expect(projected.appVersion).toBe("2.1.0");
    expect(projected.activeTabId).toBe("t");
    expect(projected.focusedTabByProject).toEqual({ "/a": "t", "/b": "t" });
  });

  it("version gate: equal non-null versions do NOT restore", () => {
    const saved: DesktopViewStateV1 = { schemaVersion: 1, appVersion: "1.0.0", tabIds: [], activeTabId: null, focusedTabByProject: {}, sidebarWidth: 272, inspectorWidth: 304 };
    expect(shouldRestoreDesktopView(saved, "1.0.0")).toBe(false);
  });

  it("version gate: differing non-null versions DO restore", () => {
    const saved: DesktopViewStateV1 = { schemaVersion: 1, appVersion: "1.0.0", tabIds: [], activeTabId: null, focusedTabByProject: {}, sidebarWidth: 272, inspectorWidth: 304 };
    expect(shouldRestoreDesktopView(saved, "1.1.0")).toBe(true);
  });

  it("version gate: a null saved appVersion never restores", () => {
    const saved: DesktopViewStateV1 = { schemaVersion: 1, appVersion: null, tabIds: [], activeTabId: null, focusedTabByProject: {}, sidebarWidth: 272, inspectorWidth: 304 };
    expect(shouldRestoreDesktopView(saved, "1.1.0")).toBe(false);
  });

  it("version gate: a null currentVersion never restores", () => {
    const saved: DesktopViewStateV1 = { schemaVersion: 1, appVersion: "1.0.0", tabIds: [], activeTabId: null, focusedTabByProject: {}, sidebarWidth: 272, inspectorWidth: 304 };
    expect(shouldRestoreDesktopView(saved, null)).toBe(false);
  });

  it("version gate: no saved snapshot never restores", () => {
    expect(shouldRestoreDesktopView(null, "1.1.0")).toBe(false);
  });

  it("returns null for a missing key", () => {
    expect(loadDesktopView(window.localStorage)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    setRaw("{not json");
    expect(parseDesktopView(window.localStorage.getItem(DESKTOP_VIEW_STORAGE_KEY))).toBeNull();
  });

  it("rejects a non-v1 schemaVersion", () => {
    setRaw(JSON.stringify({ schemaVersion: 2, appVersion: "1.0.0", tabIds: [], activeTabId: null, focusedTabByProject: {} }));
    expect(parseDesktopView(window.localStorage.getItem(DESKTOP_VIEW_STORAGE_KEY))).toBeNull();
  });

  it("rejects a tabIds array containing a non-string", () => {
    const raw = JSON.stringify({ schemaVersion: 1, appVersion: "1.0.0", tabIds: ["a", 3], activeTabId: null, focusedTabByProject: {} });
    expect(parseDesktopView(raw)).toBeNull();
  });

  it("rejects a numeric activeTabId", () => {
    const raw = JSON.stringify({ schemaVersion: 1, appVersion: "1.0.0", tabIds: [], activeTabId: 3, focusedTabByProject: {} });
    expect(parseDesktopView(raw)).toBeNull();
  });

  it("rejects a top-level array, not a plain object", () => {
    expect(parseDesktopView("[]")).toBeNull();
  });

  it("drops map entries with non-string values while valid entries survive", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      appVersion: "1.0.0",
      tabIds: ["a"],
      activeTabId: "a",
      focusedTabByProject: { "/good": "a", "/bad": 7, "/nested": { x: 1 } },
    });
    const parsed = parseDesktopView(raw);
    expect(parsed).not.toBeNull();
    expect(parsed!.focusedTabByProject).toEqual({ "/good": "a" });
  });


  it("defaults missing or non-finite v1 widths and clamps finite widths", () => {
    const base = {
      schemaVersion: 1,
      appVersion: "1.0.0",
      tabIds: [],
      activeTabId: null,
      focusedTabByProject: {},
    };
    expect(parseDesktopView(JSON.stringify(base))).toMatchObject({
      sidebarWidth: 272,
      inspectorWidth: 304,
    });
    expect(parseDesktopView(JSON.stringify({
      ...base,
      sidebarWidth: 999,
      inspectorWidth: 1,
    }))).toMatchObject({ sidebarWidth: 512, inspectorWidth: 224 });
    expect(parseDesktopView(JSON.stringify({
      ...base,
      sidebarWidth: "bad",
      inspectorWidth: null,
    }))).toMatchObject({ sidebarWidth: 272, inspectorWidth: 304 });
  });
  it("deduplicates tabIds preserving first occurrence order", () => {
    const raw = JSON.stringify({ schemaVersion: 1, appVersion: null, tabIds: ["a", "b", "a", "c", "b"], activeTabId: null, focusedTabByProject: {} });
    expect(parseDesktopView(raw)).toEqual({
      schemaVersion: 1,
      appVersion: null,
      tabIds: ["a", "b", "c"],
      activeTabId: null,
      focusedTabByProject: {},
      sidebarWidth: 272,
      inspectorWidth: 304,
    });
  });

  it("returns null without throwing when getItem throws", () => {
    const spy = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    try {
      expect(loadDesktopView(window.localStorage)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("returns false without throwing when setItem throws", () => {
    const snapshot = projectDesktopView({ tabs: [], activeTabId: null, focusedTabByProject: {}, sidebarWidth: 272, inspectorWidth: 304 }, "1.0.0");
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    try {
      expect(saveDesktopView(window.localStorage, snapshot)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("desktopViewStorage returns non-null in jsdom and round-trips through it", () => {
    const storage = desktopViewStorage();
    expect(storage).not.toBeNull();
    const snapshot = projectDesktopView(
      { tabs: [{ tabId: "t", hidden: false }], activeTabId: "t", focusedTabByProject: {}, sidebarWidth: 272, inspectorWidth: 304 },
      "1.0.0",
    );
    expect(saveDesktopView(storage!, snapshot)).toBe(true);
    expect(loadDesktopView(storage!)).toEqual(snapshot);
  });

  it("desktopViewStorage returns null when localStorage is unavailable", () => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage denied");
      },
    });
    try {
      expect(desktopViewStorage()).toBeNull();
    } finally {
      delete (window as unknown as Record<string, unknown>).localStorage;
    }
  });
});