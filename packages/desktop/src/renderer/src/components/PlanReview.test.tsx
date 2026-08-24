// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchList } from "@omp-ui/core/types";
import { backendState, rpcTabState, tabInfo } from "../test/fixtures";

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
  upstreamRef: null,
  upstreamRemote: null,
  hasUpstream: false,
  ahead: 0,
  behind: 0,
  upstreamFetchedAt: null,
  upstreamRefreshError: null,
};

const backendMock = {
  listBranches: vi.fn(async () => branches),
  checkoutBranch: vi.fn(async () => {}),
  suggestBranchName: vi.fn(async (): Promise<string | null> => null),
  // The review panel loads advisor defaults on mount; the store's staged
  // model/advisor paths call the setters below.
  getAdvisorDefaults: vi.fn(async () => ({ enabled: false, model: null })),
  setProjectDefaultModel: vi.fn(async () => {}),
  setProjectDefaultAdvisorModel: vi.fn(async () => {}),
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

function tabState(patch: Parameters<typeof rpcTabState>[0] = {}) {
  return rpcTabState({
    status: "ready",
    // Skip the auto-title path: the implementation prompt would otherwise
    // reach for backend.generateTitle, which this mock does not provide.
    hasRenamed: true,
    planReview: {
      request: {
        title: "Fix the login race",
        planFilePath: "local://fix-login-race-plan.md",
        planAbsPath: "/x/fix-login-race-plan.md",
      },
      frame: { id: "p1" },
    },
    planText: "# Fix\n\nsteps",
    ...patch,
  });
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
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
  };
}

function stateWithSessions(titles: Record<string, string>) {
  return backendState({
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
  });
}

/** The standard seed: one gate-blocked review tab on a git-backed project. */
function seed(): void {
  useStore.setState({
    tabs: [tabInfo({ tabId: TAB, projectCwd: "/p" })],
    advisorDefaults: {},
    branches: { "/p": branches },
    rpc: { [TAB]: tabState() },
    state: stateWithSessions({ [TAB]: "Planning session" }),
  });
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function render(fill = false): void {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<PlanReview tabId={TAB} fill={fill} />));
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
const originalMatchMedia = window.matchMedia;

function setCompact(matches: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      matches,
      media: "(max-width: 899px)",
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(() => true),
    })),
  });
}

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function typeIntoTextarea(el: HTMLTextAreaElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** The refine change-notes box: the only textarea in the pane. */
const notesBox = (): HTMLTextAreaElement =>
  document.body.querySelector<HTMLTextAreaElement>("textarea")!;

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
  setCompact(false);
  seed();
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  host = null;
  document.body.replaceChildren();
  document.body.style.overflow = "";
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
});

