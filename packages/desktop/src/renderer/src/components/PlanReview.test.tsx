// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchList, SessionWorktree } from "@omp-ui/core/types";
import type { ThemedToken } from "shiki/core";
import type { PlanDiagnostic } from "@omp-ui/core/plan";
import type { PreparedPlanState } from "../lib/plan-document";
import type * as PreparedPlanHook from "../lib/use-prepared-plan-document";
import type { ParsedPlanSource } from "../lib/plan-source";
import type { CodeTokenizer } from "../lib/plan-highlight";
import type { Theme } from "../lib/themes";
import { backendState, remoteInstance, rpcTabState, tabInfo } from "../test/fixtures";

const clipboardImageMock = vi.hoisted(() => ({
  hasClipboardImage: vi.fn(() => false),
  hasClipboardDocument: vi.fn(() => false),
  readClipboardImages: vi.fn(),
  readClipboardDocuments: vi.fn(),
  readImageFiles: vi.fn(),
  readDocumentFiles: vi.fn(),
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

vi.mock("../lib/use-prepared-plan-document", async (importOriginal) => {
  const original = await importOriginal<typeof PreparedPlanHook>();
  return {
    usePreparedPlanDocument: (html: string | null, identity?: string, sourceKey?: string) => {
      const state = original.usePreparedPlanDocument(html, identity, sourceKey);
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
  // One coloured token per source line keeps authored text and token spans
  // observable without loading a grammar.
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
  mergeInProgress: false,
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
  remoteInstanceRequest: vi.fn(
    async (instanceId: string, channel: string, args: unknown[]): Promise<unknown> => {
      void instanceId;
      void channel;
      void args;
      return undefined;
    },
  ),
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
const { PlanReview } = await import("./PlanReview");

const TAB = "tab-1";
/** A gated HTML proposal carries the artifact's SHA-256 (64 lowercase hex). */
const SOURCE_HASH = "1f3c".repeat(16);
const SOURCE_KEY = "review:p1:read:1";

/**
 * The standard gate. `html` puts the proposal on an HTML artifact instead,
 * which is what switches on the document review, the readiness guard, and the
 * acknowledged answer (issue #312 follow-up).
 */
function tabState(patch: Parameters<typeof rpcTabState>[0] = {}, html = false) {
  const ext = html ? "html" : "md";
  return rpcTabState({
    status: "ready",
    // Skip the auto-title latch: an agent_end must not dispatch /rename in
    // the middle of a review case.
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
    planSourceKey: patch.planText === null && patch.planHtml == null ? null : SOURCE_KEY,
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
    planImplementationSource: null, experiment: null,
    agentMode: "build" as const,
    compactionMethod: null,
    approvalMode: null,
    serviceTier: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null, subagentModels: null,
 proposedPlans: [],
 autoTitled: false,
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
          browserClock: false,
          reviewRoster: null,
          knowledgeHome: null,
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
  clipboardImageMock.hasClipboardDocument.mockReset().mockReturnValue(false);
  clipboardImageMock.readClipboardImages.mockReset();
  clipboardImageMock.readClipboardDocuments.mockReset();
  clipboardImageMock.readImageFiles.mockReset().mockResolvedValue({ images: [], rejected: [] });
  clipboardImageMock.readDocumentFiles.mockReset().mockResolvedValue({
    documents: [],
    rejected: [],
  });
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
          mergeInProgress: false,
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
    expect(input.value).toMatch(/^p\/main\/[0-9a-f]{8}$/);
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
          mergeInProgress: false,
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
        branch: expect.stringMatching(/^p\/TECH-123\/[0-9a-f]{8}$/),
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
    expect(second).toMatch(/^p\/main\/[0-9a-f]{8}$/);
    expect(second).not.toBe(first);
  });

  it("routes the worktree fields to the owning remote instance (issue #488)", async () => {
    const INSTANCE = "inst-remote";
    const local = stateWithSessions({ "local-tab": "Local planning session" });
    const remoteProject = {
      ...local.projects[0]!,
      sessions: [{ ...sessionRecord(TAB, "Remote planning session"), worktree: null }],
    };
    // The joiner's local git has no such repo: emptyBranchList() shape
    // (packages/core/src/branches.ts).
    backendMock.listBranches.mockResolvedValue({
      ...branches,
      repoRoot: null,
      current: null,
      branches: [],
      defaultBranch: null,
    });
    backendMock.remoteInstanceRequest.mockImplementation(async (_id, channel) => {
      if (channel === "branch:list") return branches;
      if (channel === "advisor:defaults") return { enabled: false, model: null };
      return null;
    });
    useStore.setState({
      tabs: [tabInfo({ tabId: TAB, projectCwd: "/p", instanceId: INSTANCE })],
      advisorDefaults: {},
      branches: {},
      rpc: { [TAB]: tabState() },
      state: {
        ...local,
        remoteInstances: [remoteInstance({ id: INSTANCE, projects: [remoteProject] })],
      },
    });
    render();
    // The owning host's listing must land (via useExecutionBranch's mount
    // refresh) before the worktree context row unlocks.
    await act(async () => {});
    await act(async () => {});
    await act(async () => contextRow("worktree session").click());
    await act(async () => {});
    await act(async () => {});

    expect(backendMock.remoteInstanceRequest).toHaveBeenCalledWith(
      INSTANCE,
      "branch:list",
      ["/p", undefined],
    );
    const base = document.body.querySelector<HTMLSelectElement>("#plan-worktree-base")!;
    expect([...base.options].map((o) => o.textContent)).toContain("feature/y");
    expect(
      document.body.querySelector<HTMLInputElement>("#plan-worktree-branch")!.value,
    ).toMatch(/^p\/main\/[0-9a-f]{8}$/);
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

  // The mint is the session branch's durable name (issue #428): the plan's
  // name lands in the new base's field only — never typed text.
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

  it("keeps the mint hash while the plan names the base (issue #428)", async () => {
    backendMock.suggestBranchName.mockResolvedValue("fix/login-race");
    render();
    await act(async () => contextRow("worktree session").click());
    await act(async () => {});

    // The plan's name goes to the base fields and the finish dialog, never
    // into this field's hash tail.
    expect(branchInput().value).toMatch(/^p\/main\/[0-9a-f]{8}$/);
    expect(backendMock.suggestBranchName).toHaveBeenCalledTimes(1);
  });

  it("keeps the mint when the row is picked before the model answers (issue #428)", async () => {
    const { resolveSuggest } = deferredSuggestion();
    render();
    await act(async () => contextRow("worktree session").click());
    await act(async () => {});
    const minted = branchInput().value;
    expect(minted).toMatch(/^p\/main\/[0-9a-f]{8}$/);

    await act(async () => {
      resolveSuggest("fix/login-race");
    });

    // The late answer lands in the base fields only; the mint stands as the
    // session branch, byte-identical.
    expect(branchInput().value).toBe(minted);
    expect(branchInput().value).toMatch(/^p\/main\/[0-9a-f]{8}$/);
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
    expect(branchInput().value).toMatch(/^p\/fix-login-race\/[0-9a-f]{8}$/);

    await act(async () => {
      resolveSuggest("feat/x");
    });

    expect(newBaseInput().value).toBe("feat/x");
    // The branch keeps following its base, hash tail intact.
    expect(branchInput().value).toMatch(/^p\/feat\/x\/[0-9a-f]{8}$/);
  });

  it("prefills a resolved suggestion on reveal and keeps the mint hash (issue #428)", async () => {
    backendMock.suggestBranchName.mockResolvedValue("feat/x");
    render();
    await act(async () => contextRow("worktree session").click());
    await act(async () => {});
    // The untouched session branch is the mint, not the plan's name.
    expect(branchInput().value).toMatch(/^p\/main\/[0-9a-f]{8}$/);

    await revealNewBase();

    expect(newBaseInput().value).toBe("feat/x");
    // The mint follows its new base: the middle segment changes, the hash
    // tail stays (issue #405) — never `omp-ui/<base>/<base>`.
    expect(branchInput().value).toMatch(/^p\/feat\/x\/[0-9a-f]{8}$/);
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

    expect(branchInput().value).toMatch(/^p\/main\/[0-9a-f]{8}$/);
    await revealNewBase();
    expect(newBaseInput().value).toBe("fix-login-race");
  });

  it("dispatches the mint with no base to create (issue #428)", async () => {
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
      const mint = options.worktree.branch;
      expect(mint).toMatch(/^p\/main\/[0-9a-f]{8}$/);
      expect(options.worktree).toEqual({ branch: mint, baseRef: "main", baseBranch: null });
      expect(options.destination).toEqual({ kind: "worktree", branch: mint });
    } finally {
      useStore.setState({ executePlan: realExecutePlan });
    }
  });
});

describe("PlanReview dock controls (issue #277)", () => {
  it.each([false, true])("keeps the review workflow available in fill mode %s", (fill) => {
    render(fill);
    expect(host!.querySelector('[role="region"][aria-labelledby="plan-review-title"]')).not.toBeNull();
    expect(notesBox()).not.toBeNull();
    expect(buttonByText("refine").disabled).toBe(false);
    expect(buttonByText("not now").disabled).toBe(false);
    expect(executeButton().disabled).toBe(false);
  });
});

const IMAGE_ONE = { type: "image" as const, data: "one", mimeType: "image/png" };
const IMAGE_TWO = { type: "image" as const, data: "two", mimeType: "image/jpeg" };

describe("PlanReview refine attachment picker (issue #65)", () => {
  it("offers a paperclip that opens a multi-image picker", () => {
    render();
    const input = imagePicker();
    const button = document.body.querySelector<HTMLButtonElement>('button[title="attach files"]')!;
    const click = vi.spyOn(input, "click");

    expect(button).not.toBeNull();
    expect(input.accept).toBe("image/*,application/pdf");
    expect(input.multiple).toBe(true);
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
      images: [IMAGE_ONE],
    });
    expect((promptFrame()?.message as string).split("\n\n").at(-1)).toBe(
      "[omp-ui attachment routing: For tool calls, this prompt's attached image is available as attachment://1. Attachment handles restart at 1 for each prompt.]",
    );
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

  it("holds a keyword omp's settings switched off disabled, and never dispatches it", async () => {
    useStore.setState({
      rpc: {
        [TAB]: tabState({
          capabilities: {
            version: 1,
            processKey: "p",
            sessionId: null,
            revision: 1,
            updatedAt: 0,
            ompVersion: null,
            skillCommandsEnabled: null,
            skills: { status: "unavailable", reason: "missing-api" },
            tools: { status: "unavailable", reason: "missing-api" },
            magicKeywords: {
              status: "available",
              items: [
                { id: "ultrathink", word: "ultrathink", requires: [], enabled: true },
                { id: "orchestrate", word: "orchestrate", requires: ["task"], enabled: true },
                { id: "workflow", word: "workflowz", requires: ["task", "eval"], enabled: false },
                { id: "jevify", word: "jevify", requires: ["eval"], enabled: true },
              ],
            },
            toolControl: "unsupported",
            toolMutation: null,
          },
        }),
      },
    });
    render();
    const workflowSwitch = document.body.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="workflowz the implementation"]',
    )!;
    expect(workflowSwitch.disabled).toBe(true);
    expect(workflowSwitch.getAttribute("title")).toBe(
      "Off in omp's magicKeywords settings — omp would ignore it.",
    );
    // The switch is inert: clicking cannot arm it, and execute stays clean.
    await act(async () => {
      workflowSwitch.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });
    await act(async () => {
      executeButton().click();
      await Promise.resolve();
    });
    const message = String(promptFrame()!.message);
    expect(message).not.toContain("workflowz\n\n");
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

  it("uses the remote review's advisor defaults and favorites when paths collide (issue #440)", async () => {
    const INSTANCE = "inst-remote";
    const LOCAL_MAIN = { id: "local-main", name: "Local Main Favorite", provider: "p" };
    const LOCAL_ADVISOR = {
      id: "local-advisor",
      name: "Local Advisor Favorite",
      provider: "p",
    };
    const REMOTE_MAIN = { id: "remote-main", name: "Remote Main Favorite", provider: "p" };
    const REMOTE_ADVISOR = {
      id: "remote-advisor",
      name: "Remote Advisor Favorite",
      provider: "p",
    };
    const localDefaults = { enabled: true, model: "p/local-default" };
    const remoteDefaults = { enabled: true, model: "p/remote-default" };
    const local = stateWithSessions({ "local-tab": "Local planning session" });
    const remoteProject = {
      ...local.projects[0]!,
      sessions: [
        {
          ...sessionRecord(TAB, "Remote planning session"),
          worktree: null,
          model: "p/remote-main",
          advisor: true,
          advisorModel: "p/remote-advisor",
        },
      ],
    };
    backendMock.remoteInstanceRequest.mockImplementation(async (_instanceId, channel) => {
      if (channel === "advisor:defaults") return remoteDefaults;
      if (channel === "branch:list") return branches;
      return null;
    });
    useStore.setState({
      tabs: [tabInfo({ tabId: TAB, projectCwd: "/p", instanceId: INSTANCE })],
      branches: { "/p": branches, [`${INSTANCE}::/p`]: branches },
      state: {
        ...local,
        modelFavorites: ["p/local-main", "p/local-advisor"],
        remoteInstances: [
          remoteInstance({
            id: INSTANCE,
            projects: [remoteProject],
            modelFavorites: ["p/remote-main", "p/remote-advisor"],
          }),
        ],
      },
      advisorDefaults: { "/p": localDefaults },
      rpc: {
        [TAB]: tabState({
          model: REMOTE_MAIN,
          availableModels: [LOCAL_MAIN, LOCAL_ADVISOR, REMOTE_MAIN, REMOTE_ADVISOR],
        }),
      },
    });

    render();
    await act(async () => {});

    expect(backendMock.remoteInstanceRequest).toHaveBeenCalledWith(
      INSTANCE,
      "advisor:defaults",
      ["/p"],
    );
    expect(useStore.getState().advisorDefaults).toMatchObject({
      "/p": localDefaults,
      [`${INSTANCE}::/p`]: remoteDefaults,
    });

    await act(async () => buttonByText("Remote Main Favorite").click());
    const mainOverlays = document.body.querySelectorAll<HTMLElement>("[data-overlay-root]");
    const mainPalette = mainOverlays[mainOverlays.length - 1]!;
    expect(
      mainPalette
        .querySelector<HTMLButtonElement>('button[title="Favorites"]')!
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(mainPalette.textContent).toContain("Remote Main Favorite");
    expect(mainPalette.textContent).toContain("Remote Advisor Favorite");
    expect(mainPalette.textContent).not.toContain("Local Main Favorite");
    expect(mainPalette.textContent).not.toContain("Local Advisor Favorite");

    await act(async () => buttonContainingText("Remote Main Favorite", mainPalette).click());
    await act(async () => buttonByText("Remote Advisor Favorite").click());
    const advisorOverlays = document.body.querySelectorAll<HTMLElement>("[data-overlay-root]");
    const advisorPalette = advisorOverlays[advisorOverlays.length - 1]!;
    expect(
      advisorPalette
        .querySelector<HTMLButtonElement>('button[title="Favorites"]')!
        .getAttribute("aria-pressed"),
    ).toBe("true");
    expect(advisorPalette.textContent).toContain("Remote Main Favorite");
    expect(advisorPalette.textContent).toContain("Remote Advisor Favorite");
    expect(advisorPalette.textContent).not.toContain("Local Main Favorite");
    expect(advisorPalette.textContent).not.toContain("Local Advisor Favorite");
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

    // The document area names the wait instead of painting an empty frame
    // first (issue #652): the iframe is there when preparation reports a doc.
    await until(() => planFrame() !== null);
    const frame = planFrame()!;
    // The empty token list is the whole security story: no scripts, no
    // same-origin access, no forms, no popups, no navigation.
    expect(frame.getAttribute("sandbox")).toBe("");
    // Diagram substitution + guardrail injection resolve asynchronously.
    expect(frame.getAttribute("srcdoc")).toContain("<h1>Fix</h1><p>html-body</p>");
    // The document also carries its own restrictive policy, so the sandbox is
    // not the only thing keeping it inert.
    expect(frame.getAttribute("srcdoc")).toContain(
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

  it.each([
    { requested: "html", absolute: "md" },
    { requested: "md", absolute: "html" },
  ])("renders the requested $requested artifact when its absolute path ends in $absolute", async ({ requested, absolute }) => {
    const html = requested === "html";
    const source = html
      ? "<h1>Requested HTML document</h1><p>authored implementation</p>"
      : "# Requested Markdown document\n\nauthored implementation";
    const tab = tabState({ planText: source, planHtml: html ? source : null }, html);
    tab.planReview = {
      ...tab.planReview!,
      request: {
        ...tab.planReview!.request,
        planAbsPath: `/x/fix-login-race-plan.${absolute}`,
      },
    };
    useStore.setState({ rpc: { [TAB]: tab } });
    render();

    if (html) {
      await until(() => planFrame() !== null);
      const document = new DOMParser().parseFromString(planFrame()!.srcdoc, "text/html");
      expect(document.querySelector("h1")?.textContent).toBe("Requested HTML document");
      expect(document.body.textContent).toContain("authored implementation");
      expect(planFrame()!.getAttribute("sandbox")).toBe("");
    } else {
      expect(planFrame()).toBeNull();
      expect(document.body.textContent).toContain("Requested Markdown document");
      expect(document.body.textContent).toContain("authored implementation");
      expect(executeButton().disabled).toBe(false);
    }
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
    planPrepared.state = { status: "failed", sourceKey: SOURCE_KEY, doc: null, diagnostics };
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
  it("says the plan is being prepared instead of painting an empty iframe while it waits", async () => {
    // The blank white pane of issue #652: `pending` bound srcDoc="" and
    // Chromium painted an empty about:srcdoc the theme never reached.
    planPrepared.state = { status: "pending", sourceKey: SOURCE_KEY };
    useStore.setState({
      rpc: {
        [TAB]: tabState({ planText: "<h1>Fix</h1>", planHtml: "<h1>Fix</h1>" }, true),
      },
    });
    render();
    await act(async () => {});

    expect(planFrame()).toBeNull();
    expect(document.body.querySelector("iframe")).toBeNull();
    expect(document.body.textContent).toContain("preparing the plan");
    // Waiting is not a verdict: no diagnostic is claimed about the source,
    // and execute still waits for a ready preparation.
    expect(document.body.querySelector("pre[data-selectable]")).toBeNull();
    expect(document.body.textContent).not.toContain("could not be displayed");
    expect(executeButton().disabled).toBe(true);
    expect(buttonByText("refine").disabled).toBe(false);
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
    planPrepared.state = { status: "unavailable", sourceKey: SOURCE_KEY, doc: "<h1>Fix</h1>", diagnostics };
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
    const source = '<h1>Fix</h1><pre class="mermaid">flowchart TD; A--&gt;B</pre><p>after the diagram</p>';
    useStore.setState({
      rpc: { [TAB]: tabState({ planText: source, planHtml: source }, true) },
    });
    render();

    await until(() => planFrame() !== null);
    const frame = planFrame()!;
    const document = new DOMParser().parseFromString(frame.srcdoc, "text/html");
    expect(document.querySelectorAll("svg[data-diagram]")).toHaveLength(1);
    expect(document.querySelector("pre.mermaid")).toBeNull();
    expect(document.querySelector("p")?.textContent).toBe("after the diagram");
    expect(frame.getAttribute("sandbox")).toBe("");
  });
});

describe("PlanReview code highlighting (issue #319)", () => {
  const planFrame = (): HTMLIFrameElement | null =>
    document.body.querySelector<HTMLIFrameElement>('iframe[title="proposed plan"]');

  it("tokenizes a language-classed block without changing either block's authored text", async () => {
    const source = '<h1>Fix</h1><pre><code class="language-python">def f():\n    return 1</code></pre><p>plain block:</p><pre><code>no class stays plain</code></pre>';
    useStore.setState({
      rpc: { [TAB]: tabState({ planText: source, planHtml: source }, true) },
    });
    render();

    await until(() => planFrame() !== null);
    const frame = planFrame()!;
    const document = new DOMParser().parseFromString(frame.srcdoc, "text/html");
    const blocks = document.querySelectorAll("pre code");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.textContent).toBe("def f():\n    return 1");
    expect(blocks[0]!.querySelectorAll("span").length).toBeGreaterThan(0);
    expect(blocks[1]!.textContent).toBe("no class stays plain");
    expect(blocks[1]!.querySelector("span")).toBeNull();
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
      sourceKey: SOURCE_KEY,
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
    { label: "a preparation that failed", state: { status: "failed", sourceKey: SOURCE_KEY, doc: null, diagnostics: [] } },
    {
      label: "a preparation that could not conclude",
      state: { status: "unavailable", sourceKey: SOURCE_KEY, doc: "<h1>Fix</h1>", diagnostics: [] },
    },
    {
      label: "a ready preparation of another source identity",
      state: {
        status: "ready",
        doc: "<h1>Fix</h1>",
        diagnostics: [],
        identity: "0".repeat(64),
        sourceKey: SOURCE_KEY,
      },
    },
    {
      label: "a ready preparation of an older read with the same hash",
      state: {
        status: "ready", doc: "<h1>Old</h1>", diagnostics: [],
        identity: SOURCE_HASH, sourceKey: "review:p1:read:0",
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

  it("never stamps an old preparation with the newly loaded source key", async () => {
    planPrepared.state = {
      status: "ready", doc: "<h1>Old</h1>", diagnostics: [],
      identity: SOURCE_HASH, sourceKey: "review:p1:read:0",
    };
    htmlGate();
    render();
    await act(async () => {});
    expect(useStore.getState().rpc[TAB]!.planReadiness).toBeNull();
    expect(executeButton().disabled).toBe(true);

    planPrepared.state = {
      status: "ready", doc: "<h1>Current</h1>", diagnostics: [],
      identity: SOURCE_HASH, sourceKey: SOURCE_KEY,
    };
    act(() => root!.render(<PlanReview tabId={TAB} />));
    expect(useStore.getState().rpc[TAB]!.planReadiness).toMatchObject({
      status: "ready", sourceKey: SOURCE_KEY, identity: SOURCE_HASH,
    });
    expect(executeButton().disabled).toBe(false);
  });

  it("executes through main's acknowledged answer once the document is ready", async () => {
    planPrepared.state = {
      status: "ready",
      doc: "<h1>Fix</h1>",
      diagnostics: [],
      identity: SOURCE_HASH,
      sourceKey: SOURCE_KEY,
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

describe("PlanReview auto thinking staging", () => {
  const levelButton = (): HTMLButtonElement =>
    document.body.querySelector<HTMLButtonElement>(
      "button[title=\"the session's thinking level for the implementation\"]",
    )!;
  // The open popup lives beside its trigger inside the relative anchor; the
  // panel root itself carries `animate-rise`, so scope by the trigger.
  const ladderRows = (trigger: HTMLButtonElement): HTMLButtonElement[] =>
    [...trigger.closest("span.relative")!.querySelectorAll<HTMLButtonElement>("button")].slice(1);
  const seedModel = (sessionPatch: Record<string, unknown> = {}): void => {
    seed();
    useStore.setState((s) => ({
      rpc: {
        [TAB]: {
          ...s.rpc[TAB]!,
          model: {
            id: "m1",
            name: "Model M1",
            provider: "p",
            thinking: { efforts: ["low", "medium", "xhigh"] },
          },
          session: { ...s.rpc[TAB]!.session, ...sessionPatch },
        },
      },
    }));
  };

  it("seeds the staged level from the selector, not the resolved value", () => {
    seedModel({ thinkingLevel: "medium", thinkingConfigured: "auto" });
    render();
    expect(levelButton().textContent).toBe("auto");
  });

  it("offers auto above the ladder and stages it on click", () => {
    seedModel();
    render();
    act(() => levelButton().click());
    expect(ladderRows(levelButton()).map((row) => row.textContent?.trim())).toEqual([
      "auto",
      "low",
      "medium",
      "xhigh",
    ]);
    act(() => ladderRows(levelButton())[0]!.click());
    expect(levelButton().textContent).toBe("auto");
  });

  it("keeps the advisor menu free of an auto row — the advisor binds one selector at start", () => {
    seedModel();
    act(() =>
      useStore.setState((s) => ({
        state: {
          ...s.state!,
          projects: s.state!.projects.map((group) => ({
            ...group,
            sessions: group.sessions.map((session) =>
              session.tabId === TAB
                ? { ...session, advisor: true, advisorModel: "p/adv" }
                : session,
            ),
          })),
        },
        rpc: {
          [TAB]: {
            ...s.rpc[TAB]!,
            availableModels: [
              { id: "adv", name: "Adv", provider: "p", thinking: { efforts: ["low", "high"] } },
            ],
          },
        },
      })),
    );
    render();
    const advisorLevel = document.body.querySelector<HTMLButtonElement>(
      'button[title="the advisor\'s thinking level for the implementation"]',
    );
    expect(advisorLevel).not.toBeNull();
    act(() => advisorLevel!.click());
    expect(ladderRows(advisorLevel!).map((row) => row.textContent?.trim())).toEqual(["low", "high"]);
  });
});

describe("PlanReview live voice tray", () => {
  const actions = {
    explainPlanVoice: useStore.getState().explainPlanVoice,
    startLiveVoice: useStore.getState().startLiveVoice,
    stopLiveVoice: useStore.getState().stopLiveVoice,
    setLiveMuted: useStore.getState().setLiveMuted,
    listLiveHistory: useStore.getState().listLiveHistory,
    loadLiveRecording: useStore.getState().loadLiveRecording,
    playLiveRecording: useStore.getState().playLiveRecording,
  };
  const explain = vi.fn(async () => {});
  const start = vi.fn(async () => {});
  const stop = vi.fn(async () => {});
  const mute = vi.fn(async () => {});
  const play = vi.fn(async () => {});
  const history = vi.fn<typeof actions.listLiveHistory>(async () => []);
  const recording = vi.fn<typeof actions.loadLiveRecording>(async () => ({ status: "ready" }));
  const capabilities = (ompVersion: string | null) => ({
    version: 1 as const, processKey: "voice-process", sessionId: null,
    revision: 1, updatedAt: 0, ompVersion, skillCommandsEnabled: null,
    skills: { status: "unavailable" as const, reason: "missing-api" as const },
    tools: { status: "unavailable" as const, reason: "missing-api" as const },
    magicKeywords: { status: "unavailable" as const, reason: "missing-api" as const },
    toolControl: "unsupported" as const, toolMutation: null,
  });
  const live = (phase: "listening" | "muted" = "listening") => ({
    phase, levels: null, turns: [], ended: false, error: null, connectionId: "call:1",
  });
  const tray = (): HTMLElement | null =>
    document.body.querySelector('section[aria-label="Live voice"]');
  const accessibleButton = (label: string): HTMLButtonElement => {
    const button = document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(button).not.toBeNull();
    return button!;
  };
  const patch = (value: Parameters<typeof rpcTabState>[0]): void => {
    act(() => useStore.setState((s) => ({ rpc: { [TAB]: { ...s.rpc[TAB]!, ...value } } })));
  };

  beforeEach(() => {
    history.mockReset().mockResolvedValue([]);
    recording.mockReset().mockResolvedValue({ status: "ready" });
    useStore.setState({
      rpc: { [TAB]: tabState({
        capabilities: capabilities("18.5.1"),
        planVoice: { ready: true, busy: false, error: null },
      }) },
      exited: {}, liveVoice: {}, liveReplay: null,
      explainPlanVoice: explain, startLiveVoice: start, stopLiveVoice: stop,
      setLiveMuted: mute, listLiveHistory: history, loadLiveRecording: recording,
      playLiveRecording: play,
    });
  });

  afterEach(() => useStore.setState(actions));

  it.each([null, "18.5.0"])("hides the tray when the native version is %s", (version) => {
    patch({ capabilities: capabilities(version) });
    render();
    expect(tray()).toBeNull();
    expect(document.body.querySelector('button[aria-label="start live voice"]')).toBeNull();
    expect(buttonByText("refine").disabled).toBe(false);
  });

  it("offers an explicit microphone start and explanation without answering the human gate", async () => {
    render();
    expect(tray()).not.toBeNull();
    expect(accessibleButton("start live voice").disabled).toBe(false);
    const explanation = buttonByText("Start live voice and explain");
    expect(explanation.disabled).toBe(false);
    await act(async () => explanation.click());
    expect(explain).toHaveBeenCalledWith(TAB);
    expect(start).not.toHaveBeenCalled();
    expect(verdictFrame()).toBeUndefined();
    expect(backendMock.answerPlanReview).not.toHaveBeenCalled();
    expect(useStore.getState().rpc[TAB]!.planReview).not.toBeNull();
  });

  it("disables explanation and new starts during HTML preparation but keeps mute and stop accessible", async () => {
    planPrepared.state = { status: "pending", sourceKey: SOURCE_KEY };
    patch({
      planReview: tabState({}, true).planReview,
      planHtml: "<h1>Fix</h1>", live: live("muted"),
      planVoice: { ready: false, busy: false, error: null },
    });
    render();
    expect(tray()!.querySelector('[role="status"]')).not.toBeNull();
    expect(buttonByText("Explain this plan").disabled).toBe(true);
    expect(accessibleButton("unmute live voice").disabled).toBe(false);
    expect(accessibleButton("stop live voice").disabled).toBe(false);
    await act(async () => accessibleButton("unmute live voice").click());
    expect(mute).toHaveBeenCalledWith(TAB, false);
    await act(async () => accessibleButton("stop live voice").click());
    expect(stop).toHaveBeenCalledWith(TAB);
    expect(explain).not.toHaveBeenCalled();
    patch({ live: null });
    expect(accessibleButton("start live voice").disabled).toBe(true);
  });

  it("does not offer a loading HTML source as Markdown or enable either start path", () => {
    patch({
      planReview: tabState({}, true).planReview,
      planHtml: null, planText: null, planSourceKey: null,
      planVoice: { ready: false, busy: false, error: null },
    });
    render();
    expect(tray()!.querySelector('[role="status"]')).not.toBeNull();
    expect(executeButton().disabled).toBe(true);
    expect(buttonByText("Start live voice and explain").disabled).toBe(true);
    expect(document.body.querySelector('iframe[title="proposed plan"]')).toBeNull();
    expect(document.body.querySelector('pre[data-selectable]')).toBeNull();
  });

  it("keeps explanation available with the microphone muted and while armed/parked", async () => {
    patch({ live: live("muted") });
    render();
    expect(accessibleButton("unmute live voice").getAttribute("aria-pressed")).toBe("true");
    await act(async () => buttonByText("Explain this plan").click());
    expect(explain).toHaveBeenCalledWith(TAB);
    expect(mute).not.toHaveBeenCalled();
    patch({ live: null });
    act(() => useStore.setState({ liveVoice: { [TAB]: { armed: true, parked: true, pending: false } } }));
    expect(buttonByText("Explain this plan").disabled).toBe(false);
    expect(accessibleButton("stop live voice").disabled).toBe(false);
  });

  it("disables only starts and explanation during a context switch", () => {
    patch({ live: live(), planVoice: { ready: true, busy: true, error: null } });
    render();
    expect(buttonByText("Explain this plan").disabled).toBe(true);
    expect(accessibleButton("mute live voice").disabled).toBe(false);
    expect(accessibleButton("stop live voice").disabled).toBe(false);
    patch({ live: null });
    expect(accessibleButton("start live voice").disabled).toBe(true);
  });

  it.each(["projection cannot be read", "voice is owned by another view"])("shows the current refusal: %s", (error) => {
    patch({ planVoice: { ready: false, busy: false, error } });
    render();
    expect(tray()!.querySelector('[role="alert"]')?.textContent).toBe(error);
    expect(tray()!.querySelector('[role="status"]')).not.toBeNull();
    expect(buttonByText("Start live voice and explain").disabled).toBe(true);
  });

  it.each(["starting", "error"] as const)("disables explanation and voice controls for disconnected status %s", (status) => {
    patch({ status, live: live() });
    render();
    expect(buttonByText("Explain this plan").disabled).toBe(true);
    expect(accessibleButton("mute live voice").disabled).toBe(true);
    expect(accessibleButton("stop live voice").disabled).toBe(true);
  });

  it("respects an exited process and local dictation conflict", () => {
    render();
    act(() => root!.render(<PlanReview tabId={TAB} dictationActive />));
    expect(buttonByText("Start live voice and explain").disabled).toBe(true);
    expect(accessibleButton("start live voice").disabled).toBe(true);
    act(() => root!.render(<PlanReview tabId={TAB} />));
    expect(buttonByText("Start live voice and explain").disabled).toBe(false);
    act(() => useStore.setState({ exited: { [TAB]: 1 } }));
    expect(buttonByText("Start live voice and explain").disabled).toBe(true);
  });

  it("keeps voice available through compact review, refinement and implementation setup", async () => {
    setCompact(true);
    render();
    const initialTray = tray();
    expect(initialTray).not.toBeNull();
    await act(async () => buttonByText("refine").click());
    expect(tray()).toBe(initialTray);
    expect(notesBox()).not.toBeNull();
    await act(async () => buttonByText("back to plan").click());
    await act(async () => buttonByText("execute…").click());
    expect(tray()).toBe(initialTray);
    expect(document.body.querySelector('[aria-label="implementation setup"]')).not.toBeNull();
    expect(buttonByText("Start live voice and explain").disabled).toBe(false);
  });

  it("preserves prior exchanges, replay and command errors in the review strip", async () => {
    history.mockResolvedValue([{
      connectionId: "call:old", role: "assistant", turn: 1, text: "Earlier overview",
    }]);
    patch({ live: { ...live(), error: "command failed" } });
    render();
    await act(async () => {});
    expect(tray()!.textContent).toContain("Earlier overview");
    expect(tray()!.textContent).toContain("command failed");
    await act(async () => accessibleButton("play recording").click());
    expect(play).toHaveBeenCalledWith(TAB, expect.objectContaining({ connectionId: "call:old" }));
    await act(async () => accessibleButton("dismiss live voice message").click());
    expect(tray()!.textContent).not.toContain("command failed");
    expect(tray()!.textContent).toContain("Earlier overview");
  });
});
