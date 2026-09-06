// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchList, SessionWorktree } from "@omp-ui/core/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TAB_ID = "tab-worktree";
const PROJECT_CWD = "/project";

const branchFixture: BranchList = {
  repoRoot: "/project",
  current: "main",
  branches: ["main", "omp/feature"],
  defaultBranch: "main",
  upstreamRef: null,
  upstreamRemote: null,
  hasUpstream: false,
  ahead: 0,
  behind: 0,
  upstreamFetchedAt: null,
  upstreamRefreshError: null,
};

const backendMock = {
  getProjectOpenAvailability: vi.fn<() => Promise<{ vsCode: boolean; terminal: boolean }>>(),
  openProject: vi.fn<(path: string, target: "vscode" | "files" | "terminal") => Promise<void>>(),
  listBranches: vi.fn<() => Promise<BranchList>>(),
  // Merge feasibility moved to the Finish worktree dialog (issues #385–#389):
  // the chip must never call this, and the finish test asserts it stays quiet.
  getMergeBackStatus: vi.fn(),
  deleteSessionPreview: vi.fn<(tabId: string) => Promise<{ descendants: Array<{ tabId: string; title: string; running: boolean }> }>>(
    async () => ({ descendants: [] }),
  ),
  deleteSession: vi.fn(async (tabId: string) => ({ deleted: [tabId], failed: [] })),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic imports are required: ../store → ./backend reads window.ompBackend
// at module load, so the mock above must land first.
const { useStore } = await import("../store");
const { WorktreeChip } = await import("./WorktreeChip");

const worktree: SessionWorktree = {
  path: "/worktrees/alpha/omp-feature",
  branch: "omp/feature",
  base: "main",
};

let root: Root | null = null;

function seedStore(): void {
  useStore.setState({
    tabs: [],
    state: null,
    rpc: {},
    consoleOpen: {},
    finishWorktreeTab: null,
  });
}

function render(patch: Partial<SessionWorktree> = {}): void {
  if (root !== null) {
    act(() => root!.unmount());
    document.body.replaceChildren();
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <WorktreeChip
        worktree={{ ...worktree, ...patch }}
        tabId={TAB_ID}
        projectCwd={PROJECT_CWD}
      />,
    ),
  );
}

const trigger = (): HTMLButtonElement => {
  const found = document.body.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
  expect(found).not.toBeNull();
  return found!;
};

const menu = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[role="menu"]');

const menuItem = (text: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (el) => el.textContent === text,
  );

async function openPopover(): Promise<void> {
  await act(async () => trigger().click());
  await flushMicrotasks();
}

/**
 * A real mouse activation. The pointerdown commits — and can dismiss —
 * before the click lands, which `element.click()` alone never exercises.
 * The two events are dispatched in separate `act` calls precisely so React
 * flushes any dismissal between them, exactly as the browser does.
 */