describe("PlanReview git branch section (issue #25)", () => {
  it("renders no git branch section off-git", () => {
    useStore.setState({
      branches: {
        "/p": {
          repoRoot: null,
          current: null,
          branches: [],
          defaultBranch: null,
          upstreamRef: null,
          upstreamRemote: null,
          hasUpstream: false,
          ahead: 0,
          behind: 0,
          upstreamFetchedAt: null,
          upstreamRefreshError: null,
        },
      },
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
        tabInfo({ tabId: TAB, projectCwd: "/p" }),
        tabInfo({ tabId: "tab-2", projectCwd: "/p" }),
      ],
      rpc: {
        [TAB]: tabState(),
        "tab-2": tabState({ planReview: null, planText: null, status: "running" }),
      },
      state: stateWithSessions({ [TAB]: "Planning session", "tab-2": "Busy work" }),
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

  it.each(["close", "not now"])("defers from desktop %s without a verdict", async (route) => {
    render();
    await act(async () => {
      if (route === "close") {
        document.body.querySelector<HTMLButtonElement>('button[aria-label="leave plan pending"]')!.click();
      } else {
        buttonByText("not now").click();
      }
    });
    expect(verdictFrame()).toBeUndefined();
    expect(useStore.getState().rpc[TAB]!.planReview).not.toBeNull();
    expect(useStore.getState().rpc[TAB]!.planDeferred).toBe(true);
  });

  it("keeps the desktop review pending when Escape is pressed", async () => {
    render();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(verdictFrame()).toBeUndefined();
    expect(useStore.getState().rpc[TAB]!.planDeferred).toBe(false);
    expect(host!.querySelector("h2#plan-review-title")).not.toBeNull();
  });

  it("renders the review as a dock instead of an overlay", () => {
    expect(document.body.style.overflow).toBe("");
    render();
    expect(host!.querySelector("[data-overlay-root]")).toBeNull();
    expect(document.body.style.overflow).toBe("");
  });
});

describe("PlanReview dock height (issue #277)", () => {
  it("stays a capped dock by default", () => {
    render();
    const wrapper = host!.querySelector<HTMLElement>("[role=region]")!;
    expect(wrapper).not.toBeNull();
    expect(wrapper.className).toContain("shrink-0");
    expect(wrapper.className).toContain("max-h-[min(52dvh,var(--app-viewport-height,52dvh))]");
    const inner = host!.querySelector<HTMLElement>(".plan-review")!;
    expect(inner.className).not.toContain("flex-1");
  });

  it("fills the chat-history slot in fill mode: uncapped, inner column grows", () => {
    render(true);
    const wrapper = host!.querySelector<HTMLElement>("[role=region]")!;
    expect(wrapper).not.toBeNull();
    expect(wrapper.className).toContain("flex-1");
    expect(wrapper.className).toContain("min-h-0");
    expect(wrapper.className).not.toContain("max-h-[");
    const inner = host!.querySelector<HTMLElement>(".plan-review")!;
    expect(inner.className).toContain("flex-1");
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

describe("PlanReview change notes (issue #113)", () => {
  it("clears text and attachments on refine, so the revised proposal opens empty", async () => {
    clipboardImageMock.readImageFiles.mockResolvedValueOnce({ images: [IMAGE_ONE], rejected: [] });
    render();
    await act(async () => {
      choose(imagePicker(), [new File(["one"], "one.png", { type: "image/png" })], "picked");
      await Promise.resolve();
    });
    await typeIntoTextarea(notesBox(), "drop the API layer");

    await act(async () => {
      buttonByText("refine").click();
      await Promise.resolve();
    });
    expect(promptFrame()?.message).toContain("drop the API layer");

    // The revised proposal lands while the pane is still mounted — the exact
    // condition that used to leave the draft standing.
    await act(async () => {
      useStore.setState({
        rpc: {
          [TAB]: tabState({
            planReview: {
              request: {
                title: "Fix the login race",
                planFilePath: "local://fix-login-race-plan.md",
                planAbsPath: "/x/fix-login-race-plan.md",
              },
              frame: { id: "p2" },
            },
          }),
        },
      });
    });
    expect(notesBox().value).toBe("");
    expect(document.body.querySelectorAll('img[alt^="change note "]')).toHaveLength(0);
  });

  it("keeps the draft when the review is only deferred", async () => {
    render();
    await typeIntoTextarea(notesBox(), "still thinking");
    await act(async () => buttonByText("not now").click());
    await act(async () => useStore.getState().showPlanReview(TAB));
    expect(notesBox().value).toBe("still thinking");
  });
});

describe("PlanReview model + orchestrate staging (issues #95, #96)", () => {
  it("shows the session's model and all three keyword switches off by default", () => {
    useStore.setState({
      rpc: {
        [TAB]: tabState({
          model: { id: "k3", name: "Kimi K3", provider: "openrouter" },
        }),
      },
    });
    render();

    expect(document.body.textContent).toContain("Kimi K3");
    for (const label of [
      "ultrathink the implementation",
      "orchestrate the implementation",
      "workflowz the implementation",
    ]) {
      const keywordSwitch = document.body.querySelector<HTMLButtonElement>(
        `button[role="switch"][aria-label="${label}"]`,
      );
      expect(keywordSwitch).not.toBeNull();
      expect(keywordSwitch!.getAttribute("aria-checked")).toBe("false");
    }
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

  it("toggling ultrathink and workflowz prepends both keywords in notice order", async () => {
    render();
    for (const label of ["ultrathink the implementation", "workflowz the implementation"]) {
      const keywordSwitch = document.body.querySelector<HTMLButtonElement>(
        `button[role="switch"][aria-label="${label}"]`,
      )!;
      await act(async () => keywordSwitch.click());
    }
    await act(async () => {
      executeButton().click();
      await Promise.resolve();
    });

    expect(verdictFrame()).toMatchObject({ id: "p1", value: "execute" });
    expect(promptFrame()).toBeDefined();
    expect(String(promptFrame()!.message).startsWith("ultrathink\n\nworkflowz\n\n")).toBe(true);
  });

  it("a staged model pick flows to the set_model frame at execute", async () => {
    const MODEL_A = { id: "a", name: "Model A", provider: "p" };
    const MODEL_B = { id: "b", name: "Model B", provider: "p" };
    useStore.setState({
      rpc: { [TAB]: tabState({ model: MODEL_A, availableModels: [MODEL_A, MODEL_B] }) },
    });
    render();

    await act(async () => buttonByText("Model A").click());
    // The palette is the only overlay root; the review itself is docked.
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

  it("stages the configured advisor from the favorites-default palette", async () => {
    const ADVISOR = { id: "advisor-a", name: "Advisor A", provider: "p" };
    const DEFAULT = { id: "default", name: "Default Advisor", provider: "q" };
    const persisted = stateWithSessions({ [TAB]: "Planning session" });
    useStore.setState({
      state: {
        ...persisted,
        projects: persisted.projects.map((group) => ({
          ...group,
          sessions: group.sessions.map((session) =>
            session.tabId === TAB
              ? { ...session, advisor: true, advisorModel: "p/advisor-a" }
              : session,
          ),
        })),
      },
      advisorDefaults: { "/p": { enabled: true, model: "q/default" } },
      rpc: { [TAB]: tabState({ availableModels: [ADVISOR, DEFAULT] }) },
    });
    render();

    await act(async () => buttonByText("Advisor A").click());
    const overlays = document.body.querySelectorAll<HTMLElement>("[data-overlay-root]");
    const palette = overlays[overlays.length - 1]!;
    expect(palette.querySelector<HTMLButtonElement>('button[title="Favorites"]')!.getAttribute("aria-pressed")).toBe("true");
    expect(palette.querySelector<HTMLButtonElement>('button[title="p"]')!.getAttribute("aria-pressed")).toBe("false");
    await act(async () => palette.querySelector<HTMLButtonElement>('button[title="p"]')!.click());
    expect(palette.textContent).toContain("picking one restarts this session and resumes it");

    await act(async () => buttonContainingText("use omp's configured advisor", palette).click());
    expect(buttonByText("Default Advisor")).toBeDefined();
  });
});

describe("PlanReview plan rendering (issue #109)", () => {
  const planFrame = (): HTMLIFrameElement | null =>
    document.body.querySelector<HTMLIFrameElement>('iframe[title="proposed plan"]');

  it("renders the html rendition in an empty-sandbox iframe, markdown suppressed", async () => {
    useStore.setState({
      rpc: {
        [TAB]: tabState({
          planText: "# Fix\n\nmarkdown-only-body",
          planHtml: "<h1>Fix</h1><p>html-body</p>",
        }),
      },
    });
    render();

    const frame = planFrame();
    expect(frame).not.toBeNull();
    // The empty token list is the whole security story: no scripts, no
    // same-origin access, no forms, no popups, no navigation.
    expect(frame!.getAttribute("sandbox")).toBe("");
    // Diagram substitution + guardrail injection resolve asynchronously.
    await act(async () => {});
    expect(frame!.getAttribute("srcdoc")).toContain("<h1>Fix</h1><p>html-body</p>");
    expect(frame!.getAttribute("srcdoc")).toContain('id="omp-ui-plan-guardrails"');
    expect(document.body.textContent).not.toContain("markdown-only-body");
    // Only the plan area changes — every control still answers the gate.
    expect(executeButton()).toBeDefined();
    expect(buttonByText("refine")).toBeDefined();
    expect(buttonByText("not now")).toBeDefined();
    expect(document.body.textContent).toContain("implementation setup");
  });

  it("renders the markdown plan when there is no html rendition", () => {
    useStore.setState({
      rpc: { [TAB]: tabState({ planText: "# Fix\n\nmarkdown-only-body", planHtml: null }) },
    });
    render();

    expect(planFrame()).toBeNull();
    expect(document.body.textContent).toContain("markdown-only-body");
    expect(executeButton()).toBeDefined();
  });

  it("keeps the unreadable-plan warning when neither rendition loaded", () => {
    useStore.setState({
      rpc: { [TAB]: tabState({ planText: null, planHtml: null }) },
    });
    render();

    expect(planFrame()).toBeNull();
    expect(document.body.textContent).toContain("The plan file could not be read");
  });
});
describe("PlanReview mermaid diagrams (issue #285)", () => {
  const planFrame = (): HTMLIFrameElement | null =>
    document.body.querySelector<HTMLIFrameElement>('iframe[title="proposed plan"]');

  it("renders a mermaid block to contained SVG inside the guardrailed document", async () => {
    useStore.setState({
      rpc: {
        [TAB]: tabState({
          planText: null,
          planHtml:
            '<h1>Fix</h1><pre class="mermaid">flowchart TD; A--&gt;B</pre><p>after the diagram</p>',
        }),
      },
    });
    render();

    const frame = planFrame()!;
    // The real mermaid renderer measures text, which jsdom does not implement;
    // the smoke test covers real rendering. Here the block must be substituted
    // — rendered or failed — never left as raw source, and the guardrails must
    // still wrap the document with the diagram carve-out.
    await act(async () => {});
    // The hook resolves after a real dynamic import, so one microtask flush is
    // not enough — pump macrotasks until srcdoc populates.
    let srcdoc = frame.getAttribute("srcdoc")!;
    for (let i = 0; i < 50 && srcdoc === ""; i += 1) {
      await act(async () => {
        const { promise, resolve } = Promise.withResolvers<void>();
        setTimeout(resolve, 10);
        await promise;
      });
      srcdoc = frame.getAttribute("srcdoc")!;
    }
    expect(srcdoc).not.toContain('<pre class="mermaid">');
    expect(srcdoc).toContain("<p>after the diagram</p>");
    expect(srcdoc).toContain('id="omp-ui-plan-guardrails"');
    expect(srcdoc).toContain(".omp-ui-diagram svg {");
    expect(srcdoc).toContain("max-width: 100% !important;");
    expect(srcdoc).toContain("height: auto !important;");
  });
});

describe("PlanReview compact flow (issue #216)", () => {
  const step = (): HTMLElement => document.body.querySelector<HTMLElement>("[data-plan-review-step]")!;
  const planFrame = (): HTMLIFrameElement | null =>
    document.body.querySelector<HTMLIFrameElement>('iframe[title="proposed plan"]');

  beforeEach(() => {
    setCompact(true);
    useStore.setState({ rpc: { [TAB]: tabState({ planHtml: "<h1>Fix</h1><p>long plan</p>" }) } });
  });

  it("starts with only the plan surface mounted", () => {
    render();
    expect(step().dataset.planReviewStep).toBe("review");
    expect(planFrame()).not.toBeNull();
    expect(document.body.querySelector("textarea")).toBeNull();
    expect(document.body.querySelector('[aria-label="implementation setup"]')).toBeNull();
  });

  it("preserves refinement notes across back navigation and sends only on submit", async () => {
    render();
    await act(async () => buttonByText("refine").click());
    expect(step().dataset.planReviewStep).toBe("refine");
    expect(planFrame()).toBeNull();
    await typeIntoTextarea(notesBox(), "keep the retry bounded");
    await act(async () => buttonByText("back to plan").click());
    await act(async () => buttonByText("refine").click());
    expect(notesBox().value).toBe("keep the retry bounded");
    expect(verdictFrame()).toBeUndefined();

    await act(async () => buttonByText("send changes").click());
    expect(verdictFrame()).toMatchObject({ id: "p1", value: "refine" });
    expect(promptFrame()?.message).toBe("Revise the plan to incorporate these requested changes:\n\nkeep the retry bounded");
    expect(backendMock.rpcSend.mock.calls.filter((call) => (call[1] as Record<string, unknown>).type === "extension_ui_response")).toHaveLength(1);
  });

  it("opens setup without a verdict and executes with staged branch state", async () => {
    render();
    await act(async () => buttonByText("execute…").click());
    expect(step().dataset.planReviewStep).toBe("setup");
    expect(document.body.querySelector('[aria-label="implementation setup"]')).not.toBeNull();
    expect(document.body.querySelector('[aria-label="proposed plan"]')).toBeNull();
    expect(verdictFrame()).toBeUndefined();
    await act(async () => branchOption("new branch").click());
    await typeInto(newNameInput(), "feat/mobile-review");
    await act(async () => executeButton().click());
    expect(backendMock.checkoutBranch).toHaveBeenCalledWith("/p", "feat/mobile-review", { create: true });
    expect(verdictFrame()).toMatchObject({ id: "p1", value: "execute" });
  });

  it.each(["close", "not now"])("defers from compact review via %s without a verdict", async (route) => {
    render();
    await act(async () => {
      if (route === "close") {
        document.body.querySelector<HTMLButtonElement>('button[aria-label="leave plan pending"]')!.click();
      } else {
        buttonByText("not now").click();
      }
    });
    expect(verdictFrame()).toBeUndefined();
    expect(useStore.getState().rpc[TAB]!.planDeferred).toBe(true);
  });

  it("keeps the compact review pending when Escape is pressed", async () => {
    render();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(verdictFrame()).toBeUndefined();
    expect(useStore.getState().rpc[TAB]!.planDeferred).toBe(false);
    expect(host!.querySelector("h2#plan-review-title")).not.toBeNull();
  });

  it("returns to review for a revised proposal and after defer while retaining its draft", async () => {
    render();
    await act(async () => buttonByText("refine").click());
    await typeIntoTextarea(notesBox(), "unsent draft");
    await act(async () => buttonByText("back to plan").click());
    await act(async () => buttonByText("refine").click());
    await act(async () => document.body.querySelector<HTMLButtonElement>('button[aria-label="leave plan pending"]')!.click());
    await act(async () => useStore.getState().showPlanReview(TAB));
    expect(step().dataset.planReviewStep).toBe("review");
    await act(async () => buttonByText("refine").click());
    expect(notesBox().value).toBe("unsent draft");

    await act(async () => {
      useStore.setState({ rpc: { [TAB]: tabState({ planReview: { request: { title: "Revised", planFilePath: "local://revised.md", planAbsPath: "/x/revised.md" }, frame: { id: "p2" } }, planHtml: "<h1>Revised</h1>" }) } });
    });
    expect(step().dataset.planReviewStep).toBe("review");
  });

  it("keeps the complete workflow mounted on desktop", () => {
    setCompact(false);
    render();
    expect(document.body.querySelector("[data-plan-review-step]")).toBeNull();
    expect(planFrame()).not.toBeNull();
    expect(document.body.querySelector("textarea")).not.toBeNull();
    expect(document.body.querySelector('[aria-label="implementation setup"]')).not.toBeNull();
    expect(executeButton()).toBeDefined();
  });
  it("keeps compact setup visible for busy-session confirmation", async () => {
    useStore.setState({
      tabs: [tabInfo({ tabId: TAB, projectCwd: "/p" }), tabInfo({ tabId: "tab-2", projectCwd: "/p" })],
      rpc: { [TAB]: tabState({ planHtml: "<h1>Fix</h1>" }), "tab-2": tabState({ planReview: null, planText: null, status: "running" }) },
      state: stateWithSessions({ [TAB]: "Planning session", "tab-2": "Busy work" }),
    });
    render();
    await act(async () => buttonByText("execute…").click());
    await act(async () => branchOption("existing branch").click());
    await act(async () => buttonByText("feature/y").click());
    await act(async () => executeButton().click());
    expect(step().dataset.planReviewStep).toBe("setup");
    expect(document.body.textContent).toContain("is mid-turn");
    expect(verdictFrame()).toBeUndefined();
  });

  it("keeps compact setup visible when checkout fails", async () => {
    backendMock.checkoutBranch.mockRejectedValueOnce(new Error("checkout rejected"));
    render();
    await act(async () => buttonByText("execute…").click());
    await act(async () => branchOption("new branch").click());
    await typeInto(newNameInput(), "feat/rejected");
    await act(async () => executeButton().click());
    expect(step().dataset.planReviewStep).toBe("setup");
    expect(document.body.textContent).toContain("checkout rejected");
    expect(verdictFrame()).toBeUndefined();
  });

});

describe("PlanReview hydrated gate (issue #215)", () => {
  it("answers with the frame id the reconciler hydrated, not a stale one", async () => {
    // Seed the tab exactly as reconcilePlanGates does: a minimal
    // reconstructed frame carrying the record's proposal id, plus the
    // loaded document.
    useStore.setState({
      rpc: {
        [TAB]: tabState({
          planReview: {
            request: {
              title: "Fix the login race",
              planFilePath: "local://fix-login-race-plan.md",
              planAbsPath: "/x/fix-login-race-plan.md",
            },
            frame: { id: "p9" },
          },
        }),
      },
    });
    render();
    // The modal opened for the hydrated review...
    expect(document.body.textContent).toContain("Fix the login race");

    await act(async () => executeButton().click());
    // ...and its execute verdict echoes the hydrated frame id, so the
    // main process recognizes it as the answer to the pending gate.
    expect(verdictFrame()).toMatchObject({ id: "p9", value: "execute" });
  });
});
