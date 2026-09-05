// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@omp-ui/core/types";
import { backendState, tabInfo } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const backendMock = {
  getState: vi.fn(async () => backendState()),
  terminateSession: vi.fn(async () => {}),
  switchMode: vi.fn(async () => {}),
  removeProject: vi.fn(async () => {}),
};
Object.assign(window, { ompBackend: backendMock });
// Tripwire, not automation: the old dialogs were native, and a surviving
// native call would hide itself from these DOM assertions (issue #373).
const nativeAlert = vi.fn();
const nativeConfirm = vi.fn(() => true);
window.alert = nativeAlert;
window.confirm = nativeConfirm;

// Dynamic imports: store.ts captures the mocked bridge at module load.
const { useStore } = await import("../store");
const { AppFeedback } = await import("./AppFeedback");

const TAB = "tab-fb-1";

const PROJECT = {
  path: "/p",
  name: "p",
  addedAt: "t",
  lastModel: null,
  lastThinkingLevel: null,
  lastAdvisor: null,
  lastAdvisorModel: null,
  defaultModel: null,
  defaultAdvisorModel: null,
};

function record(patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    tabId: TAB,
    sessionId: "s-1",
    lineageDir: "omp-ui--p--s-1",
    projectCwd: "/p",
    launchedAt: "t",
    mode: "rpc-ui",
    worktree: null,
    planImplementationSource: null,
    agentMode: "build",
    compactionMethod: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null,
    cachedTitle: "Running task",
    cachedModified: "t",
    title: "Running task",
    status: null,
    live: "live",
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
    ...patch,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function seed(): void {
  useStore.setState({
    state: backendState({ projects: [{ project: PROJECT, sessions: [record()] }] }),
    tabs: [tabInfo({ tabId: TAB, projectCwd: "/p" })],
    activeTabId: TAB,
    lifecycleConfirmation: null,
    errorNotices: [],
  });
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

/** Mounts the feedback host and drains the overlay hook's rAF focus pass. */
async function render(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<AppFeedback />));
  await settle();
}

