// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ProjectGroup, ProjectIcon, ProjectOpenAvailability, SessionSummary } from "@omp-ui/core/types";
import type { TabInfo } from "../store";
import { backendState, remoteInstance, tabInfo } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();
const backendMock = {
  getProjectOpenAvailability: vi.fn<() => Promise<ProjectOpenAvailability>>(),
  openProject: vi.fn<(path: string, target: "vscode" | "files" | "terminal") => Promise<void>>(),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { ProjectQuickOpen } = await import("./ProjectQuickOpen");

const originalMatchMedia = window.matchMedia;
let root: Root | null = null;

/** A registry group for the given path/name/key triple; sessions never matter here. */
function projectGroup(path: string, name: string, repositoryKey: string | null, icon: ProjectIcon | null = null): ProjectGroup {
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
      icon,
    },
    sessions: [],
  };
}

/** Minimal record so isChatTab classifies the focused tab as a chat. */
function chatRecord(tabId: string): SessionSummary {
  return {
    tabId,
    sessionId: null,
    lineageDir: `omp-ui--p--${tabId}`,
    projectCwd: "/p",
    worktree: null,
    planImplementationSource: null,
    experiment: null,
    fleet: null,
    launchedAt: "t",
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
    snoozed: false,
    snoozedUntilMs: null,
    pinnedAtMs: null,
    heldPrompt: null,
    pullRequests: [],
    autoSettleOnMerge: null,
    private: false,
    chat: true,
    askSource: null,
    cachedTitle: null,
    cachedModified: null,
    agentMode: "build",
    title: "Brainstorm",
    status: null,
    live: "live",
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
  };
}

interface RenderOptions {
  /** Defaults to one project tab on /b. */
  tabs?: TabInfo[];
  chats?: SessionSummary[];
  compact?: boolean;
  experiments?: boolean;
  /** Extra projects registered on inst-1, after /remote/r. */
  remoteProjects?: ProjectGroup[];
  /** Icon on the remote /remote/r checkout (merged into bravo's row). */
  remoteIcon?: ProjectIcon;
}

interface Rendered {
  newSession: Mock;
  newChat: Mock;
  openProjectPicker: Mock;
  openNewSessionDialog: Mock;
  openLab: Mock;
  openExperimentDialog: Mock;
  openProjectSettings: Mock;
  removeProject: Mock;
  /** projectQuickOpen as each store mock saw it when called: proves close-first. */
  seenOpen: unknown[];
}

/**
 * Fixture registry: local /a (keyless), local /b and remote /remote/r sharing
 * one repository key (the issue #903 merge → ONE row), focused tab on /b. A
 * second, unreachable instance gets no register row.
 */
