// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const backendMock = {
  getState: vi.fn(),
  addProject: vi.fn(),
  removeProject: vi.fn(),
  setDefaultMode: vi.fn(),
  setSkipDeleteConfirmation: vi.fn(),
  spawnSession: vi.fn(),
  terminateSession: vi.fn(),
  switchMode: vi.fn(),
  deleteSession: vi.fn(),
  setSessionAdvisor: vi.fn(),
  getAdvisorDefaults: vi.fn(),
  setSessionModel: vi.fn(),
  generateTitle: vi.fn(),
  readPlanFile: vi.fn(),
  getBranchDiff: vi.fn(),
  ptyPasteImage: vi.fn(),
  ptyWrite: vi.fn(),
  ptyResize: vi.fn(),
  rpcSend: vi.fn(),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
  onRpcFrame: vi.fn(),
  onStateChanged: vi.fn(),
  toggleFavorite: vi.fn(),
  checkOmpUpdate: vi.fn(),
  applyOmpUpdate: vi.fn(),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic imports are required because store.ts captures the mocked preload bridge at module load.

const { useStore } = await import("../store");
const { DeleteSessionDialog } = await import("./DeleteSessionDialog");

let root: Root | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("DeleteSessionDialog", () => {
  it("shows every destructive effect and submits the checked opt-out", () => {
    const confirmDeleteSession = vi.fn(async () => {});
    const cancelDeleteSession = vi.fn();
    useStore.setState({ confirmDeleteSession, cancelDeleteSession });

    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <DeleteSessionDialog
          confirmation={{
            tabId: "tab-1",
            title: "Production repair",
            running: true,
            hasFiles: true,
          }}
        />,
      ),
    );

    const dialog = document.body.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Production repair");
    expect(dialog?.textContent).toContain("running agent will be stopped");
    expect(dialog?.textContent).toContain("transcript and artifacts will be erased");

    const checkbox = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    act(() => checkbox!.click());
    expect(checkbox!.checked).toBe(true);

    const deleteButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === "Delete session",
    );
    expect(deleteButton).toBeDefined();
    act(() => deleteButton!.click());
    expect(confirmDeleteSession).toHaveBeenCalledWith(true);
  });
});
