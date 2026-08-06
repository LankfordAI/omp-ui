// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendState, BranchList } from "@omp-ui/core/types";
import { emptySessionRuntime } from "../lib/rpc-types";
import type { RpcTabState } from "../store";

const clipboardImageMock = vi.hoisted(() => ({
  hasClipboardImage: vi.fn(() => false),
  readClipboardImages: vi.fn(),
  readImageFiles: vi.fn(),
}));

vi.mock("../lib/clipboard-image", () => clipboardImageMock);

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const branches: BranchList = {
  repoRoot: "/p",
  current: "main",
  branches: ["main", "feature/y"],
  defaultBranch: "main",
};

const backendMock = {
  listBranches: vi.fn(async () => branches),
  checkoutBranch: vi.fn(async () => {}),
  suggestBranchName: vi.fn(async (): Promise<string | null> => null),
  // The review modal loads advisor defaults on mount; the store's staged
  // model/advisor paths call the setters below.
  getAdvisorDefaults: vi.fn(async () => ({ enabled: false, model: null })),
  setSessionModel: vi.fn(async () => {}),
  setSessionAdvisor: vi.fn(async () => {}),
  rpcSend: vi.fn(),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic imports are required: store.ts → ./backend reads window.ompBackend
// at module load, so the mock above must land first.
const { useStore } = await import("../store");
const { PlanReview } = await import("./PlanReview");

const TAB = "tab-1";

function tabState(patch: Partial<RpcTabState> = {}): RpcTabState {
  return {
    status: "ready",
    items: [],
    todos: [],
    model: null,
    availableModels: [],
    commands: [],
    session: emptySessionRuntime(),
    stats: null,
    subagents: [],
    extensionStatus: {},
    pendingCommands: new Map(),
    extensionQueue: [],
    busy: false,
    initialPrompt: null,
    // Skip the auto-title path: the implementation prompt would otherwise
    // reach for backend.generateTitle, which this mock does not provide.
    hasRenamed: true,
    plan: null,
    planReview: {
      request: {
        title: "Fix the login race",
        planFilePath: "local://fix-login-race-plan.md",
        planAbsPath: "/x/fix-login-race-plan.md",
      },
      frame: { id: "p1" },
    },
    planText: "# Fix\n\nsteps",
    planDeferred: false,
    plans: [],
    advisorStats: null,
    ...patch,
  };
}

function sessionRecord(tabId: string, title: string) {
  return {
    tabId,
    sessionId: `session-${tabId}`,
    lineageDir: `omp-ui--p--${tabId}`,
    projectCwd: "/p",
    launchedAt: "t",
    mode: "rpc-ui" as const,
    advisor: false,
    advisorModel: null,
    cachedTitle: title,
    cachedModified: "t",
    title,
    status: "complete" as const,
    live: "live" as const,
  };
}

function backendState(titles: Record<string, string>): BackendState {
  return {
    defaultMode: "rpc-ui",
    modelFavorites: [],
    skipDeleteConfirmation: false,
    themeId: "graphite",
    appUpdateCheckOnLaunch: true,
    ompUpdateCheckOnLaunch: true,
    dismissedAppUpdateVersion: null,
    dismissedOmpUpdateVersion: null,
    projects: [
      {
        project: {
          path: "/p",
          name: "P",
          addedAt: "t",
          lastModel: null,
          lastAdvisorModel: null,
        },
        sessions: Object.entries(titles).map(([tabId, title]) => sessionRecord(tabId, title)),
      },
    ],
  };
}

/** The standard seed: one gate-blocked review tab on a git-backed project. */
function seed(): void {
  useStore.setState({
    tabs: [{ tabId: TAB, mode: "rpc-ui", projectCwd: "/p", hidden: false }],
    branches: { "/p": branches },
    rpc: { [TAB]: tabState() },
    state: backendState({ [TAB]: "Planning session" }),
  });
}

let root: Root | null = null;

function render(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<PlanReview tabId={TAB} />));
}

const buttonByText = (text: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === text,
  );
  expect(found).toBeDefined();
  return found!;
};

/** Palette rows are multi-span, so exact textContent matching misses them. */
const buttonContainingText = (
  text: string,
  rootEl: ParentNode = document.body,
): HTMLButtonElement => {
  const found = [...rootEl.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.includes(text),
  );
  expect(found).toBeDefined();
  return found!;
};

/** Branch destination segments expose their full label through aria-label. */
const branchOption = (label: string): HTMLButtonElement => {
  const found = document.body.querySelector<HTMLButtonElement>(
    `button[aria-pressed][aria-label="${label}"]`,
  );
  expect(found).not.toBeNull();
  return found!;
};