function renderQuickOpen(options: RenderOptions = {}): Rendered {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: options.compact === true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  const seenOpen: unknown[] = [];
  const recorder = <R,>(result: R): Mock =>
    vi.fn(() => {
      seenOpen.push(useStore.getState().projectQuickOpen);
      return result;
    });
  const mocks = {
    newSession: recorder(Promise.resolve("t")),
    newChat: recorder(Promise.resolve("c")),
    openProjectPicker: recorder(undefined),
    openNewSessionDialog: recorder(undefined),
    openLab: recorder(undefined),
    openExperimentDialog: recorder(undefined),
    openProjectSettings: recorder(undefined),
    removeProject: recorder(Promise.resolve()),
  };
  const tabs = options.tabs ?? [tabInfo({ tabId: "t1", projectCwd: "/b", instanceId: null })];
  useStore.setState({
    projectPickerOpen: false,
    newSessionDialog: null,
    ...mocks,
    state: backendState({
      experimentsEnabled: options.experiments === true,
      projects: [projectGroup("/a", "alpha", null), projectGroup("/b", "bravo", "github.com/o/r")],
      chats: options.chats ?? [],
      remoteInstances: [
        remoteInstance({
          id: "inst-1",
          nickname: "box-a",
          projects: [projectGroup("/remote/r", "rho", "github.com/o/r", options.remoteIcon ?? null), ...(options.remoteProjects ?? [])],
        }),
        remoteInstance({ id: "inst-2", nickname: "box-b", status: "unreachable" }),
      ],
    }),
    tabs,
    activeTabId: tabs[0]?.tabId ?? null,
    projectQuickOpen: { query: "" },
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<ProjectQuickOpen />));
  return { ...mocks, seenOpen };
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

/** The row buttons only: every labelled IconButton (close, back, ⋯) is excluded. */
function rowButtons(): HTMLButtonElement[] {
  return [
    ...document.body.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ].filter((b) => !b.hasAttribute("aria-label"));
}

/** A row's label text alone (its second span), without subline or chord chip. */
function rowLabels(): string[] {
  return rowButtons().map((b) => b.children[1]?.textContent ?? "");
}

function rowByLabel(label: string): HTMLButtonElement | undefined {
  return rowButtons().find((b) => b.children[1]?.textContent === label);
}

function labelled(label: string): HTMLButtonElement | null {
  return document.body.querySelector<HTMLButtonElement>(`[role="dialog"] button[aria-label="${label}"]`);
}

/** Drills into the active row's page with the caret at the end of the box. */
function drillIn(): void {
  const field = quickInput();
  field.setSelectionRange(field.value.length, field.value.length);
  pressQuick("ArrowRight");
}

/** Lets the availability probe's promise settle into state. */
async function flush(): Promise<void> {
  await act(async () => {});
}

beforeEach(() => {
  backendMock.getProjectOpenAvailability.mockReset();
  backendMock.getProjectOpenAvailability.mockReturnValue(new Promise(() => {}));
  backendMock.openProject.mockReset();
  backendMock.openProject.mockResolvedValue(undefined);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  if (originalMatchMedia === undefined) Reflect.deleteProperty(window, "matchMedia");
  else Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
});

describe("ProjectQuickOpen root rows (issues #915, #919)", () => {
  it("leads with the focused project, then No project, then registry order, add rows last", () => {
    renderQuickOpen();
    // Add rows close the list: local first, then one per joined instance
    // (the unreachable box-b gets none).
    expect(rowLabels()).toEqual(["bravo", "No project", "alpha", "Add project…", "Register project on box-a"]);
    // Non-mac jsdom formats mod+N as Ctrl+N; the first nine rows carry their chord.
    const rows = rowButtons();
    expect(rows[0]!.textContent).toContain("Ctrl+1");
    expect(rows[1]!.textContent).toContain("Ctrl+2");
  });

  it("puts No project first when a chat is focused", () => {
    renderQuickOpen({
      tabs: [tabInfo({ tabId: "c1", projectCwd: "/p", instanceId: null })],
      chats: [chatRecord("c1")],
    });
    expect(rowLabels()).toEqual(["No project", "alpha", "bravo", "Add project…", "Register project on box-a"]);
  });

  it("puts No project first when no tab is focused", () => {
    renderQuickOpen({ tabs: [] });
    expect(rowLabels()[0]).toBe("No project");
    expect(rowLabels()[1]).toBe("alpha");
  });

  it("keeps a repository row when the query matches a remote checkout's path", () => {
    renderQuickOpen();
    typeQuery("rmt/r");
    // bravo and rho merged into one row (issue #903), so "/remote/r" surfaces
    // that single group row; chat and add fail the needle.
    expect(rowLabels()).toEqual(["bravo"]);
  });

  it("a merged row's subline lists its machines, local first; a one-member remote row keeps nickname · path", () => {
    renderQuickOpen({ remoteProjects: [projectGroup("/remote/s", "sigma", null)] });
    // children[2] is the subline span (icon, label, subline, chord).
    expect(rowByLabel("bravo")!.children[2]!.textContent).toBe("This computer · box-a");
    expect(rowByLabel("bravo")!.title).toBe("/b\n/remote/r");
    expect(rowByLabel("sigma")!.children[2]!.textContent).toBe("box-a · /remote/s");
  });

  it("a bare Enter repeats the focused project and closes before the spawn resolves", () => {
    const { newSession, seenOpen } = renderQuickOpen();
    pressQuick("Enter");
    expect(newSession).toHaveBeenCalledWith("/b", undefined, null);
    // Closed synchronously inside the pick, never waiting on the spawn.
    expect(seenOpen).toEqual([null]);
    expect(useStore.getState().projectQuickOpen).toBeNull();
  });

  it("Enter on the No project row runs newChat and closes", () => {
    const { newChat } = renderQuickOpen();
    pressQuick("ArrowDown");
    pressQuick("Enter");
    expect(newChat).toHaveBeenCalledOnce();
    expect(useStore.getState().projectQuickOpen).toBeNull();
  });

  it("Shift+Enter on a project row swaps the overlay for the New session dialog seeded with the pair", () => {
    const { openNewSessionDialog } = renderQuickOpen();
    pressQuick("Enter", { shiftKey: true });
    expect(useStore.getState().projectQuickOpen).toBeNull();
    expect(openNewSessionDialog).toHaveBeenCalledWith({ projectCwd: "/b", instanceId: null });
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

  it("the local add row opens the project picker on this app and closes", () => {
    const { openProjectPicker } = renderQuickOpen();
    act(() => rowByLabel("Add project…")!.click());
    expect(openProjectPicker).toHaveBeenCalledWith(null);
    expect(useStore.getState().projectQuickOpen).toBeNull();
  });

  it("an instance's add row opens the project picker on that instance", () => {
    const { openProjectPicker } = renderQuickOpen();
    act(() => rowByLabel("Register project on box-a")!.click());
    expect(openProjectPicker).toHaveBeenCalledWith("inst-1");
    expect(useStore.getState().projectQuickOpen).toBeNull();
  });

  it("mod+N picks the Nth row of the empty-query order", () => {
    const { newChat } = renderQuickOpen();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "2", ctrlKey: true, bubbles: true }));
    });
    expect(newChat).toHaveBeenCalledOnce();
    expect(useStore.getState().projectQuickOpen).toBeNull();
  });
});

