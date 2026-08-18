// @vitest-environment jsdom
import { act } from "react";
import { useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchList } from "@omp-ui/core/types";
import type { WorkspaceSelection } from "./WorkspaceControl";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const fixture: BranchList = {
  repoRoot: "/p",
  current: "main",
  branches: ["main", "feature/x"],
  defaultBranch: "main",
  upstreamRef: null,
  upstreamRemote: null,
  hasUpstream: false,
  ahead: 0,
  behind: 0,
  upstreamFetchedAt: null,
  upstreamRefreshError: null,
};

// Only the channel the control's store path touches: the branch listing its
// popover and the shared fields refresh on mount.
const backendMock = {
  listBranches: vi.fn(async () => fixture),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic imports are required: store.ts → ./backend reads window.ompBackend
// at module load, so the mock above must land first.
const { useStore } = await import("../store");
const { WorkspaceControl } = await import("./WorkspaceControl");

let root: Root | null = null;
let changes: WorkspaceSelection[] = [];

/** Controlled harness: the composer owns the selection, the test watches it. */
function Harness({ projectCwd }: { projectCwd: string | undefined }) {
  const [value, setValue] = useState<WorkspaceSelection>({ mode: "checkout" });
  return (
    <WorkspaceControl
      projectCwd={projectCwd}
      value={value}
      onChange={(next) => {
        changes.push(next);
        setValue(next);
      }}
      error={null}
      pending={false}
    />
  );
}

function render(projectCwd: string | undefined): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Harness projectCwd={projectCwd} />));
}

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const trigger = (): HTMLButtonElement => {
  const button = document.body.querySelector<HTMLButtonElement>("button[aria-expanded]");
  expect(button).not.toBeNull();
  return button!;
};

const buttonByText = (text: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === text,
  );

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function selectInto(select: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  changes = [];
  backendMock.listBranches.mockResolvedValue(fixture);
  useStore.setState({ branches: { "/p": fixture }, branchActivity: {} });
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("WorkspaceControl", () => {
  it("offers Current checkout and New worktree in the popover", () => {
    render("/p");
    act(() => trigger().click());
    expect(buttonByText("Current checkout")).toBeDefined();
    expect(buttonByText("New worktree")).toBeDefined();
  });

  it("mints a branch and opens the sub-row when New worktree is picked", async () => {
    render("/p");
    act(() => trigger().click());
    act(() => buttonByText("New worktree")!.click());
    await act(async () => {
      await flushMicrotasks();
    });

    const picked = changes.find((c) => c.mode === "worktree");
    expect(picked).toBeDefined();
    expect(picked!.mode === "worktree" && picked!.branch).toMatch(/^omp-ui\/[0-9a-f]{8}$/);

    const input = document.body.querySelector<HTMLInputElement>("#composer-worktree-branch");
    expect(input).not.toBeNull();
    expect(input!.value).toBe(picked!.mode === "worktree" ? picked!.branch : "");
    // The base defaults to the checkout's current branch once the listing is in.
    const select = document.body.querySelector<HTMLSelectElement>("#composer-worktree-base");
    expect(select).not.toBeNull();
    expect(select!.value).toBe("main");
  });

  it("disables New worktree with the hint when the project is not a git repo", () => {
    const notGit: BranchList = { ...fixture, repoRoot: null, current: null, branches: [] };
    backendMock.listBranches.mockResolvedValue(notGit);
    useStore.setState({ branches: { "/p": notGit } });
    render("/p");
    act(() => trigger().click());

    const option = buttonByText("New worktree");
    expect(option).toBeDefined();
    expect(option!.disabled).toBe(true);
    expect(option!.title).toBe(
      "This project isn't inside a git repo, so there's nothing to worktree.",
    );
  });

  it("reports branch edits and base picks through onChange", async () => {
    render("/p");
    act(() => trigger().click());
    act(() => buttonByText("New worktree")!.click());
    await act(async () => {
      await flushMicrotasks();
    });
    changes = [];

    await typeInto(document.body.querySelector<HTMLInputElement>("#composer-worktree-branch")!, "feature/mine");
    const branchChange = changes.at(-1);
    expect(branchChange).toEqual({ mode: "worktree", branch: "feature/mine", baseRef: "main" });

    await selectInto(
      document.body.querySelector<HTMLSelectElement>("#composer-worktree-base")!,
      "feature/x",
    );
    expect(changes.at(-1)).toEqual({ mode: "worktree", branch: "feature/mine", baseRef: "feature/x" });
  });

  it("renders nothing without a project cwd", () => {
    render(undefined);
    expect(document.body.querySelector("button[aria-expanded]")).toBeNull();
  });
});
