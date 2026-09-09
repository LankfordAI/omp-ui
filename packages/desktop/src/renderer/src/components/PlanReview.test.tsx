// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchList, SessionWorktree } from "@omp-ui/core/types";
import type { ThemedToken } from "shiki/core";
import type { PlanDiagnostic } from "@omp-ui/core/plan";
import type { PreparedPlanState } from "../lib/plan-document";
import type { ParsedPlanSource } from "../lib/plan-source";
import type { CodeTokenizer } from "../lib/plan-highlight";
import type { Theme } from "../lib/themes";
import { backendState, rpcTabState, tabInfo } from "../test/fixtures";

const clipboardImageMock = vi.hoisted(() => ({
  hasClipboardImage: vi.fn(() => false),
  readClipboardImages: vi.fn(),
  readImageFiles: vi.fn(),
}));

vi.mock("../lib/clipboard-image", () => clipboardImageMock);

/**
 * Pinned settled state for the prepared-document hook: `null` runs the real
 * pipeline (parse, transforms, structural verify, plus a layout probe jsdom
 * resolves as inconclusive without ever creating a frame); an object pins
 * exactly what the surface sees, which is how the readiness and fallback
 * cases state theirs (issue #312 follow-up).
 */
const planPrepared = vi.hoisted(() => ({ state: null as PreparedPlanState | null }));

vi.mock("../lib/plan-document", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/plan-document")>();
  return {
    ...original,
    // The original hook always runs first so hook order stays stable even on
    // the render that switches to the pinned state.
    usePreparedPlanDocument: (html: string | null, identity?: string) => {
      const state = original.usePreparedPlanDocument(html, identity);
      return planPrepared.state ?? state;
    },
  };
});

// Issue #329: both leaf renderers sit behind a real dynamic import (mermaid
// ~440 ms, shiki ~110 ms in this environment), which raced this file's wait
// budget under full-suite load. Stubbing the renderer and the tokenizer at the
// seams the pipeline injects keeps the substitution, guardrail, verification
// and theme behaviour under test real while making the pipeline
// microtask-only. Real-engine coverage lives in lib/plan-diagrams.smoke.test.ts
// and lib/plan-highlight.smoke.test.ts.
vi.mock("../lib/plan-diagrams", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/plan-diagrams")>();
  return {
    ...original,
    // The pipeline injects this renderer itself (issue #384), so the stub has
    // to live on the export, not on an argument.
    renderMermaid: async (id: string) =>
      `<svg data-diagram="${id}" viewBox="0 0 10 10"></svg>`,
  };
});

vi.mock("../lib/plan-highlight", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/plan-highlight")>();
  // One coloured token per source line: enough for the `tk-N` spans and the
  // token rule the case asserts, without loading a grammar.
  const tokenizeStub: CodeTokenizer = async (source) =>
    source
      .split("\n")
      .map((line) => [{ content: line, offset: 0, color: "#0000ff" } as ThemedToken]);
  return {
    ...original,
    planHighlightTransform: (
      parsed: ParsedPlanSource,
      theme: Theme,
      tokenize: CodeTokenizer = tokenizeStub,
    ) => original.planHighlightTransform(parsed, theme, tokenize),
  };
});

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
  defaultRemote: "origin",
};