describe("ProjectQuickOpen pages (issue #919)", () => {
  it("ArrowRight with the caret at the end opens the active project's page", () => {
    renderQuickOpen();
    typeQuery("bra");
    drillIn();
    expect(quickInput().value).toBe("");
    expect(quickInput().placeholder).toBe("Search actions…");
    expect(document.body.querySelector('[role="dialog"]')!.textContent).toContain("bravo");
    expect(labelled("back to projects")).not.toBeNull();
    expect(rowLabels()[0]).toBe("New session");
  });

  it("ArrowRight mid-text only moves the caret", () => {
    renderQuickOpen();
    typeQuery("bra");
    quickInput().setSelectionRange(1, 1);
    pressQuick("ArrowRight");
    expect(quickInput().value).toBe("bra");
    expect(quickInput().placeholder).toBe("Search projects…");
    expect(rowLabels()).toContain("bravo");
  });

  it("the row's actions button opens the project page", () => {
    renderQuickOpen();
    act(() => labelled("actions for alpha")!.click());
    expect(quickInput().placeholder).toBe("Search actions…");
    expect(rowLabels()).toContain("Remove project…");
    // Pages offer no further drill-in.
    expect(labelled("actions for alpha")).toBeNull();
  });

  it("Backspace on an empty page search returns to root with the root query restored", () => {
    renderQuickOpen();
    typeQuery("bra");
    drillIn();
    typeQuery("set");
    pressQuick("Backspace");
    expect(quickInput().placeholder).toBe("Search actions…");
    typeQuery("");
    pressQuick("Backspace");
    expect(useStore.getState().projectQuickOpen).not.toBeNull();
    expect(quickInput().placeholder).toBe("Search projects…");
    expect(quickInput().value).toBe("bra");
    expect(rowLabels()).toEqual(["bravo"]);
  });

  it("the back button returns to root", () => {
    renderQuickOpen();
    drillIn();
    act(() => labelled("back to projects")!.click());
    expect(quickInput().placeholder).toBe("Search projects…");
    expect(rowLabels()[0]).toBe("bravo");
  });

  it("Escape closes from a page", () => {
    renderQuickOpen();
    drillIn();
    pressQuick("Escape");
    expect(useStore.getState().projectQuickOpen).toBeNull();
  });

  it("filters actions by label", () => {
    renderQuickOpen();
    drillIn();
    typeQuery("settings");
    expect(rowLabels()).toEqual(["Project settings…"]);
  });

  it("mod+N is inert on a page", () => {
    const { newSession, newChat } = renderQuickOpen();
    drillIn();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "1", ctrlKey: true, bubbles: true }));
    });
    expect(newSession).not.toHaveBeenCalled();
    expect(newChat).not.toHaveBeenCalled();
    expect(useStore.getState().projectQuickOpen).not.toBeNull();
  });

  it.each<[label: string, fn: keyof Omit<Rendered, "seenOpen">, args: unknown[]]>([
    ["New session", "newSession", ["/b", undefined, null]],
    ["New terminal session", "newSession", ["/b", "pty", null]],
    ["New private session", "newSession", ["/b", undefined, null, { private: true }]],
    ["New session…", "openNewSessionDialog", [{ projectCwd: "/b", instanceId: null }]],
    ["Experiments", "openLab", ["/b", null]],
    ["New experiment…", "openExperimentDialog", ["/b", null]],
    ["Project settings…", "openProjectSettings", ["/b", null]],
    ["Remove project…", "removeProject", ["/b", null]],
  ])("%s calls %s with the target pair after closing", (label, fn, args) => {
    const rendered = renderQuickOpen({ experiments: true });
    drillIn();
    act(() => rowByLabel(label)!.click());
    expect(rendered[fn]).toHaveBeenCalledExactlyOnceWith(...args);
    expect(rendered.seenOpen).toEqual([null]);
    expect(useStore.getState().projectQuickOpen).toBeNull();
  });

  it("Remove project renders as destructive", () => {
    renderQuickOpen();
    drillIn();
    expect(rowByLabel("Remove project…")!.children[1]!.className).toContain("text-rose");
  });

  it("Lab rows appear only with experiments enabled", () => {
    renderQuickOpen();
    drillIn();
    expect(rowByLabel("Experiments")).toBeUndefined();
    expect(rowByLabel("New experiment…")).toBeUndefined();
  });

  it("Open in Files opens the local checkout and closes", () => {
    renderQuickOpen();
    drillIn();
    act(() => rowByLabel("Open in Files")!.click());
    expect(backendMock.openProject).toHaveBeenCalledWith("/b", "files");
    expect(useStore.getState().projectQuickOpen).toBeNull();
  });

  it("VS Code and Terminal follow the availability probe", async () => {
    backendMock.getProjectOpenAvailability.mockResolvedValue({ vsCode: true, terminal: false });
    renderQuickOpen();
    drillIn();
    await flush();
    expect(backendMock.getProjectOpenAvailability).toHaveBeenCalledOnce();
    expect(rowByLabel("Open in VS Code")).toBeDefined();
    expect(rowByLabel("Open in Files")).toBeDefined();
    expect(rowByLabel("Open in Terminal")).toBeUndefined();
    act(() => rowByLabel("Open in VS Code")!.click());
    expect(backendMock.openProject).toHaveBeenCalledWith("/b", "vscode");
  });

  it("a rejected probe leaves only Files", async () => {
    backendMock.getProjectOpenAvailability.mockRejectedValue(new Error("no channel"));
    renderQuickOpen();
    drillIn();
    await flush();
    expect(rowLabels().filter((label) => label.startsWith("Open in"))).toEqual(["Open in Files"]);
  });

  it("omits open rows for a remote target and never probes", () => {
    renderQuickOpen({ remoteProjects: [projectGroup("/remote/s", "sigma", null)] });
    act(() => labelled("actions for sigma")!.click());
    expect(rowLabels()).toContain("New session");
    expect(rowLabels().some((label) => label.startsWith("Open in"))).toBe(false);
    expect(backendMock.getProjectOpenAvailability).not.toHaveBeenCalled();
  });

  it("omits open rows in the compact shell and never probes", () => {
    renderQuickOpen({ compact: true });
    drillIn();
    expect(rowLabels()).toContain("New session");
    expect(rowLabels().some((label) => label.startsWith("Open in"))).toBe(false);
    expect(backendMock.getProjectOpenAvailability).not.toHaveBeenCalled();
  });

  it("the No project page offers New chat and New private chat", () => {
    const { newChat, seenOpen } = renderQuickOpen();
    pressQuick("ArrowDown");
    drillIn();
    expect(rowLabels()).toEqual(["New chat", "New private chat"]);
    expect(document.body.querySelector('[role="dialog"]')!.textContent).toContain("No project");
    act(() => rowByLabel("New private chat")!.click());
    expect(newChat).toHaveBeenCalledExactlyOnceWith({ private: true });
    expect(seenOpen).toEqual([null]);
  });

  it("returns to root when the page's project disappears from the registry", () => {
    renderQuickOpen();
    typeQuery("alp");
    drillIn();
    expect(quickInput().placeholder).toBe("Search actions…");
    act(() => {
      useStore.setState({
        state: backendState({ projects: [projectGroup("/b", "bravo", "github.com/o/r")] }),
      });
    });
    expect(quickInput().placeholder).toBe("Search projects…");
    expect(quickInput().value).toBe("alp");
  });
});