async function press(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
  });
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await flushMicrotasks();
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  backendMock.getProjectOpenAvailability.mockReset();
  backendMock.getProjectOpenAvailability.mockResolvedValue({ vsCode: false, terminal: false });
  backendMock.openProject.mockReset();
  backendMock.openProject.mockResolvedValue(undefined);
  backendMock.listBranches.mockReset();
  backendMock.listBranches.mockResolvedValue(branchFixture);
  backendMock.getMergeBackStatus.mockReset();
  backendMock.deleteSessionPreview.mockReset();
  backendMock.deleteSessionPreview.mockResolvedValue({ descendants: [] });
  backendMock.deleteSession.mockReset();
  backendMock.deleteSession.mockImplementation(async (tabId) => ({
    deleted: [tabId],
    failed: [],
  }));
  seedStore();
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("WorktreeChip (issue #260)", () => {
  it("renders the chip trigger with the checkout path as tooltip", () => {
    render();
    const button = trigger();
    expect(button.textContent).toContain("⎇ omp/feature");
    expect(button.title).toBe(worktree.path);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(menu()).toBeNull();
  });

  it("opens a popover listing branch and path with copy buttons", async () => {
    render();
    await openPopover();

    const popover = menu();
    expect(popover).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(popover!.textContent).toContain("omp/feature");
    expect(popover!.textContent).toContain(worktree.path);
    const copies = [...popover!.querySelectorAll<HTMLButtonElement>("button")].filter(
      (el) => el.textContent === "copy",
    );
    expect(copies).toHaveLength(2);
  });

  it("offers Open in VS Code only when availability resolves true, and opens with it", async () => {
    backendMock.getProjectOpenAvailability.mockResolvedValue({ vsCode: true, terminal: false });
    render();
    await openPopover();

    expect(backendMock.getProjectOpenAvailability).toHaveBeenCalledTimes(1);
    const vscode = menuItem("Open in VS Code");
    expect(vscode).toBeDefined();
    await act(async () => vscode!.click());
    expect(backendMock.openProject).toHaveBeenCalledWith(worktree.path, "vscode");

    // Availability is asked once per mount — reopening does not re-probe.
    act(() => trigger().click());
    await openPopover();
    expect(backendMock.getProjectOpenAvailability).toHaveBeenCalledTimes(1);
  });

  it("hides Open in VS Code when availability resolves false or rejects", async () => {
    render();
    await openPopover();
    expect(menuItem("Open in VS Code")).toBeUndefined();
    act(() => trigger().click());

    backendMock.getProjectOpenAvailability.mockRejectedValue(new Error("no channel"));
    render();
    await openPopover();
    expect(menuItem("Open in VS Code")).toBeUndefined();
  });

  it("always offers Open in Files and hands it the checkout path", async () => {
    render();
    await openPopover();

    const files = menuItem("Open in Files");
    expect(files).toBeDefined();
    await act(async () => files!.click());
    expect(backendMock.openProject).toHaveBeenCalledWith(worktree.path, "files");
  });

  it("surfaces a rejected open as an alert and keeps the popover up", async () => {
    backendMock.openProject.mockRejectedValue(new Error("xdg-open failed"));
    render();
    await openPopover();

    await act(async () => menuItem("Open in Files")!.click());
    expect(menu()).not.toBeNull();
    const alert = document.body.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toBe("xdg-open failed");
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    render();
    await openPopover();
    expect(menu()).not.toBeNull();

    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on an outside pointerdown", async () => {
    render();
    await openPopover();
    expect(menu()).not.toBeNull();

    act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(menu()).toBeNull();
  });

  it("keeps the popover open on a pointerdown inside the portaled panel", async () => {
    render();
    await openPopover();

    act(() => menu()!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));

    expect(menu()).not.toBeNull();
  });

  it("opens the checkout on a full pointer press of Open in Files", async () => {
    render();
    await openPopover();

    await press(menuItem("Open in Files")!);

    expect(backendMock.openProject).toHaveBeenCalledWith(worktree.path, "files");
    expect(menu()).not.toBeNull();
  });

  it("renders the cut-from line verbatim for a ref base", async () => {
    render();
    await openPopover();
    expect(menu()!.textContent).toContain("cut from main");
  });

  it("shortens a 40-hex commit base in the cut-from line", async () => {
    render({ base: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0" });
    await openPopover();
    expect(menu()!.textContent).toContain("cut from a1b2c3d4");
    expect(menu()!.textContent).not.toContain("cut from a1b2c3d4e");
  });

  it("omits the cut-from line for a null base (pre-field record)", async () => {
    render({ base: null });
    await openPopover();
    expect(menu()!.textContent).not.toContain("cut from");
  });

  it("opens the finish dialog from the finish row with no status fetch", async () => {
    render();
    await openPopover();

    // Feasibility is the dialog's business now: opening the chip probes nothing.
    expect(backendMock.getMergeBackStatus).not.toHaveBeenCalled();
    const finish = menuItem("finish worktree…");
    expect(finish).toBeDefined();

    await act(async () => finish!.click());

    expect(useStore.getState().finishWorktreeTab).toBe(TAB_ID);
    expect(menu()).toBeNull();
    expect(backendMock.getMergeBackStatus).not.toHaveBeenCalled();
  });
});
