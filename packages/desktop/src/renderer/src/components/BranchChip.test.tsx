// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchList } from "@omp-ui/core/types";
import type { RpcTabState } from "../store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const fixture: BranchList = {
  repoRoot: "/p",
  current: "main",
  branches: ["main", "feature/x"],
  defaultBranch: "main",
};

const backendMock = {
  listBranches: vi.fn(async () => fixture),
  checkoutBranch: vi.fn(async () => {}),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic imports are required: store.ts → ./backend reads window.ompBackend
// at module load, so the mock above must land first.
const { useStore } = await import("../store");
const { BranchChip } = await import("./BranchChip");

let root: Root | null = null;

/** One running session on the project — the busy-confirm trigger. */
function seedBusy(): void {
  useStore.setState({
    branches: { "/p": fixture },
    tabs: [{ tabId: "tab-1", mode: "rpc-ui", projectCwd: "/p", hidden: false }],
    rpc: { "tab-1": { status: "running" } as unknown as RpcTabState },
    state: null,
  });
}

function render(cwd = "/p"): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<BranchChip projectCwd={cwd} />));
}

const chip = (): HTMLButtonElement => {
  const button = document.body.querySelector<HTMLButtonElement>("button[aria-expanded]");
  expect(button).not.toBeNull();
  return button!;
};

const buttonByText = (text: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === text,
  );
  expect(found).toBeDefined();
  return found!;
};

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  backendMock.listBranches.mockResolvedValue(fixture);
  useStore.setState({ branches: { "/p": fixture }, tabs: [], rpc: {}, state: null });
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("BranchChip", () => {
  it("renders the current branch, and nothing at all off-git (issue #35)", () => {
    useStore.setState({ branches: { "/p": fixture } });
    render();
    expect(chip().textContent).toContain("main");

    act(() => root!.unmount());
    root = null;
    document.body.replaceChildren();
    useStore.setState({
      branches: { "/p": { repoRoot: null, current: null, branches: [], defaultBranch: null } },
    });
    render();
    expect(document.body.querySelector("button")).toBeNull();
  });

  it("confirms a plain checkout while a session is mid-turn", async () => {
    seedBusy();
    render();

    await act(async () => chip().click());
    await act(async () => buttonByText("feature/x").click());

    expect(document.body.textContent).toContain("is mid-turn");
    expect(backendMock.checkoutBranch).not.toHaveBeenCalled();

    await act(async () => buttonByText("switch anyway").click());
    expect(backendMock.checkoutBranch).toHaveBeenCalledWith("/p", "feature/x", undefined);
  });

  it("creates a branch without the busy confirm", async () => {
    seedBusy();
    render();

    await act(async () => chip().click());
    await act(async () => buttonByText("new branch…").click());
    expect(document.body.textContent).not.toContain("is mid-turn");

    const input = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="new branch name"]',
    );
    expect(input).not.toBeNull();
    await typeInto(input!, "topic");
    await act(async () => {
      input!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });

    expect(backendMock.checkoutBranch).toHaveBeenCalledWith("/p", "topic", { create: true });
  });
});