describe("ProjectQuickOpen identity colours", () => {
  /** The drill-in header chip: the dialog's only max-w-[12rem] span. */
  function headerChip(): HTMLElement | null {
    return document.body.querySelector<HTMLElement>('[role="dialog"] span[class*="max-w-[12rem]"]');
  }

  /** A row's leading box: the project monogram span or the chat bar span. */
  function leadOf(label: string): HTMLElement {
    return rowByLabel(label)!.children[0] as HTMLElement;
  }

  it("paints each project row's monogram with an inline identity colour", () => {
    renderQuickOpen();
    const bravo = leadOf("bravo").style.backgroundColor;
    const alpha = leadOf("alpha").style.backgroundColor;
    expect(bravo).not.toBe("");
    // Distinct seed ids hash to distinct hues, so no two projects paint alike.
    expect(alpha).not.toBe("");
    expect(bravo).not.toBe(alpha);
  });

  it("leaves the No project row's bar unpainted", () => {
    renderQuickOpen();
    expect(leadOf("No project").style.backgroundColor).toBe("");
  });

  it("washes the project page header chip and keeps the chat page chip neutral", () => {
    renderQuickOpen();
    drillIn();
    const chip = headerChip();
    expect(chip).not.toBeNull();
    expect(chip!.style.backgroundColor).not.toBe("");
    // Back to the root's empty-query order, then down onto No project.
    act(() => labelled("back to projects")!.click());
    pressQuick("ArrowDown");
    drillIn();
    const chatChip = headerChip();
    expect(chatChip).not.toBeNull();
    expect(chatChip!.style.backgroundColor).toBe("");
  });

  it("paints a merged row with a remote member's icon, ringed in the row's hue (#1000)", () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    renderQuickOpen({ remoteIcon: { source: "custom", dataUrl } });
    const bravo = leadOf("bravo");
    expect(bravo.querySelector("img")?.getAttribute("src")).toBe(dataUrl);
    expect(bravo.textContent).toBe("");
    expect(bravo.style.boxShadow).not.toBe("");
    // The keyless local row has no icon and keeps its initials.
    expect(leadOf("alpha").querySelector("img")).toBeNull();
    expect(leadOf("alpha").textContent).toBe("AL");
  });

  it("keeps initials when the owner chose them over detection", () => {
    renderQuickOpen({ remoteIcon: { source: "none" } });
    expect(leadOf("bravo").querySelector("img")).toBeNull();
    expect(leadOf("bravo").textContent).toBe("BR");
  });
});
