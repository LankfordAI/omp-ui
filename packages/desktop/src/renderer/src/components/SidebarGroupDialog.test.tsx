// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectGroup, SidebarGroup } from "@omp-ui/core/types";
import { backendState } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const backendMock = {
  createSidebarGroup: vi.fn(async (): Promise<unknown> => ({})),
  renameSidebarGroup: vi.fn(async () => {}),
  setProjectSidebarGroup: vi.fn(async () => {}),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { SidebarGroupDialog } = await import("./SidebarGroupDialog");

const PATH = "/p/a";

const projectGroup = (path: string, name: string): ProjectGroup => ({
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
  },
  sessions: [],
});

const groups: SidebarGroup[] = [
  { id: "g-1", name: "Existing", collapsed: false, projectPaths: [] },
];

let root: Root | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({
    state: backendState({ projects: [projectGroup(PATH, "Alpha")], sidebarGroups: groups }),
    sidebarGroupDialog: { kind: "move", projectPath: PATH },
  });
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

function render(): void {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<SidebarGroupDialog />));
}

function radio(label: string): HTMLInputElement {
  const row = [...document.querySelectorAll("label")].find((l) => l.textContent === label);
  if (row === undefined) throw new Error(`no radio labelled ${label}`);
  return row.querySelector<HTMLInputElement>('input[type="radio"]')!;
}

function nameInput(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('input[aria-label="Group name"]')!;
}

function type(el: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function saveButton(): HTMLButtonElement {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.textContent === "Save",
  )!;
}

describe("SidebarGroupDialog", () => {
  it("creates a new group holding the project from move mode, then closes", async () => {
    render();
    act(() => radio("New group…").click());
    expect(document.activeElement).toBe(nameInput());
    type(nameInput(), "Team");
    await act(async () => saveButton().click());

    expect(backendMock.createSidebarGroup).toHaveBeenCalledWith("Team", PATH);
    expect(useStore.getState().sidebarGroupDialog).toBeNull();
  });

  it("shows a backend rejection without the IPC prefix and stays open", async () => {
    backendMock.createSidebarGroup.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'sidebarGroup:create': Error: A group named “Team” already exists.",
      ),
    );
    render();
    act(() => radio("New group…").click());
    type(nameInput(), "Team");
    await act(async () => saveButton().click());

    expect(document.querySelector('[role="alert"]')!.textContent).toBe(
      "A group named “Team” already exists.",
    );
    expect(useStore.getState().sidebarGroupDialog).toEqual({ kind: "move", projectPath: PATH });
    expect(saveButton().disabled).toBe(false);
  });

  it("keeps Save disabled for a whitespace-only name", async () => {
    useStore.setState({ sidebarGroupDialog: { kind: "create" } });
    render();
    expect(saveButton().disabled).toBe(true);
    type(nameInput(), "   ");
    expect(saveButton().disabled).toBe(true);
    await act(async () => saveButton().click());
    expect(backendMock.createSidebarGroup).not.toHaveBeenCalled();
  });

  it("closes itself when the target project leaves state", () => {
    render();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    act(() => useStore.setState({ state: backendState({ sidebarGroups: groups }) }));

    expect(useStore.getState().sidebarGroupDialog).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
