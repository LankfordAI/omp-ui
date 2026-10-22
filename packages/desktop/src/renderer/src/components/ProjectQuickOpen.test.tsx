// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ProjectGroup } from "@omp-ui/core/types";
import { backendState, remoteInstance, tabInfo } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();
Object.assign(window, { ompBackend: {} });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { ProjectQuickOpen } = await import("./ProjectQuickOpen");

const originalMatchMedia = window.matchMedia;
let root: Root | null = null;

/** A registry group for the given path/name/key triple; sessions never matter here. */
function projectGroup(path: string, name: string, repositoryKey: string | null): ProjectGroup {
  return {
    project: {
      path,
      name,
      addedAt: "t",
      lastModel: null,
      lastThinkingLevel: null,
      lastAdvisor: null,
      lastAdvisorModel: null,
      defaultModel: null,
      defaultAdvisorModel: null,
      browserClock: false,
      reviewRoster: null,
      knowledgeHome: null,
      repositoryKey,
    },
    sessions: [],
  };
}

/**
 * Fixture registry: local /a (keyless), local /b and remote /remote/r sharing
 * one repository key (the issue #903 merge → ONE row), focused tab on /b.
 */
function renderQuickOpen(): { newSession: Mock; newChat: Mock; openProjectPicker: Mock } {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  const newSession = vi.fn(async () => "t");
  const newChat = vi.fn(async () => "c");
  const openProjectPicker = vi.fn();
  useStore.setState({
    projectPickerOpen: false,
    newSessionDialog: null,
    newSession,
    newChat,
    openProjectPicker,
    state: backendState({
      projects: [projectGroup("/a", "alpha", null), projectGroup("/b", "bravo", "github.com/o/r")],
      remoteInstances: [
        remoteInstance({
          id: "inst-1",
          projects: [projectGroup("/remote/r", "rho", "github.com/o/r")],
        }),
      ],
    }),
    tabs: [tabInfo({ tabId: "t1", projectCwd: "/b", instanceId: null })],
    activeTabId: "t1",
    projectQuickOpen: { query: "" },
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<ProjectQuickOpen />));
  return { newSession, newChat, openProjectPicker };
}

function quickInput(): HTMLInputElement {
  const found = document.body.querySelector<HTMLInputElement>('[role="dialog"] input');
  expect(found).not.toBeNull();
  return found!;
}

function typeQuery(value: string): void {
  const field = quickInput();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressQuick(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    quickInput().dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

/** The row buttons only (the Modal's close IconButton lacks the row width class). */
function rowButtons(): HTMLButtonElement[] {
  return [
    ...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ].filter((b) => b.className.includes("w-full"));
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  if (originalMatchMedia === undefined) Reflect.deleteProperty(window, "matchMedia");
  else Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
});

describe("ProjectQuickOpen rows (issue #915)", () => {
  it("orders chat first, the focused project second, add last, with positional chips", () => {
    renderQuickOpen();
    const rows = rowButtons();
    expect(rows).toHaveLength(4);
    expect(rows[0]!.textContent).toContain("No project");
    expect(rows[1]!.textContent).toContain("bravo");
    expect(rows[3]!.textContent).toContain("Add project…");
    // Non-mac jsdom formats mod+N as Ctrl+N; the first nine rows carry their chord.
    expect(rows[0]!.textContent).toContain("Ctrl+1");
    expect(rows[1]!.textContent).toContain("Ctrl+2");
  });

  it("keeps a repository row when the query matches a remote checkout's path", () => {
    renderQuickOpen();
    typeQuery("rmt/r");
    // bravo and rho merged into one row (issue #903), so "/remote/r" surfaces
    // that single group row; chat and add fail the needle.
    const rows = rowButtons();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("bravo");
  });

  it("Enter on a grouped row spawns the local pair and closes before the spawn resolves", () => {
    const { newSession } = renderQuickOpen();
    pressQuick("ArrowDown");
    pressQuick("Enter");
    expect(newSession).toHaveBeenCalledWith("/b", undefined, null);
    // Closed synchronously inside the pick, never waiting on the spawn.
    expect(useStore.getState().projectQuickOpen).toBeNull();
  });

  it("Enter on the chat row runs newChat and closes", () => {
    const { newChat } = renderQuickOpen();
    pressQuick("Enter");
    expect(newChat).toHaveBeenCalledOnce();
    expect(useStore.getState().projectQuickOpen).toBeNull();
  });

  it("Shift+Enter on a project row swaps the overlay for the New session dialog seeded with the pair", () => {
    renderQuickOpen();
    pressQuick("ArrowDown");
    pressQuick("Enter", { shiftKey: true });
    expect(useStore.getState().projectQuickOpen).toBeNull();
    expect(useStore.getState().newSessionDialog).toMatchObject({ projectCwd: "/b", instanceId: null });
  });

  it("Backspace on an empty query closes, but Backspace with text edits in place", () => {
    renderQuickOpen();
    typeQuery("rmt");
    pressQuick("Backspace");
    expect(useStore.getState().projectQuickOpen).not.toBeNull();
    expect(quickInput().value).toBe("rmt");
    // Re-empty by other means, then Backspace walks back out.
    typeQuery("");
    pressQuick("Backspace");
    expect(useStore.getState().projectQuickOpen).toBeNull();
  });

  it("Escape closes", () => {
    renderQuickOpen();
    pressQuick("Escape");
    expect(useStore.getState().projectQuickOpen).toBeNull();
  });

  it("Enter on the add row opens the project picker and closes", () => {
    const { openProjectPicker } = renderQuickOpen();
    pressQuick("ArrowDown");
    pressQuick("ArrowDown");
    pressQuick("ArrowDown");
    pressQuick("Enter");
    expect(openProjectPicker).toHaveBeenCalledOnce();
    expect(useStore.getState().projectQuickOpen).toBeNull();
  });

  it("mod+2 picks the second row of the empty-query order", () => {
    const { newSession } = renderQuickOpen();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", ctrlKey: true, bubbles: true }));
    });
    expect(newSession).toHaveBeenCalledWith("/b", undefined, null);
    expect(useStore.getState().projectQuickOpen).toBeNull();
  });
});