const newNameInput = (): HTMLInputElement => {
  const input = document.body.querySelector<HTMLInputElement>(
    'input[aria-label="new branch name"]',
  );
  expect(input).not.toBeNull();
  return input!;
};

const executeButton = (): HTMLButtonElement => buttonByText("execute in this session");

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The verdict frame answering the blocked plan-review select, if one was sent. */
function verdictFrame(): Record<string, unknown> | undefined {
  const call = backendMock.rpcSend.mock.calls.find(
    (c) => (c[1] as Record<string, unknown>).type === "extension_ui_response",
  );
  return call?.[1] as Record<string, unknown> | undefined;
}

/** The refine notes' prompt frame, if refinePlan steered the planner. */
function promptFrame(): Record<string, unknown> | undefined {
  const call = backendMock.rpcSend.mock.calls.find(
    (c) => (c[1] as Record<string, unknown>).type === "prompt",
  );
  return call?.[1] as Record<string, unknown> | undefined;
}

function imagePicker(): HTMLInputElement {
  const input = document.body.querySelector<HTMLInputElement>('input[type="file"]');
  expect(input).not.toBeNull();
  return input!;
}

function choose(input: HTMLInputElement, files: File[], value: string): void {
  Object.defineProperty(input, "files", { configurable: true, value: files });
  Object.defineProperty(input, "value", { configurable: true, writable: true, value });
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

beforeEach(() => {
  vi.clearAllMocks();
  backendMock.listBranches.mockResolvedValue(branches);
  backendMock.suggestBranchName.mockResolvedValue(null);
  clipboardImageMock.hasClipboardImage.mockReset().mockReturnValue(false);
  clipboardImageMock.readClipboardImages.mockReset();
  clipboardImageMock.readImageFiles.mockReset().mockResolvedValue({ images: [], rejected: [] });
  seed();
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("PlanReview git branch section (issue #25)", () => {
  it("renders no git branch section off-git", () => {
    useStore.setState({
      branches: { "/p": { repoRoot: null, current: null, branches: [], defaultBranch: null } },
    });
    render();
    expect(document.body.textContent).not.toContain("git branch");
  });

  it("prefills the new-branch name from the plan slug", async () => {
    render();
    await act(async () => branchOption("new branch").click());
    expect(newNameInput().value).toBe("fix-login-race");
  });

  it("executes on the current branch without touching git", async () => {
    render();
    await act(async () => executeButton().click());
    expect(verdictFrame()).toMatchObject({ id: "p1", value: "execute" });
    expect(backendMock.checkoutBranch).not.toHaveBeenCalled();
  });

  it("creates and switches to a new branch before answering the gate", async () => {
    render();
    await act(async () => branchOption("new branch").click());
    await typeInto(newNameInput(), "feat/x");
    await act(async () => executeButton().click());

    expect(backendMock.checkoutBranch).toHaveBeenCalledWith("/p", "feat/x", { create: true });
    expect(verdictFrame()).toMatchObject({ id: "p1", value: "execute" });
    // The checkout must land first: a verdict before it would dispatch the
    // implementation onto the wrong branch.
    const verdictCall = backendMock.rpcSend.mock.calls.findIndex(
      (c) => (c[1] as Record<string, unknown>).type === "extension_ui_response",
    );
    expect(backendMock.checkoutBranch.mock.invocationCallOrder[0]!).toBeLessThan(
      backendMock.rpcSend.mock.invocationCallOrder[verdictCall]!,
    );
  });

  it("keeps the gate blocked when git refuses the checkout", async () => {
    backendMock.checkoutBranch.mockRejectedValueOnce(
      new Error("error: pathspec 'feat/x' did not match any file(s) known to git"),
    );
    render();
    await act(async () => branchOption("new branch").click());
    await typeInto(newNameInput(), "feat/x");
    await act(async () => executeButton().click());

    expect(document.body.textContent).toContain("pathspec 'feat/x' did not match");
    expect(verdictFrame()).toBeUndefined();
    // The review is still pending — the agent stays blocked on its select.
    expect(useStore.getState().rpc[TAB]!.planReview).not.toBeNull();
  });

  it("confirms before switching branches under a mid-turn session", async () => {
    useStore.setState({
      tabs: [
        { tabId: TAB, mode: "rpc-ui", projectCwd: "/p", hidden: false },
        { tabId: "tab-2", mode: "rpc-ui", projectCwd: "/p", hidden: false },
      ],
      rpc: {
        [TAB]: tabState(),
        "tab-2": tabState({ planReview: null, planText: null, status: "running" }),
      },
      state: backendState({ [TAB]: "Planning session", "tab-2": "Busy work" }),
    });
    render();

    await act(async () => branchOption("existing branch").click());
    await act(async () => buttonByText("feature/y").click());
    await act(async () => executeButton().click());

    expect(document.body.textContent).toContain("is mid-turn");
    expect(backendMock.checkoutBranch).not.toHaveBeenCalled();
    expect(verdictFrame()).toBeUndefined();

    await act(async () => buttonByText("switch anyway").click());
    expect(backendMock.checkoutBranch).toHaveBeenCalledWith("/p", "feature/y", undefined);
    expect(verdictFrame()).toMatchObject({ id: "p1", value: "execute" });
  });

  it("lets the model's suggestion replace an untouched prefill", async () => {
    backendMock.suggestBranchName.mockResolvedValue("feat/model-name");
    render();
    await act(async () => {}); // flush the suggestion's .then
    await act(async () => branchOption("new branch").click());
    expect(newNameInput().value).toBe("feat/model-name");
  });

  it("never overwrites a typed name with the model's suggestion", async () => {
    // Executor form required: this tsconfig's lib predates Promise.withResolvers.
    let resolveSuggest!: (value: string | null) => void;
    backendMock.suggestBranchName.mockReturnValue(
      new Promise((resolve) => {
        resolveSuggest = resolve;
      }),
    );
    render();
    await act(async () => branchOption("new branch").click());
    await typeInto(newNameInput(), "my-branch");
    await act(async () => {
      resolveSuggest("feat/model-name");
    });
    expect(newNameInput().value).toBe("my-branch");
  });

  it.each(["close", "Escape", "scrim", "not now"])("defers from compact %s without a verdict", async (route) => {
    render();
    await act(async () => {
      if (route === "close") {
        document.body.querySelector<HTMLButtonElement>('button[aria-label="close dialog"]')!.click();
      } else if (route === "Escape") {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      } else if (route === "scrim") {
        document.body.querySelector<HTMLElement>("[data-overlay-root]")!.dispatchEvent(new Event("pointerdown", { bubbles: true }));
      } else {
        buttonByText("not now").click();
      }
    });
    expect(verdictFrame()).toBeUndefined();
    expect(useStore.getState().rpc[TAB]!.planReview).not.toBeNull();
    expect(useStore.getState().rpc[TAB]!.planDeferred).toBe(true);
  });
});

const IMAGE_ONE = { type: "image" as const, data: "one", mimeType: "image/png" };
const IMAGE_TWO = { type: "image" as const, data: "two", mimeType: "image/jpeg" };

describe("PlanReview refine attachment picker (issue #65)", () => {
  it("offers a paperclip that opens a multi-image picker", () => {
    render();
    const input = imagePicker();
    const button = document.body.querySelector<HTMLButtonElement>('button[title="attach images"]')!;
    const click = vi.spyOn(input, "click");

    expect(button).not.toBeNull();
    expect(input.accept).toBe("image/*");
    expect(input.multiple).toBe(true);
    expect(input.classList.contains("sr-only")).toBe(true);
    act(() => button.click());
    expect(click).toHaveBeenCalledOnce();
  });

  it("drops the paste tail from the refine placeholder", () => {
    render();
    const textarea = document.body.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.placeholder).toBe("What should change before implementation?");
  });

  it("adds picked files to the thumbnail strip and removes one", async () => {
    clipboardImageMock.readImageFiles.mockResolvedValueOnce({
      images: [IMAGE_ONE, IMAGE_TWO],
      rejected: [],
    });
    render();
    const first = new File(["one"], "one.png", { type: "image/png" });
    const second = new File(["two"], "two.jpg", { type: "image/jpeg" });

    await act(async () => {
      choose(imagePicker(), [first, second], "chosen-images");
      await Promise.resolve();
    });

    expect(clipboardImageMock.readImageFiles).toHaveBeenCalledWith([first, second]);
    expect(document.body.querySelectorAll('img[alt^="change note "]')).toHaveLength(2);
    expect(document.body.textContent).toContain("2 attachments");

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('button[aria-label="remove change note 1"]')!
        .click();
    });
    expect(document.body.querySelectorAll('img[alt^="change note "]')).toHaveLength(1);
    expect(document.body.textContent).toContain("1 attachment");
  });

  it("resets the input immediately so the same file can be picked again", async () => {
    clipboardImageMock.readImageFiles
      .mockResolvedValueOnce({ images: [IMAGE_ONE], rejected: [] })
      .mockResolvedValueOnce({ images: [IMAGE_ONE], rejected: [] });
    render();
    const input = imagePicker();
    const file = new File(["one"], "one.png", { type: "image/png" });

    await act(async () => {
      choose(input, [file], "first-selection");
      expect(input.value).toBe("");
      await Promise.resolve();
    });
    await act(async () => {
      choose(input, [file], "same-file-selection");
      expect(input.value).toBe("");
      await Promise.resolve();
    });

    expect(clipboardImageMock.readImageFiles).toHaveBeenNthCalledWith(1, [file]);
    expect(clipboardImageMock.readImageFiles).toHaveBeenNthCalledWith(2, [file]);
    expect(document.body.querySelectorAll('img[alt^="change note "]')).toHaveLength(2);
  });

  it("surfaces picker rejections as the paste error", async () => {
    clipboardImageMock.readImageFiles.mockResolvedValueOnce({
      images: [],
      rejected: ["broken.png could not be read"],
    });
    render();
    const broken = new File(["broken"], "broken.png", { type: "image/png" });

    await act(async () => {
      choose(imagePicker(), [broken], "rejected-selection");
      await Promise.resolve();
    });

    expect(imagePicker().value).toBe("");
    expect(document.body.textContent).toContain("broken.png could not be read");
    expect(document.body.querySelectorAll('img[alt^="change note "]')).toHaveLength(0);
  });

  it("sends picked images with the refine verdict", async () => {
    clipboardImageMock.readImageFiles.mockResolvedValueOnce({
      images: [IMAGE_ONE],
      rejected: [],
    });
    render();
    const file = new File(["one"], "one.png", { type: "image/png" });

    await act(async () => {
      choose(imagePicker(), [file], "chosen-image");
      await Promise.resolve();
    });
    // Flush beyond the click: sendPrompt awaits runCommand before its rpcSend lands.
    await act(async () => {
      buttonByText("refine").click();
      await Promise.resolve();
    });

    expect(verdictFrame()).toMatchObject({ id: "p1", value: "refine" });
    expect(promptFrame()).toMatchObject({
      type: "prompt",
      message: "Revise the plan per the attached change notes.",
      images: [IMAGE_ONE],
    });
  });
});

