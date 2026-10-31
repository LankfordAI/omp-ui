// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_VIEW_STORAGE_KEY,
  type DesktopViewStateV1,
  loadDesktopView,
  parseDesktopView,
  projectDesktopView,
  saveDesktopView,
  sessionViewStorage,
  shouldRestoreBrowserView,
  shouldRestoreDesktopView,
  desktopViewStorage,
} from "./desktop-view-state";
import { BROWSER_PANE_DEFAULT_WIDTH, DEVICE_PANE_DEFAULT_WIDTH, SIDEBAR_DEFAULT_WIDTH } from "./panel-layout";

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
        exited: {},
        activeTabId: "c",
        sidebarWidth: 416,
        inspectorWidth: 256,
        browserPaneWidth: 720,
        devicePaneWidth: 640,
        diffViewLayout: "split",
      },
      "1.0.0",
    );
    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.tabIds).toEqual(["a", "c"]);

    expect(saveDesktopView(window.localStorage, snapshot)).toBe(true);
    expect(snapshot.sidebarWidth).toBe(416);
    expect(snapshot.inspectorWidth).toBe(256);
    expect(snapshot.diffViewLayout).toBe("split");
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
        exited: {},
        activeTabId: "z",
        sidebarWidth: 272,
        inspectorWidth: 304,
        browserPaneWidth: 560,
        devicePaneWidth: DEVICE_PANE_DEFAULT_WIDTH,
        diffViewLayout: "unified",
      },
      "1.0.0",
    );
    expect(projected.tabIds).toEqual(["x", "z"]);
    expect(projected.tabIds).not.toContain("y");
  });

  it("copies appVersion and activeTabId as-is", () => {
    const projected = projectDesktopView(
      {
        tabs: [{ tabId: "t", hidden: false }],
        exited: {},
        activeTabId: "t",
        sidebarWidth: 272,
        inspectorWidth: 304,
        browserPaneWidth: 560,
        devicePaneWidth: DEVICE_PANE_DEFAULT_WIDTH,
        diffViewLayout: "unified",
      },
      "2.1.0",
    );
    expect(projected.appVersion).toBe("2.1.0");
    expect(projected.activeTabId).toBe("t");
  });

  it("version gate: equal non-null versions do NOT restore", () => {
    const saved: DesktopViewStateV1 = { schemaVersion: 1, appVersion: "1.0.0", tabIds: [], activeTabId: null, sidebarWidth: 272, inspectorWidth: 304, browserPaneWidth: 560, devicePaneWidth: 420, diffViewLayout: "unified" };
    expect(shouldRestoreDesktopView(saved, "1.0.0")).toBe(false);
  });

  it("version gate: differing non-null versions DO restore", () => {
    const saved: DesktopViewStateV1 = { schemaVersion: 1, appVersion: "1.0.0", tabIds: [], activeTabId: null, sidebarWidth: 272, inspectorWidth: 304, browserPaneWidth: 560, devicePaneWidth: 420, diffViewLayout: "unified" };
    expect(shouldRestoreDesktopView(saved, "1.1.0")).toBe(true);
  });

  it("version gate: a null saved appVersion never restores", () => {
    const saved: DesktopViewStateV1 = { schemaVersion: 1, appVersion: null, tabIds: [], activeTabId: null, sidebarWidth: 272, inspectorWidth: 304, browserPaneWidth: 560, devicePaneWidth: 420, diffViewLayout: "unified" };
    expect(shouldRestoreDesktopView(saved, "1.1.0")).toBe(false);
  });

  it("version gate: a null currentVersion never restores", () => {
    const saved: DesktopViewStateV1 = { schemaVersion: 1, appVersion: "1.0.0", tabIds: [], activeTabId: null, sidebarWidth: 272, inspectorWidth: 304, browserPaneWidth: 560, devicePaneWidth: 420, diffViewLayout: "unified" };
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
    setRaw(JSON.stringify({ schemaVersion: 2, appVersion: "1.0.0", tabIds: [], activeTabId: null }));
    expect(parseDesktopView(window.localStorage.getItem(DESKTOP_VIEW_STORAGE_KEY))).toBeNull();
  });

  it("rejects a tabIds array containing a non-string", () => {
    const raw = JSON.stringify({ schemaVersion: 1, appVersion: "1.0.0", tabIds: ["a", 3], activeTabId: null });
    expect(parseDesktopView(raw)).toBeNull();
  });

  it("rejects a numeric activeTabId", () => {
    const raw = JSON.stringify({ schemaVersion: 1, appVersion: "1.0.0", tabIds: [], activeTabId: 3 });
    expect(parseDesktopView(raw)).toBeNull();
  });

  it("rejects a top-level array, not a plain object", () => {
    expect(parseDesktopView("[]")).toBeNull();
  });

  it("parses a v1 snapshot that still carries the old focusedTabByProject map, restoring tabs and widths", () => {
    // The exact shape builds before the session sidebar persisted: the map is
    // ignored, never required, so schemaVersion stays 1 and nothing is lost.
    const legacy = JSON.stringify({
      schemaVersion: 1,
      appVersion: "1.0.0",
      tabIds: ["a", "b"],
      activeTabId: "b",
      focusedTabByProject: { "/good": "a", "/bad": 7, "/nested": { x: 1 } },
      sidebarWidth: 300,
      inspectorWidth: 250,
      browserPaneWidth: 720,
    });
    expect(parseDesktopView(legacy)).toEqual({
      schemaVersion: 1,
      appVersion: "1.0.0",
      tabIds: ["a", "b"],
      activeTabId: "b",
      sidebarWidth: 300,
      inspectorWidth: 250,
      browserPaneWidth: 720,
      devicePaneWidth: DEVICE_PANE_DEFAULT_WIDTH,
      diffViewLayout: "unified",
    });
  });

  it("defaults missing or non-finite v1 widths and clamps finite widths", () => {
    const base = {
      schemaVersion: 1,
      appVersion: "1.0.0",
      tabIds: [],
      activeTabId: null,
    };
    expect(parseDesktopView(JSON.stringify(base))).toMatchObject({
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      inspectorWidth: 304,
    });
    expect(parseDesktopView(JSON.stringify({
      ...base,
      sidebarWidth: 999,
      inspectorWidth: 1,
      browserPaneWidth: 9999,
      devicePaneWidth: 9999,
    }))).toMatchObject({ sidebarWidth: 512, inspectorWidth: 224, browserPaneWidth: 1600, devicePaneWidth: 900 });
    expect(parseDesktopView(JSON.stringify({
      ...base,
      sidebarWidth: "bad",
      inspectorWidth: null,
      browserPaneWidth: "wide",
      devicePaneWidth: Number.NaN,
    }))).toMatchObject({
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      inspectorWidth: 304,
      browserPaneWidth: 560,
      devicePaneWidth: DEVICE_PANE_DEFAULT_WIDTH,
    });
  });

  it("parses a v1 snapshot written before the browser pane existed with the pane default (#528)", () => {
    // The exact shape a pre-pane build persisted: schemaVersion stays 1, so
    // an upgrade restores tabs and widths instead of discarding the snapshot.
    const prePane = JSON.stringify({
      schemaVersion: 1,
      appVersion: "1.0.0",
      tabIds: ["a"],
      activeTabId: "a",
      sidebarWidth: 300,
      inspectorWidth: 250,
    });
    expect(parseDesktopView(prePane)).toEqual({
      schemaVersion: 1,
      appVersion: "1.0.0",
      tabIds: ["a"],
      activeTabId: "a",
      sidebarWidth: 300,
      inspectorWidth: 250,
      browserPaneWidth: BROWSER_PANE_DEFAULT_WIDTH,
      devicePaneWidth: DEVICE_PANE_DEFAULT_WIDTH,
      diffViewLayout: "unified",
    });
  });

  it("parses a v1 snapshot written before the device pane existed with the pane default (#1006)", () => {
    const preDevice = JSON.stringify({
      schemaVersion: 1,
      appVersion: "1.0.0",
      tabIds: ["a"],
      activeTabId: "a",
      sidebarWidth: 300,
      inspectorWidth: 250,
      browserPaneWidth: 720,
      diffViewLayout: "split",
    });
    expect(parseDesktopView(preDevice)).toMatchObject({
      browserPaneWidth: 720,
      devicePaneWidth: DEVICE_PANE_DEFAULT_WIDTH,
      diffViewLayout: "split",
    });
  });

  it("round-trips the split diff layout through the snapshot (#933)", () => {
    const projected = projectDesktopView(
      { tabs: [], exited: {}, activeTabId: null, sidebarWidth: 272, inspectorWidth: 304, browserPaneWidth: 560, devicePaneWidth: 420, diffViewLayout: "split" },
      "1.0.0",
    );
    expect(projected.diffViewLayout).toBe("split");
    expect(saveDesktopView(window.localStorage, projected)).toBe(true);
    expect(loadDesktopView(window.localStorage)?.diffViewLayout).toBe("split");
  });

  it("parses a v1 snapshot written before the split diff view existed as unified (#933)", () => {
    // Absent from pre-#933 blobs: schemaVersion stays 1, nothing is lost.
    const preSplit = JSON.stringify({
      schemaVersion: 1,
      appVersion: "1.0.0",
      tabIds: ["a"],
      activeTabId: "a",
      sidebarWidth: 300,
      inspectorWidth: 250,
      browserPaneWidth: 560,
    });
    expect(parseDesktopView(preSplit)?.diffViewLayout).toBe("unified");
  });

  it("defaults a garbage diffViewLayout to unified without rejecting the snapshot (#933)", () => {
    const raw = JSON.stringify({
      schemaVersion: 1,
      appVersion: "1.0.0",
      tabIds: ["a"],
      activeTabId: null,
      diffViewLayout: "sideways",
    });
    expect(parseDesktopView(raw)).toMatchObject({ tabIds: ["a"], diffViewLayout: "unified" });
  });

  it("deduplicates tabIds preserving first occurrence order", () => {
    const raw = JSON.stringify({ schemaVersion: 1, appVersion: null, tabIds: ["a", "b", "a", "c", "b"], activeTabId: null });
    expect(parseDesktopView(raw)).toEqual({
      schemaVersion: 1,
      appVersion: null,
      tabIds: ["a", "b", "c"],
      activeTabId: null,
      sidebarWidth: SIDEBAR_DEFAULT_WIDTH,
      inspectorWidth: 304,
      browserPaneWidth: 560,
      devicePaneWidth: DEVICE_PANE_DEFAULT_WIDTH,
      diffViewLayout: "unified",
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
    const snapshot = projectDesktopView({ tabs: [], exited: {}, activeTabId: null, sidebarWidth: 272, inspectorWidth: 304, browserPaneWidth: 560, devicePaneWidth: 420, diffViewLayout: "unified" }, "1.0.0");
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
      { tabs: [{ tabId: "t", hidden: false }], exited: {}, activeTabId: "t", sidebarWidth: 272, inspectorWidth: 304, browserPaneWidth: 560, devicePaneWidth: 420, diffViewLayout: "unified" },
      "1.0.0",
    );
    expect(saveDesktopView(storage!, snapshot)).toBe(true);
    expect(loadDesktopView(storage!)).toEqual(snapshot);
  });

  it("desktopViewStorage returns null when localStorage is unavailable", () => {
    // jsdom's built-in does not survive a bare `delete` for later tests, so
    // stash the real object and restore it as a value afterwards.
    const original = window.localStorage;
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("storage denied");
      },
    });
    try {
      expect(desktopViewStorage()).toBeNull();
    } finally {
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });
});

