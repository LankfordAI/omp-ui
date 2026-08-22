// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionWorktree } from "@omp-ui/core/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const backendMock = {
  getProjectOpenAvailability: vi.fn<() => Promise<{ vsCode: boolean }>>(),
  openProject: vi.fn<(path: string, target: "vscode" | "files") => Promise<void>>(),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic imports are required: ../backend reads window.ompBackend at module
// load, so the mock above must land first.
const { shortBase, WorktreeChip } = await import("./WorktreeChip");

const worktree: SessionWorktree = {
  path: "/worktrees/alpha/omp-feature",
  branch: "omp/feature",
  base: "main",
};

let root: Root | null = null;

function render(patch: Partial<SessionWorktree> = {}): void {
  if (root !== null) {
    act(() => root!.unmount());
    document.body.replaceChildren();
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<WorktreeChip worktree={{ ...worktree, ...patch }} />));
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
}

beforeEach(() => {
  backendMock.getProjectOpenAvailability.mockReset();
  backendMock.getProjectOpenAvailability.mockResolvedValue({ vsCode: false });
  backendMock.openProject.mockReset();
  backendMock.openProject.mockResolvedValue(undefined);
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("shortBase", () => {
  it("shortens a 40-hex commit to 8 chars and leaves refs verbatim", () => {
    expect(shortBase("a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0")).toBe("a1b2c3d4");
    expect(shortBase("main")).toBe("main");
    // Uppercase hex is not git's normalized output — treated as a ref name.
    expect(shortBase("A1B2C3D4E5F6A7B8C9D0A1B2C3D4E5F6A7B8C9D0")).toBe(
      "A1B2C3D4E5F6A7B8C9D0A1B2C3D4E5F6A7B8C9D0",
    );
    // 39 or 41 hex chars is not a full SHA either.
    expect(shortBase("a".repeat(39))).toBe("a".repeat(39));
  });
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
    backendMock.getProjectOpenAvailability.mockResolvedValue({ vsCode: true });
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
});