const backendMock = {
  listBranches: vi.fn(async () => branches),
  checkoutBranch: vi.fn(async () => {}),
  suggestBranchName: vi.fn(async (): Promise<string | null> => null),
  // A pinned fresh dispatch (issue #316) reaches the real executePlan, which
  // fires the fresh implementation spawn; resolve it so the fire-and-forget
  // path settles instead of rejecting on a missing mock.
  spawnSession: vi.fn(async () => ({ tabId: "fresh-tab" })),
  // The review panel loads advisor defaults on mount; the store's staged
  // model/advisor paths call the setters below.
  getAdvisorDefaults: vi.fn(async () => ({ enabled: false, model: null })),
  setProjectDefaultModel: vi.fn(async () => {}),
  setProjectDefaultAdvisorModel: vi.fn(async () => {}),
  setSessionModel: vi.fn(async () => {}),
  setSessionAdvisor: vi.fn(async () => {}),
  rpcSend: vi.fn(),
  // An HTML gate settles only through main's accepted answer (#312 follow-up);
  // markdown gates never reach it.
  answerPlanReview: vi.fn(async () => ({ status: "accepted" as const })),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic imports are required: store.ts → ./backend (and lib/themes)
// at module load, so the mock above must land first.
const { useStore } = await import("../store");
const { applyTheme, resolveTheme } = await import("../lib/themes");
const { PlanReview } = await import("./PlanReview");

const TAB = "tab-1";
/** A gated HTML proposal carries the artifact's SHA-256 (64 lowercase hex). */
const SOURCE_HASH = "1f3c".repeat(16);

/**
 * The standard gate. `html` puts the proposal on an HTML artifact instead,
 * which is what switches on the document review, the readiness guard, and the
 * acknowledged answer (issue #312 follow-up).
 */
function tabState(patch: Parameters<typeof rpcTabState>[0] = {}, html = false) {
  const ext = html ? "html" : "md";
  return rpcTabState({
    status: "ready",
    // Skip the auto-title path: the implementation prompt would otherwise
    // reach for backend.generateTitle, which this mock does not provide.
    hasRenamed: true,
    planReview: {
      request: {
        title: "Fix the login race",
        planFilePath: `local://fix-login-race-plan.${ext}`,
        planAbsPath: `/x/fix-login-race-plan.${ext}`,
        ...(html ? { sourceHash: SOURCE_HASH } : {}),
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
    planImplementationSource: null,
    agentMode: "build" as const,
    compactionMethod: null,
    model: null,
    thinkingLevel: null,
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

function stateWithSessions(
  titles: Record<string, string>,
  worktrees: Record<string, SessionWorktree> = {},
) {
  return backendState({
    projects: [
      {
        project: {
          path: "/p",
          name: "P",
          addedAt: "t",
          lastModel: null,
          lastThinkingLevel: null,
          lastAdvisor: null,
          lastAdvisorModel: null,
          defaultModel: null,
          defaultAdvisorModel: null,
        },
        sessions: Object.entries(titles).map(([tabId, title]) => ({
          ...sessionRecord(tabId, title),
          worktree: worktrees[tabId] ?? null,
        })),
      },
    ],
  });
}

/** The standard seed: one gate-blocked review tab on a git-backed project. */
function seed(worktrees: Record<string, SessionWorktree> = {}): void {
  useStore.setState({
    tabs: [tabInfo({ tabId: TAB, projectCwd: "/p" })],
    advisorDefaults: {},
    branches: { "/p": branches },
    rpc: { [TAB]: tabState() },
    state: stateWithSessions({ [TAB]: "Planning session" }, worktrees),
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

/**
 * Flushes act until the predicate holds. With the leaf renderers stubbed the
 * prepared-document pipeline is microtask-only, so each flush drains it
 * wholesale: no wall-clock budget, so suite load cannot decide the outcome
 * (issue #329). The trailing assertion names the real cause instead of letting
 * a later `toContain` miss stand in for it.
 */
async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 5 && !ok(); i += 1) {
    await act(async () => {});
  }
  expect(ok(), "the prepared plan document never settled").toBe(true);
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
  // A pinned prepared state never outlives the case that pinned it.
  planPrepared.state = null;
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
          // Off-git: not a repo, so no push-target remote.
          defaultRemote: null,
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

  it.each([
    ["current", "main"],
    ["new", "feat/exact"],
    ["existing", "feature/y"],
  ] as const)("submits the exact %s project destination", async (choice, expectedBranch) => {
    const realExecutePlan = useStore.getState().executePlan;
    const executePlanSpy = vi.fn();
    useStore.setState({ executePlan: executePlanSpy });
    try {
      render();
      if (choice === "new") {
        await act(async () => branchOption("new branch").click());
        await typeInto(newNameInput(), expectedBranch);
      } else if (choice === "existing") {
        await act(async () => branchOption("existing branch").click());
        await act(async () => buttonByText(expectedBranch).click());
      }
      await act(async () => executeButton().click());
      expect(executePlanSpy).toHaveBeenCalledWith(
        TAB,
        "existing",
        expect.objectContaining({
          destination: { kind: "project-checkout", branch: expectedBranch },
        }),
      );
    } finally {
      useStore.setState({ executePlan: realExecutePlan });
    }
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

  it("does not confirm for a running worktree session of the project (issue #292)", async () => {
    useStore.setState({
      tabs: [
        tabInfo({ tabId: TAB, projectCwd: "/p" }),
        tabInfo({ tabId: "tab-2", projectCwd: "/p" }),
      ],
      rpc: {
        [TAB]: tabState(),
        "tab-2": tabState({ planReview: null, planText: null, status: "running" }),
      },
      state: stateWithSessions(
        { [TAB]: "Planning session", "tab-2": "Busy work" },
        { "tab-2": { path: "/wt/busy", branch: "feat/busy", base: null } },
      ),
    });
    render();

    await act(async () => branchOption("existing branch").click());
    await act(async () => buttonByText("feature/y").click());
    await act(async () => executeButton().click());

    // The worktree session guards its own checkout, not the project root.
    expect(document.body.textContent).not.toContain("is mid-turn");
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

describe("PlanReview worktree execution context (issue #313)", () => {
  /** A Session-fieldset context row (aria-pressed, label-led text). */
  const contextRow = (label: string): HTMLButtonElement => {
    const found = [...document.body.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(
      (candidate) => candidate.textContent?.startsWith(label),
    );
    expect(found).toBeDefined();
    return found!;
  };

  it("offers four contexts; picking worktree mints a branch and shows the worktree fields", async () => {
    render();
    for (const label of [
      "this session",
      "this session, compacted",
      "fresh session",
      "worktree session",
    ]) {
      expect(contextRow(label)).toBeDefined();
    }
    await act(async () => contextRow("worktree session").click());

    const input = document.body.querySelector<HTMLInputElement>("#plan-worktree-branch")!;
    expect(input).not.toBeNull();
    // Minted once on first pick; once the base resolves the mint names its
    // cut point (issue #405): omp-ui/<base>/<hex> (ADR-0018 app scratch work).
    expect(input.value).toMatch(/^omp-ui\/(?:main\/)?[0-9a-f]{8}$/);
    const base = document.body.querySelector<HTMLSelectElement>("#plan-worktree-base")!;
    expect(base).not.toBeNull();
    // Base defaults to the checkout's current branch once the fields mount.
    await act(async () => {});
    expect(base.value).toBe("main");
    // The Git-branch fieldset is a same-session-contexts concern: hidden here.
    expect(document.body.textContent).not.toContain("Git branch");

    // Re-picking the active selection keeps the minted name (issue #225).
    const minted = input.value;
    await act(async () => contextRow("worktree session").click());
    expect(document.body.querySelector<HTMLInputElement>("#plan-worktree-branch")!.value).toBe(
      minted,
    );
  });

  it("disables the worktree context off-git and leaves the other contexts alone", () => {
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
          defaultRemote: null,
        },
      },
    });
    render();
    const row = contextRow("worktree session");
    expect(row.disabled).toBe(true);
    expect(row.title).toBe("the project isn't a git repo");
    // The other contexts stay offered and enabled.
    for (const label of ["this session", "fresh session"]) {
      expect(contextRow(label).disabled).toBe(false);
    }
    expect(buttonByText("execute in this session")).toBeDefined();
    expect(document.body.querySelector("#plan-worktree-branch")).toBeNull();
  });

  it("keeps execute disabled while the worktree branch name is empty", async () => {
    render();
    await act(async () => contextRow("worktree session").click());
    await act(async () => {});
    const input = document.body.querySelector<HTMLInputElement>("#plan-worktree-branch")!;

    expect(buttonByText("execute in worktree session").disabled).toBe(false);
    await typeInto(input, "");
    expect(buttonByText("execute in worktree session").disabled).toBe(true);
    await typeInto(input, "omp-ui/renamed");
    expect(buttonByText("execute in worktree session").disabled).toBe(false);
  });

  it("executes the worktree context with the staged spec and no checkout", async () => {
    const realExecutePlan = useStore.getState().executePlan;
    const executePlanSpy = vi.fn();
    useStore.setState({ executePlan: executePlanSpy });
    try {
      render();
      await act(async () => contextRow("worktree session").click());
      await act(async () => {});
      const input = document.body.querySelector<HTMLInputElement>("#plan-worktree-branch")!;
      const base = document.body.querySelector<HTMLSelectElement>("#plan-worktree-base")!;
      await act(async () => {
        buttonByText("execute in worktree session").click();
        await Promise.resolve();
      });

      expect(executePlanSpy).toHaveBeenCalledTimes(1);
      expect(executePlanSpy).toHaveBeenCalledWith(
        TAB,
        "worktree",
        expect.objectContaining({
          worktree: { branch: input.value, baseRef: base.value === "" ? null : base.value, baseBranch: null },
          destination: { kind: "worktree", branch: input.value },
        }),
      );
      expect(backendMock.checkoutBranch).not.toHaveBeenCalled();
    } finally {
      useStore.setState({ executePlan: realExecutePlan });
    }
  });

  it("stages a dispatch whose base is a new branch with baseBranch (issue #405)", async () => {
    const realExecutePlan = useStore.getState().executePlan;
    const executePlanSpy = vi.fn();
    useStore.setState({ executePlan: executePlanSpy });
    try {
      render();
      await act(async () => contextRow("worktree session").click());
      await act(async () => {});
      const base = document.body.querySelector<HTMLSelectElement>("#plan-worktree-base")!;
      act(() => {
        base.value = "__new__";
        base.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await typeInto(
        document.body.querySelector<HTMLInputElement>("#plan-worktree-new-base")!,
        "TECH-123",
      );
      await act(async () => {
        buttonByText("execute in worktree session").click();
        await Promise.resolve();
      });

      expect(executePlanSpy).toHaveBeenCalledTimes(1);
      const options = executePlanSpy.mock.calls[0]![2] as {
        worktree: { branch: string; baseRef: string | null; baseBranch: string | null };
        destination: { kind: "worktree"; branch: string };
      };
      expect(options.worktree).toEqual({
        branch: expect.stringMatching(/^omp-ui\/TECH-123\/[0-9a-f]{8}$/),
        baseRef: "main",
        baseBranch: "TECH-123",
      });
      expect(options).toMatchObject({
        destination: { kind: "worktree", branch: options.worktree.branch },
      });
    } finally {
      useStore.setState({ executePlan: realExecutePlan });
    }
  });

  it("re-mints the worktree branch for a revised proposal", async () => {
    render();
    await act(async () => contextRow("worktree session").click());
    await act(async () => {});
    const first = document.body.querySelector<HTMLInputElement>("#plan-worktree-branch")!.value;

    // A refined-and-reproposed plan re-seeds the pane while it stays mounted.
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
    // A refined-and-reproposed gate returns to the safe visible default.
    expect(document.body.querySelector("#plan-worktree-branch")).toBeNull();
    expect(buttonByText("execute in this session").disabled).toBe(false);
    expect(document.body.textContent).toContain("Git branch");

    await act(async () => contextRow("worktree session").click());
    const second = document.body.querySelector<HTMLInputElement>("#plan-worktree-branch")!.value;
    expect(second).toMatch(/^omp-ui\/(?:main\/)?[0-9a-f]{8}$/);
    expect(second).not.toBe(first);
  });

  it("picking the worktree context from a worktree planning session prefills the planning branch and hides the base (issue #316)", async () => {
    seed({ [TAB]: { path: "/wt/planning", branch: "omp-ui/planning1", base: "main" } });
    render();
    await act(async () => contextRow("worktree session").click());

    const input = document.body.querySelector<HTMLInputElement>("#plan-worktree-branch")!;
    // Prefilled with the planning branch, not a fresh mint.
    expect(input.value).toBe("omp-ui/planning1");
    // Nothing is cut from a base while the branch matches: the select hides.
    expect(document.body.querySelector("#plan-worktree-base")).toBeNull();
    expect(document.body.textContent).toContain("reuses this checkout in place");
    // The Git-branch fieldset is a project-checkout concern: hidden here.
    expect(document.body.textContent).not.toContain("Git branch");
  });

  it("dispatching on the planning checkout sends no base and keeps its branch (issue #405)", async () => {
    const realExecutePlan = useStore.getState().executePlan;
    const executePlanSpy = vi.fn();
    useStore.setState({ executePlan: executePlanSpy });
    try {
      seed({ [TAB]: { path: "/wt/planning", branch: "omp-ui/planning1", base: "main" } });
      render();
      await act(async () => contextRow("worktree session").click());
      await act(async () => {});
      await act(async () => {
        buttonByText("execute in worktree session").click();
        await Promise.resolve();
      });

      expect(executePlanSpy).toHaveBeenCalledTimes(1);
      const options = executePlanSpy.mock.calls[0]![2] as {
        worktree: { branch: string; baseBranch: string | null };
        destination: { kind: "worktree"; branch: string };
      };
      expect(options.worktree.branch).toBe("omp-ui/planning1");
      expect(options.worktree.baseBranch).toBeNull();
      expect(options).toMatchObject({
        destination: { kind: "worktree", branch: "omp-ui/planning1" },
      });
    } finally {
      useStore.setState({ executePlan: realExecutePlan });
    }
  });

  it("editing the branch away from the planning branch restores the base select (issue #316)", async () => {
    seed({ [TAB]: { path: "/wt/planning", branch: "omp-ui/planning1", base: "main" } });
    render();
    await act(async () => contextRow("worktree session").click());
    const input = document.body.querySelector<HTMLInputElement>("#plan-worktree-branch")!;
    expect(document.body.querySelector("#plan-worktree-base")).toBeNull();

    await typeInto(input, "omp-ui/fresh-cut");

    expect(document.body.querySelector("#plan-worktree-base")).not.toBeNull();
    expect(document.body.textContent).not.toContain("reuses this checkout in place");
  });

  it.each([
    ["this session", "existing"],
    ["this session, compacted", "compacted"],
    ["fresh session", "fresh"],
  ] as const)(
    "pins %s execution to the planning worktree",
    async (contextLabel, context) => {
      const realExecutePlan = useStore.getState().executePlan;
      const executePlanSpy = vi.fn();
      useStore.setState({ executePlan: executePlanSpy });
      try {
        seed({ [TAB]: { path: "/wt/planning", branch: "omp-ui/planning1", base: "main" } });
        render();
        if (context !== "existing") {
          await act(async () => contextRow(contextLabel).click());
        }

        expect(document.body.textContent).toContain("Worktree branch");
        expect(document.body.textContent).toContain(
          "This context stays in the planning session's worktree",
        );
        expect(document.body.textContent).toContain("omp-ui/planning1");
        expect(document.body.textContent).not.toContain("Git branch");

        await act(async () => buttonByText(`execute in ${contextLabel}`).click());
        expect(executePlanSpy).toHaveBeenCalledWith(
          TAB,
          context,
          expect.objectContaining({
            destination: { kind: "worktree", branch: "omp-ui/planning1" },
          }),
        );
        expect(backendMock.checkoutBranch).not.toHaveBeenCalled();
      } finally {
        useStore.setState({ executePlan: realExecutePlan });
      }
    },
  );

  it("a fresh context from a non-worktree planning session keeps the git-branch section (issue #316)", async () => {
    render();
    await act(async () => contextRow("fresh session").click());
    // No planning worktree: the project-checkout branch dance still applies.
    expect(document.body.textContent).toContain("Git branch");
  });

  // The plan names the destination (issue #422): the mint's hash segment in
  // cut-from mode, the new base's name in create-base mode — never typed text.
  const branchInput = (): HTMLInputElement =>
    document.body.querySelector<HTMLInputElement>("#plan-worktree-branch")!;
  const baseSelect = (): HTMLSelectElement =>
    document.body.querySelector<HTMLSelectElement>("#plan-worktree-base")!;
  const newBaseInput = (): HTMLInputElement =>
    document.body.querySelector<HTMLInputElement>("#plan-worktree-new-base")!;

  /** Base → *new branch…*, the select's reveal transition. */
  async function revealNewBase(): Promise<void> {
    act(() => {
      baseSelect().value = "__new__";
      baseSelect().dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => {});
  }

  /** A suggestion whose answer the case delivers by hand, so it controls
   * whether the model lands before or after the user's own edit. */
  function deferredSuggestion(): { resolveSuggest: (value: string | null) => void } {
    let resolveSuggest!: (value: string | null) => void;
    backendMock.suggestBranchName.mockReturnValue(
      new Promise<string | null>((resolve) => {
        resolveSuggest = resolve;
      }),
    );
    return { resolveSuggest };
  }

  it("replaces an untouched mint's hash with the plan's name (issue #422)", async () => {
    backendMock.suggestBranchName.mockResolvedValue("fix/login-race");
    render();
    await act(async () => contextRow("worktree session").click());
    await act(async () => {});

    // The mint prefix keeps naming the base; only the hash segment goes.
    expect(branchInput().value).toBe("omp-ui/main/fix/login-race");
    expect(backendMock.suggestBranchName).toHaveBeenCalledTimes(1);
  });

  it("names the mint when the row is picked before the model answers (issue #422)", async () => {
    const { resolveSuggest } = deferredSuggestion();
    render();
    await act(async () => contextRow("worktree session").click());
    await act(async () => {});
    const minted = branchInput().value;
    expect(minted).toMatch(/^omp-ui\/(?:main\/)?[0-9a-f]{8}$/);

    await act(async () => {
      resolveSuggest("fix/login-race");
    });

    expect(branchInput().value).toBe("omp-ui/main/fix/login-race");
  });

  it("prefills the new base with the plan slug and follows the model after it (issue #422)", async () => {
    const { resolveSuggest } = deferredSuggestion();
    render();
    await act(async () => contextRow("worktree session").click());
    await act(async () => {});

    // The reveal never waits on the model: the plan's slug is already there.
    await revealNewBase();
    expect(newBaseInput().value).toBe("fix-login-race");
    // Selected, so typing replaces the prefill instead of appending to it.
    expect(newBaseInput().selectionStart).toBe(0);
    expect(newBaseInput().selectionEnd).toBe(newBaseInput().value.length);
    expect(branchInput().value).toMatch(/^omp-ui\/fix-login-race\/[0-9a-f]{8}$/);

    await act(async () => {
      resolveSuggest("feat/x");
    });

    expect(newBaseInput().value).toBe("feat/x");
    // The branch keeps following its base, hash tail intact.
    expect(branchInput().value).toMatch(/^omp-ui\/feat\/x\/[0-9a-f]{8}$/);
  });

  it("prefills a resolved suggestion on reveal and keeps the branch truthful (issue #422)", async () => {
    backendMock.suggestBranchName.mockResolvedValue("feat/x");
    render();
    await act(async () => contextRow("worktree session").click());
    await act(async () => {});
    expect(branchInput().value).toBe("omp-ui/main/feat/x");

    await revealNewBase();

    expect(newBaseInput().value).toBe("feat/x");
    // §3.2: a suggestion-named branch states what it is cut from — the base
    // now IS the suggestion, so both segments carry it. Freely editable.
    expect(branchInput().value).toBe("omp-ui/feat/x/feat/x");
  });

  it("never overwrites a typed branch or base name with the suggestion (issue #422)", async () => {
    const { resolveSuggest } = deferredSuggestion();
    render();
    await act(async () => contextRow("worktree session").click());
    await revealNewBase();
    await typeInto(branchInput(), "omp-ui/mine");
    await typeInto(newBaseInput(), "tech-123");

    await act(async () => {
      resolveSuggest("feat/x");
    });

    expect(branchInput().value).toBe("omp-ui/mine");
    expect(newBaseInput().value).toBe("tech-123");
  });

  it("keeps a cleared base name cleared instead of refilling the suggestion (issue #422)", async () => {
    backendMock.suggestBranchName.mockResolvedValue("feat/x");
    render();
    await act(async () => contextRow("worktree session").click());
    await act(async () => {});
    await revealNewBase();
    expect(newBaseInput().value).toBe("feat/x");

    await typeInto(newBaseInput(), "");

    // The reveal transition was null → ""; this is "" → "", so it stays put
    // and the empty-name gate blocks execute.
    expect(newBaseInput().value).toBe("");
    expect(buttonByText("execute in worktree session").disabled).toBe(true);
  });

  it("leaves the planning checkout's branch alone when the suggestion lands (issue #316, #422)", async () => {
    const realExecutePlan = useStore.getState().executePlan;
    const executePlanSpy = vi.fn();
    useStore.setState({ executePlan: executePlanSpy });
    try {
      backendMock.suggestBranchName.mockResolvedValue("fix/login-race");
      seed({ [TAB]: { path: "/wt/planning", branch: "omp-ui/planning1", base: "main" } });
      render();
      await act(async () => contextRow("worktree session").click());
      await act(async () => {});

      expect(branchInput().value).toBe("omp-ui/planning1");

      await act(async () => {
        buttonByText("execute in worktree session").click();
        await Promise.resolve();
      });
      const options = executePlanSpy.mock.calls[0]![2] as {
        worktree: { branch: string; baseBranch: string | null };
      };
      expect(options.worktree.branch).toBe("omp-ui/planning1");
      expect(options.worktree.baseBranch).toBeNull();
    } finally {
      useStore.setState({ executePlan: realExecutePlan });
    }
  });

  it("degrades to the mint and the plan slug when the model declines (issue #422)", async () => {
    backendMock.suggestBranchName.mockResolvedValue(null);
    render();
    await act(async () => contextRow("worktree session").click());
    await act(async () => {});

    expect(branchInput().value).toMatch(/^omp-ui\/(?:main\/)?[0-9a-f]{8}$/);
    await revealNewBase();
    expect(newBaseInput().value).toBe("fix-login-race");
  });

  it("dispatches the suggestion-named branch with no base to create (issue #422)", async () => {
    const realExecutePlan = useStore.getState().executePlan;
    const executePlanSpy = vi.fn();
    useStore.setState({ executePlan: executePlanSpy });
    try {
      backendMock.suggestBranchName.mockResolvedValue("fix/login-race");
      render();
      await act(async () => contextRow("worktree session").click());
      await act(async () => {});

      await act(async () => {
        buttonByText("execute in worktree session").click();
        await Promise.resolve();
      });

      const options = executePlanSpy.mock.calls[0]![2] as {
        worktree: { branch: string; baseRef: string | null; baseBranch: string | null };
        destination: { kind: "worktree"; branch: string };
      };
      expect(options.worktree).toEqual({
        branch: "omp-ui/main/fix/login-race",
        baseRef: "main",
        baseBranch: null,
      });
      expect(options.destination).toEqual({
        kind: "worktree",
        branch: "omp-ui/main/fix/login-race",
      });
    } finally {
      useStore.setState({ executePlan: realExecutePlan });
    }
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
        [TAB]: tabState(
          {
            planText: "# Fix\n\nmarkdown-only-body",
            planHtml: "<h1>Fix</h1><p>html-body</p>",
          },
          true,
        ),
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
    // The document also carries its own restrictive policy, so the sandbox is
    // not the only thing keeping it inert.
    expect(frame!.getAttribute("srcdoc")).toContain(
      '<meta http-equiv="Content-Security-Policy"',
    );
    expect(document.body.textContent).not.toContain("markdown-only-body");
    // Only the plan area changes — refine and defer still answer the gate.
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

  it("names the diagnostics and the raw source instead of the iframe when preparation fails", async () => {
    const diagnostics: PlanDiagnostic[] = [
      {
        code: "LAYOUT_EMPTY",
        stage: "layout",
        repair: "source",
        severity: "error",
        message: "the document laid out no visible content",
        detail: "0 painted elements at 800px",
        location: { startOffset: 13, endOffset: 35, line: 2, column: 7 },
      },
    ];
    planPrepared.state = { status: "failed", doc: null, diagnostics };
    useStore.setState({
      rpc: {
        [TAB]: tabState(
          {
            planText: "<html><body></body></html>",
            planHtml: "<html><body></body></html>",
          },
          true,
        ),
      },
    });
    render();
    await act(async () => {});

    expect(planFrame()).toBeNull();
    expect(document.body.textContent).toContain("could not be displayed as a document");
    // Named from the stable code through the localized catalog, with its
    // source location and the engine's own detail.
    expect(document.body.textContent).toContain("the document laid out no visible content");
    expect(document.body.textContent).toContain("2:7");
    expect(document.body.textContent).toContain("0 painted elements at 800px");
    // The raw plan source is shown as escaped text, and the wording sends
    // nobody off to have the agent rewrite anything.
    expect(document.body.querySelector("pre[data-selectable]")!.textContent).toContain(
      "<html><body></body></html>",
    );
    expect(document.body.textContent).not.toContain("rewrite");
    // The fallback keeps the review real: refine and defer still answer the
    // gate, while execute — which would act on a document that does not exist —
    // stays disabled.
    expect(buttonByText("refine").disabled).toBe(false);
    expect(executeButton().disabled).toBe(true);
  });
  it("shows the prepared document under an incomplete-verification note when the probe cannot conclude", async () => {
    // The false-failure state from issue #415: a valid prepared document in
    // the iframe while the local probe timed out. The note must say the
    // CHECK did not finish — never that display failed.
    const diagnostics: PlanDiagnostic[] = [
      {
        code: "VERIFIER_TIMEOUT",
        stage: "layout",
        repair: "application",
        severity: "warning",
        message: "verification timed out",
        detail: "no measurement after document load within 4000 ms",
      },
    ];
    planPrepared.state = { status: "unavailable", doc: "<h1>Fix</h1>", diagnostics };
    useStore.setState({
      rpc: {
        [TAB]: tabState({ planText: "<h1>Fix</h1>", planHtml: "<h1>Fix</h1>" }, true),
      },
    });
    render();
    await act(async () => {});

    const frame = planFrame();
    expect(frame).not.toBeNull();
    expect(frame!.getAttribute("srcdoc")).toContain("<h1>Fix</h1>");
    expect(document.body.textContent).toContain("could not finish checking its layout");
    expect(document.body.textContent).not.toContain("could not be displayed as a document");
    // The escaped-source fallback is NOT this state: no raw source block.
    expect(document.body.querySelector("pre[data-selectable]")).toBeNull();
    // Execute still requires a ready preparation; refine stays live.
    expect(executeButton().disabled).toBe(true);
    expect(buttonByText("refine").disabled).toBe(false);
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
    await until(() => (frame.getAttribute("srcdoc") ?? "") !== "");
    const srcdoc = frame.getAttribute("srcdoc")!;
    expect(srcdoc).not.toContain('<pre class="mermaid">');
    expect(srcdoc).toContain("<p>after the diagram</p>");
    expect(srcdoc).toContain('id="omp-ui-plan-guardrails"');
    expect(srcdoc).toContain(".omp-ui-diagram svg {");
    expect(srcdoc).toContain("max-width: 100% !important;");
    expect(srcdoc).toContain("height: auto !important;");
  });
});

describe("PlanReview code highlighting (issue #319)", () => {
  const planFrame = (): HTMLIFrameElement | null =>
    document.body.querySelector<HTMLIFrameElement>('iframe[title="proposed plan"]');

  it("tokenizes a language-classed block in the guardrailed document", async () => {
    useStore.setState({
      rpc: {
        [TAB]: tabState({
          planText: null,
          planHtml:
            '<h1>Fix</h1><pre><code class="language-python">def f():\n    return 1</code></pre><p>plain block:</p><pre><code>no class stays plain</code></pre>',
        }),
      },
    });
    applyTheme(resolveTheme("graphite")); // pin the plane theme for this case
    render();

    const frame = planFrame()!;
    // The tokenizer is stubbed at the module seam (issue #329); real shiki is
    // covered by lib/plan-highlight.smoke.test.ts.
    await until(() => (frame.getAttribute("srcdoc") ?? "") !== "");
    const srcdoc = frame.getAttribute("srcdoc")!;
    expect(srcdoc).toContain('class="omp-ui-hl"');
    expect(srcdoc).toContain("tk-");
    expect(srcdoc).toContain('id="omp-ui-plan-guardrails"');
    // The code plane follows the pinned theme: Graphite's raised plane.
    expect(srcdoc).toContain("background-color: #1a1e23 !important");
    expect(srcdoc).toContain("color: #e8ecf1 !important");
    // Inline chips ride one step off the canvas, not the plane (issues #380,
    // #384): Graphite's hover tint.
    expect(srcdoc).toContain("background-color: #2a3037 !important");
    // The unclass'd block stays plain.
    expect(srcdoc).toContain("no class stays plain");
    expect(frame.getAttribute("sandbox")).toBe("");
  });
});

describe("PlanReview compact flow (issue #216)", () => {
  const step = (): HTMLElement => document.body.querySelector<HTMLElement>("[data-plan-review-step]")!;
  const planFrame = (): HTMLIFrameElement | null =>
    document.body.querySelector<HTMLIFrameElement>('iframe[title="proposed plan"]');

  beforeEach(() => {
    setCompact(true);
    // The compact surface reviews the HTML document, so the gate carries the
    // identity main validated and the preparation the guard reads is ready.
    planPrepared.state = {
      status: "ready",
      doc: "<h1>Fix</h1><p>long plan</p>",
      diagnostics: [],
      identity: SOURCE_HASH,
    };
    useStore.setState({
      rpc: { [TAB]: tabState({ planHtml: "<h1>Fix</h1><p>long plan</p>" }, true) },
    });
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
    // An HTML refine verdict travels through main's acknowledged answer —
    // never as a direct reply to the blocked select.
    expect(backendMock.answerPlanReview).toHaveBeenCalledWith(
      TAB,
      "p1",
      "refine",
      SOURCE_HASH,
    );
    expect(verdictFrame()).toBeUndefined();
    expect(promptFrame()?.message).toBe("Revise the plan to incorporate these requested changes:\n\nkeep the retry bounded");
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
    expect(backendMock.answerPlanReview).toHaveBeenCalledWith(
      TAB,
      "p1",
      "execute",
      SOURCE_HASH,
    );
    expect(verdictFrame()).toBeUndefined();
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
      useStore.setState({ rpc: { [TAB]: tabState({ planReview: { request: { title: "Revised", planFilePath: "local://revised-plan.html", planAbsPath: "/x/revised-plan.html" }, frame: { id: "p2" } }, planHtml: "<h1>Revised</h1>" }, true) } });
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
      rpc: { [TAB]: tabState({ planHtml: "<h1>Fix</h1>" }, true), "tab-2": tabState({ planReview: null, planText: null, status: "running" }) },
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
    expect(backendMock.answerPlanReview).not.toHaveBeenCalled();
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
    expect(backendMock.answerPlanReview).not.toHaveBeenCalled();
  });

});


describe("PlanReview html readiness gate (issue #312 follow-up)", () => {
  /** The same gate on the html artifact, reviewing a document surface. */
  const htmlGate = (): void => {
    useStore.setState({
      rpc: { [TAB]: tabState({ planText: "<h1>Fix</h1>", planHtml: "<h1>Fix</h1>" }, true) },
    });
  };

  const notReady: Array<{ label: string; state: PreparedPlanState }> = [
    { label: "a preparation that failed", state: { status: "failed", doc: null, diagnostics: [] } },
    {
      label: "a preparation that could not conclude",
      state: { status: "unavailable", doc: "<h1>Fix</h1>", diagnostics: [] },
    },
    {
      label: "a ready preparation of another source identity",
      state: {
        status: "ready",
        doc: "<h1>Fix</h1>",
        diagnostics: [],
        identity: "0".repeat(64),
      },
    },
  ];

  it.each(notReady)("keeps execute disabled for $label while refine stays live", async ({ state }) => {
    planPrepared.state = state;
    htmlGate();
    render();
    await act(async () => {});

    expect(executeButton().disabled).toBe(true);
    expect(buttonByText("refine").disabled).toBe(false);
    // A click that cannot land must not answer the gate either way.
    await act(async () => executeButton().click());
    expect(backendMock.answerPlanReview).not.toHaveBeenCalled();
    expect(verdictFrame()).toBeUndefined();
  });

  it("executes through main's acknowledged answer once the document is ready", async () => {
    planPrepared.state = {
      status: "ready",
      doc: "<h1>Fix</h1>",
      diagnostics: [],
      identity: SOURCE_HASH,
    };
    htmlGate();
    render();
    await act(async () => {});

    expect(executeButton().disabled).toBe(false);
    await act(async () => executeButton().click());
    // Settling takes the acknowledge round-trip, then the accepted answer's
    // own microtasks; the pane closes only once main has accepted.
    await act(async () => {});
    await act(async () => {});
    expect(useStore.getState().rpc[TAB]!.planReview).toBeNull();

    expect(backendMock.answerPlanReview).toHaveBeenCalledWith(
      TAB,
      "p1",
      "execute",
      SOURCE_HASH,
    );
    // The select reply is main's to send once it has accepted; this client
    // never answers the blocked frame itself.
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

describe("PlanReview dev/test advisor override (issue #372)", () => {
  const PIN = "p/advisor-a";
  const GATE = "gate/advisor-x:low";

  /** The standard seed with a saved advisor pin that conflicts with the gate. */
  function seedGated(gate: string | null = GATE, advisor = true): void {
    seed();
    useStore.setState((s) => ({
      state: {
        ...s.state!,
        projects: s.state!.projects.map((g) => ({
          ...g,
          sessions: g.sessions.map((session) =>
            session.tabId === TAB ? { ...session, advisor, advisorModel: PIN } : session,
          ),
        })),
        spawnGate: { model: null, advisorModel: gate },
      },
    }));
  }

  const executeAnyButton = (): HTMLButtonElement => {
    const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.startsWith("execute in"),
    );
    expect(found).toBeDefined();
    return found!;
  };

  it("shows the gate instead of the conflicting saved pin, read-only", async () => {
    seedGated();
    render();
    await until(() => document.body.textContent?.includes("advisor model") === true);

    const text = document.body.textContent ?? "";
    expect(text).toContain("This app instance overrides the advisor model with");
    expect(text).toContain(GATE);
    expect(text).toContain("dev/test");
    // Staging stays the record's choice — the display row carries the gate.
    const advisorRow = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.title?.startsWith("Dev/test advisor override") === true,
    )!;
    expect(advisorRow.disabled).toBe(true);
    await act(async () => {
      advisorRow.click();
    });
    // The advisor palette never opens from a gated row.
    expect(
      document.body.querySelector<HTMLButtonElement>(
        'button[title*="use omp\'s configured advisor"]',
      ),
    ).toBeNull();
  });

  it("worded as pending when the advisor is off", async () => {
    seedGated(GATE, false);
    render();
    await until(() => document.body.textContent?.includes("Advisor") === true);
    expect(document.body.textContent ?? "").toContain("When the advisor is enabled");
    expect(document.body.textContent ?? "").toContain(GATE);
  });

  it("a same-session execute never routes the gate through the advisor setter", async () => {
    seedGated();
    render();
    await act(async () => executeAnyButton().click());
    expect(verdictFrame()).toMatchObject({ id: "p1", value: "execute" });
    // The staged tuple equals the record's, so nothing relaunches the
    // advisor — and no call could carry the gate's selector anyway.
    expect(backendMock.setSessionAdvisor).not.toHaveBeenCalled();
    const rec = useStore
      .getState()
      .state!.projects[0]!.sessions.find((session) => session.tabId === TAB)!;
    expect(rec.advisorModel).toBe(PIN);
  });

  it("a fresh dispatch spawns with the saved selector, not the displayed gate", async () => {
    seedGated();
    render();
    await act(async () => {
      const row = [...document.body.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(
        (candidate) => candidate.textContent?.startsWith("fresh session"),
      )!;
      row.click();
    });
    await act(async () => executeAnyButton().click());
    expect(verdictFrame()).toMatchObject({ id: "p1", value: "execute" });
    // The zero-arg stub's typing hides the real request payload; retype it
    // once here — spawnSession's contract is SpawnRequest.
    const calls = backendMock.spawnSession.mock.calls as unknown as Array<
      [{ advisor: boolean; advisorModel: string | null }]
    >;
    const request = calls.at(-1)![0];
    expect(request.advisor).toBe(true);
    expect(request.advisorModel).toBe(PIN);
    expect(request.advisorModel).not.toBe(GATE);
  });

  it("compacted and worktree contexts submit the staged tuple too", async () => {
    const real = useStore.getState().executePlan;
    const spy = vi.fn();
    useStore.setState({ executePlan: spy });
    try {
      seedGated();
      render();
      await act(async () => {
        const row = [...document.body.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(
          (candidate) => candidate.textContent?.startsWith("this session, compacted"),
        )!;
        row.click();
      });
      await act(async () => executeAnyButton().click());
      expect(spy).toHaveBeenCalledWith(
        TAB,
        "compacted",
        expect.objectContaining({ advisor: true, advisorModel: PIN }),
      );

      spy.mockClear();
      await act(async () => {
        const row = [...document.body.querySelectorAll<HTMLButtonElement>("button[aria-pressed]")].find(
          (candidate) => candidate.textContent?.startsWith("worktree session"),
        )!;
        row.click();
      });
      await act(async () => executeAnyButton().click());
      expect(spy).toHaveBeenCalledWith(
        TAB,
        "worktree",
        expect.objectContaining({ advisor: true, advisorModel: PIN }),
      );
    } finally {
      useStore.setState({ executePlan: real });
    }
  });

  it("ungated rows keep the ordinary palette path", async () => {
    seedGated(null);
    useStore.setState({
      // Pin plus a configured advisor default plus a catalog holding both —
      // the same seed the ordinary staging test uses; the presence of the
      // entry also short-circuits the mount defaults fetch.
      advisorDefaults: { "/p": { enabled: true, model: "q/default" } },
      rpc: {
        [TAB]: tabState({
          availableModels: [
            { id: "advisor-a", name: "Advisor A", provider: "p" },
            { id: "default", name: "Default Advisor", provider: "q" },
          ],
        }),
      },
    });
    render();
    await until(() => document.body.textContent?.includes("advisor model") === true);
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("dev/test");
    expect(text).not.toContain("This app instance overrides");
    // The saved pin is what the row shows, and it opens the picker.
    expect(text).toContain("Advisor A");
    const advisorRow = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.title === PIN,
    );
    expect(advisorRow).toBeDefined();
    expect(advisorRow!.disabled).toBe(false);
    await act(async () => {
      advisorRow!.click();
    });
    const overlays = document.body.querySelectorAll<HTMLElement>("[data-overlay-root]");
    const palette = overlays[overlays.length - 1]!;
    expect(palette).toBeDefined();
    await act(async () => {
      palette.querySelector<HTMLButtonElement>('button[title="p"]')!.click();
    });
    expect(palette.textContent).toContain("use omp's configured advisor");
  });
});