/** Re-render pass + the overlay's rAF focus of a newly keyed dialog. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

const dialog = (): HTMLElement | null =>
  document.body.querySelector<HTMLElement>('[role="alertdialog"]');

const buttonIn = (text: string): HTMLButtonElement => {
  const found = [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (candidate) => candidate.textContent === text,
  );
  expect(found, `button "${text}"`).toBeDefined();
  return found!;
};

const pressEscape = (): void => {
  const node = dialog()!;
  act(() => {
    node.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
  });
};

beforeEach(() => {
  seed();
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
  vi.clearAllMocks();
  expect(nativeAlert).not.toHaveBeenCalled();
  expect(nativeConfirm).not.toHaveBeenCalled();
});

describe("stop confirmation is a drivable DOM dialog", () => {
  it("stages on the stop action, Cancel from the DOM declines", async () => {
    await render();
    expect(dialog()).toBeNull();

    await act(async () => {
      await useStore.getState().terminate(TAB);
    });
    await settle();
    expect(dialog()).not.toBeNull();
    expect(dialog()!.textContent).toContain("Stop the agent?");
    expect(dialog()!.textContent).toContain("Running task"); // the captured target
    expect(backendMock.terminateSession).not.toHaveBeenCalled();
    // Cancel owns the initial focus: accepting must be a deliberate act.
    expect(document.activeElement?.textContent).toBe("Cancel");

    await act(async () => {
      buttonIn("Cancel").click();
    });
    expect(useStore.getState().lifecycleConfirmation).toBeNull();
    expect(dialog()).toBeNull();
    expect(backendMock.terminateSession).not.toHaveBeenCalled();
  });

  it("Escape cancels before acceptance and Confirm dispatches the stop once", async () => {
    await render();
    await act(async () => {
      await useStore.getState().terminate(TAB);
    });
    await settle();
    pressEscape();
    expect(useStore.getState().lifecycleConfirmation).toBeNull();
    expect(backendMock.terminateSession).not.toHaveBeenCalled();

    await act(async () => {
      await useStore.getState().terminate(TAB);
    });
    await settle();
    await act(async () => {
      buttonIn("Stop agent").click();
    });
    expect(backendMock.terminateSession).toHaveBeenCalledWith(TAB);
    expect(useStore.getState().lifecycleConfirmation).toBeNull();
    expect(dialog()).toBeNull();
  });

  it("while an accepted stop is in flight the dialog blocks and dispatches once", async () => {
    const stop = deferred<void>();
    backendMock.terminateSession.mockReturnValueOnce(stop.promise);
    await render();
    await act(async () => {
      await useStore.getState().terminate(TAB);
    });
    await settle();
    const id = useStore.getState().lifecycleConfirmation!.id;
    const change = useStore.getState().confirmLifecycleAction(id);
    await settle();

    // Both buttons disabled; Escape is a no-op while busy: an accepted
    // backend command is not cancellable, and re-activation must not fire.
    expect(buttonIn("Cancel").disabled).toBe(true);
    expect(buttonIn("Working…").disabled).toBe(true);
    pressEscape();
    expect(useStore.getState().lifecycleConfirmation).toMatchObject({ id, busy: true });
    await act(async () => {
      await useStore.getState().confirmLifecycleAction(id);
    });
    expect(backendMock.terminateSession).toHaveBeenCalledTimes(1);

    stop.resolve(undefined);
    await act(async () => {
      await change;
    });
    expect(useStore.getState().lifecycleConfirmation).toBeNull();
    expect(dialog()).toBeNull();
  });
});

describe("mode-switch and project-removal dialogs", () => {
  it("names the target mode, then routes removal decisions the same way", async () => {
    await render();
    await act(async () => {
      await useStore.getState().switchMode(TAB, "pty");
    });
    await settle();
    expect(dialog()!.textContent).toContain("Switch session mode?");
    expect(dialog()!.textContent).toContain("terminal");
    await act(async () => {
      buttonIn("Restart session").click();
    });
    expect(backendMock.switchMode).toHaveBeenCalledWith(TAB, "pty");

    await act(async () => {
      await useStore.getState().removeProject("/p");
    });
    await settle();
    expect(dialog()!.textContent).toContain("Remove project?");
    expect(dialog()!.textContent).toContain("/p");
    expect(backendMock.removeProject).not.toHaveBeenCalled();
    await act(async () => {
      buttonIn("Remove project").click();
    });
    expect(backendMock.removeProject).toHaveBeenCalledWith("/p");
  });
});

describe("error notices", () => {
  it("reads the full backend text in order and restores the hidden confirmation", async () => {
    await act(async () => {
      await useStore.getState().terminate(TAB);
    });
    await render();
    useStore.setState({
      errorNotices: [
        { id: "e1", message: "first: no such file" },
        {
          id: "e2",
          message: "Could not enable the advisor: EPERM: locked\n\nThe agent has stopped.",
        },
      ],
    });
    await settle();

    // The error outranks the pending confirmation — without dropping it.
    expect(dialog()!.textContent).toContain("Could not complete the action");
    expect(dialog()!.textContent).toContain("first: no such file");
    // A DOM notice never blocks the renderer's event loop: a queued task runs.
    let laterRan = false;
    await act(async () => {
      setTimeout(() => {
        laterRan = true;
      }, 0);
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
    expect(laterRan).toBe(true);

    await act(async () => {
      buttonIn("Dismiss").click();
    });
    await settle();
    expect(dialog()!.textContent).toContain("EPERM: locked");
    expect(dialog()!.textContent).toContain("The agent has stopped.");

    await act(async () => {
      buttonIn("Dismiss").click();
    });
    await settle();
    // Both notices acknowledged: the still-pending decision is back.
    expect(dialog()!.textContent).toContain("Stop the agent?");
    expect(useStore.getState().lifecycleConfirmation).not.toBeNull();

    await act(async () => {
      buttonIn("Cancel").click();
    });
    expect(useStore.getState().errorNotices).toEqual([]);
    expect(useStore.getState().lifecycleConfirmation).toBeNull();
    expect(dialog()).toBeNull();
  });
});