describe("PlanReview model + orchestrate staging (issues #95, #96)", () => {
  it("shows the session's model and an off orchestrate switch by default", () => {
    useStore.setState({
      rpc: {
        [TAB]: tabState({
          model: { id: "k3", name: "Kimi K3", provider: "openrouter" },
        }),
      },
    });
    render();

    expect(document.body.textContent).toContain("Kimi K3");
    const orchestrateSwitch = document.body.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="orchestrate the implementation"]',
    );
    expect(orchestrateSwitch).not.toBeNull();
    expect(orchestrateSwitch!.getAttribute("aria-checked")).toBe("false");
  });

  it("toggling orchestrate prepends the keyword to the implementation prompt", async () => {
    render();
    const orchestrateSwitch = document.body.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="orchestrate the implementation"]',
    )!;
    await act(async () => orchestrateSwitch.click());
    await act(async () => {
      executeButton().click();
      await Promise.resolve();
    });

    expect(verdictFrame()).toMatchObject({ id: "p1", value: "execute" });
    expect(promptFrame()).toBeDefined();
    expect(String(promptFrame()!.message).startsWith("orchestrate\n\n")).toBe(true);
  });

  it("a staged model pick flows to the set_model frame at execute", async () => {
    const MODEL_A = { id: "a", name: "Model A", provider: "p" };
    const MODEL_B = { id: "b", name: "Model B", provider: "p" };
    useStore.setState({
      rpc: { [TAB]: tabState({ model: MODEL_A, availableModels: [MODEL_A, MODEL_B] }) },
    });
    render();

    await act(async () => buttonByText("Model A").click());
    // The palette stacks a second overlay root on top of the review modal.
    const overlays = document.body.querySelectorAll<HTMLElement>("[data-overlay-root]");
    const palette = overlays[overlays.length - 1]!;
    // The palette opens on its (empty) favorites tab — the models list under
    // their provider tab.
    await act(async () => palette.querySelector<HTMLButtonElement>('button[title="p"]')!.click());
    await act(async () => buttonContainingText("Model B", palette).click());
    await act(async () => {
      executeButton().click();
      await Promise.resolve();
    });

    // setModel awaits a response that never arrives here, so the chain stalls
    // before the prompt — the set_model frame is the observable effect.
    const setModelFrame = backendMock.rpcSend.mock.calls
      .map((c) => c[1] as Record<string, unknown>)
      .find((frame) => frame.type === "set_model");
    expect(setModelFrame).toMatchObject({ type: "set_model", provider: "p", modelId: "b" });
  });
});