describe("browser view state (issue #890)", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  const snapshot = (): DesktopViewStateV1 =>
    projectDesktopView(
      { tabs: [{ tabId: "t", hidden: false }], exited: {}, activeTabId: "t", sidebarWidth: 272, inspectorWidth: 304, browserPaneWidth: 560, devicePaneWidth: 420, diffViewLayout: "unified" },
      "1.0.0",
    );

  it("sessionViewStorage returns non-null in jsdom and round-trips through it", () => {
    const storage = sessionViewStorage();
    expect(storage).not.toBeNull();
    expect(saveDesktopView(storage!, snapshot())).toBe(true);
    expect(loadDesktopView(storage!)).toEqual(snapshot());
    // The per-tab store is separate from the cross-tab one.
    expect(window.localStorage.getItem(DESKTOP_VIEW_STORAGE_KEY)).toBeNull();
  });

  it("sessionViewStorage returns null when sessionStorage is unavailable", () => {
    // jsdom's built-in does not survive a bare `delete` for later tests, so
    // stash the real object and restore it as a value afterwards.
    const original = window.sessionStorage;
    Object.defineProperty(window, "sessionStorage", {
      configurable: true,
      get() {
        throw new Error("storage denied");
      },
    });
    try {
      expect(sessionViewStorage()).toBeNull();
    } finally {
      Object.defineProperty(window, "sessionStorage", {
        configurable: true,
        writable: true,
        value: original,
      });
    }
  });

  it("shouldRestoreBrowserView ignores the version gate entirely", () => {
    expect(shouldRestoreBrowserView(null)).toBe(false);
    expect(shouldRestoreBrowserView({ ...snapshot(), tabIds: [] })).toBe(false);
    // A snapshot whose appVersion MATCHES the running build still restores —
    // the desktop gate's same-version refusal is exactly what a browser reload
    // must not inherit.
    expect(shouldRestoreBrowserView({ ...snapshot(), appVersion: "9.9.9", tabIds: ["t"] })).toBe(true);
    expect(shouldRestoreBrowserView({ ...snapshot(), appVersion: null, tabIds: ["t"] })).toBe(true);
  });
});