// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RoutineCatalogSnapshot,
  RoutineDryRunResult,
  RoutineRecord,
  RoutineRunRow,
  RoutinesState,
} from "@omp-ui/core/routine";
import type { CatalogModelOption } from "@omp-ui/core/types";
import { backendState, remoteInstance } from "../../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const backendMock = {
  artifactList: vi.fn(async () => ({
    artifacts: [] as unknown[],
    nextCursor: null,
    libraryBytesUsed: 0,
    totalCount: 0,
    pendingReviewCount: 0,
    pendingReviewPreview: [],
    origins: [],
  })),
  artifactDescribe: vi.fn(),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic import: store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../../store");
const { RoutinesView } = await import("./RoutinesView");

const PROJECT = "/projects/one";
const CATALOG: RoutineCatalogSnapshot = {
  tools: [
    { key: "read", source: "builtin", group: "builtin", groupLabel: "Built-in tools", description: "Read files" },
    { key: "bash", source: "builtin", group: "builtin", groupLabel: "Built-in tools", description: "Run a shell" },
    { key: "mcp__gmail_list", source: "mcp", group: "mcp:gmail", groupLabel: "gmail", description: "" },
    { key: "mcp__gmail_send", source: "mcp", group: "mcp:gmail", groupLabel: "gmail", description: "" },
  ],
  staleServers: [],
  enumerationError: null,
  capturedAt: "2026-11-22T00:00:00.000Z",
};

function routine(patch: Partial<RoutineRecord> = {}): RoutineRecord {
  return {
    id: "a".repeat(22),
    name: "Morning overview",
    instructions: "Summarize my inbox.",
    schedule: { kind: "cron", expr: "0 8 * * 1-5" },
    timeZone: "UTC",
    destination: { projectCwd: PROJECT, workspace: "worktree" },
    mode: "build",
    model: null,
    thinkingLevel: null,
    spend: { warnUsd: null, maxUsd: null },
    // gmail_send was not in the catalog the user reviewed: drift.
    toolPolicy: { allow: ["read", "mcp__gmail_list"], deny: [], lastReviewedAt: "2026-11-01T00:00:00.000Z", reviewedCatalog: ["read", "bash", "mcp__gmail_list"] },
    scripts: { pre: "", post: "" },
    timeoutMinutes: null,
    notifications: { onStart: false, onComplete: false, onFail: false, onApproval: false, agentMessage: false },
    artifact: null,
    enabled: true,
    createdAt: "2026-11-01T00:00:00.000Z",
    nextRunAtMs: Date.UTC(2026, 10, 23, 8),
    lastRunAtMs: null,
    lastRunTabId: null,
    notices: [],
    ...patch,
  };
}

function run(patch: Partial<RoutineRunRow>): RoutineRunRow {
  return {
    id: `run-${patch.outcome ?? "on-time"}`,
    routineId: "a".repeat(22),
    routineName: "Morning overview",
    firedAtMs: Date.UTC(2026, 10, 21, 8),
    scheduledForMs: null,
    trigger: "clock",
    outcome: "on-time",
    tabId: null,
    reasonCode: null,
    missed: 0,
    pruned: false,
    staleCatalog: false,
    ...patch,
  };
}

function routinesState(patch: Partial<RoutinesState> = {}): RoutinesState {
  return {
    enabled: true,
    machineLabel: "work-laptop",
    routines: [routine()],
    runs: [],
    activeRunTabId: null,
    defaultWarnCostUsd: 2,
    defaultMaxCostUsd: 5,
    ...patch,
  };
}

const runRoutineNow = vi.fn();
const dryRunRoutine = vi.fn();
const loadRoutineToolCatalog = vi.fn(async () => CATALOG);
const readChatModels = vi.fn(async () => ({ models: [] as CatalogModelOption[], discovered: true, error: null }));
const closeRoutines = vi.fn();
let root: Root | null = null;

function render(): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<RoutinesView />));
  return host;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function buttonNamed(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no "${label}" button`);
  return found as HTMLButtonElement;
}

function routineTab(tab: "config" | "policy" | "history"): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>(`[data-routine-tab="${tab}"]`);
  if (!found) throw new Error(`no routine tab "${tab}"`);
  return found;
}

/** Wide-mode drill-down: row click opens the drawer, Edit opens the full editor. */
async function openEditor(id = "a".repeat(22)): Promise<void> {
  act(() => document.querySelector<HTMLElement>(`[data-routine-row="${id}"]`)!.click());
  await settle();
  await act(async () => buttonNamed("Edit full routine →").click());
  await settle();
}

beforeEach(() => {
  // Wide shell: split list + editor.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  useStore.setState({
    state: backendState({
      routinesEnabled: true,
      projects: [
        {
          project: {
            path: PROJECT,
            name: "Project One",
            addedAt: "t",
            lastModel: null,
            lastThinkingLevel: null,
            lastAdvisor: null,
            lastAdvisorModel: null,
            defaultModel: null,
            defaultAdvisorModel: null,
            browserClock: false,
            councilRoster: null,
            knowledgeHome: null,
            repositoryKey: null,
            icon: null,
          },
          sessions: [],
        },
      ],
    }),
    routinesState: routinesState(),
    routinesOpen: true,
    sidebarCollapsed: false,
    closeRoutines,
    runRoutineNow,
    dryRunRoutine,
    loadRoutineToolCatalog,
    readChatModels,
  });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("RoutinesView (ADR-0100, issue #1261)", () => {
  it("names the serving host in the header", async () => {
    const host = render();
    await settle();
    expect(host.querySelector("header")?.textContent).toContain("work-laptop");
  });

  it("lists each routine with its schedule and last outcome", async () => {
    useStore.setState({ routinesState: routinesState({ runs: [run({ outcome: "skipped", reasonCode: "host-lane-busy" })] }) });
    const host = render();
    await settle();
    const row = host.querySelector(`[data-routine-row="${"a".repeat(22)}"]`)!;
    expect(row.textContent).toContain("Morning overview");
    expect(row.textContent).toContain("Weekdays at 08:00");
    expect(row.textContent).toContain("Skipped");
    expect(row.textContent).toContain("Another routine was running");
  });

  it("shows main's Run now refusal verbatim and starts nothing", async () => {
    runRoutineNow.mockRejectedValueOnce(
      new Error("Error invoking remote method 'routines:runNow': Error: Another routine is running — try again in a moment"),
    );
    render();
    await settle();
    await openEditor();
    await act(async () => buttonNamed("Run now").click());
    await settle();
    expect(runRoutineNow).toHaveBeenCalledWith("a".repeat(22), null);
    expect(document.querySelector("[data-routine-action-error]")?.textContent).toBe(
      "Another routine is running — try again in a moment",
    );
  });

  it("previews the saved routine's compiled policy on Dry run", async () => {
    const result: RoutineDryRunResult = {
      routineId: "a".repeat(22),
      nextFireAtMs: Date.UTC(2026, 10, 23, 8),
      compiled: {
        approvalMode: "always-ask",
        overlayEntries: { bash: "deny", mcp__gmail_list: "allow", mcp__gmail_send: "prompt", read: "allow" },
        deniedBuiltins: ["bash"],
        addedLater: ["mcp__gmail_send"],
        missingFromCatalog: [],
        cliBypassToolsAllowed: [],
        cliBypassWarning: false,
        overlayYamlPreview: "tools:\n",
        warnings: [],
      },
      warnCostUsd: 2,
      maxCostUsd: 5,
      staleServers: [],
      enumerationError: null,
      scripts: { pre: "", post: "" },
      timeoutMinutes: 30,
      notifications: { onStart: false, onComplete: false, onFail: false, onApproval: false, agentMessage: false },
    };
    dryRunRoutine.mockResolvedValueOnce(result);
    render();
    await settle();
    await openEditor();
    await act(async () => buttonNamed("Dry run").click());
    await settle();
    expect(dryRunRoutine).toHaveBeenCalledWith({ kind: "saved", id: "a".repeat(22) }, null);
    const panel = document.querySelector("[data-dry-run]")!.parentElement!;
    expect(panel.textContent).toContain("Auto-allowed (2)");
    expect(panel.textContent).toContain("Will pause on Approval card (1)");
    expect(panel.textContent).toContain("Hard denied (1)");
    expect(panel.textContent).toContain("Added after last review: mcp__gmail_send");
  });

  it("marks a tool added since the review, and warns when a shell is allowed", async () => {
    render();
    await settle();
    await openEditor();
    act(() => routineTab("policy").click());
    const sendRow = document.querySelector('[data-tool-row="mcp__gmail_send"]')!;
    expect(sendRow.textContent).toContain("Added later · not allowed");
    expect(document.querySelector('[data-tool-row="read"]')!.textContent).not.toContain("Added later");
    expect(document.body.textContent).not.toContain("A shell reaches any service");
    const bash = document.querySelector<HTMLInputElement>('[data-tool-row="bash"] input[type="checkbox"]')!;
    act(() => bash.click());
    expect(document.body.textContent).toContain("A shell reaches any service without asking");
  });

  it("lists run history outcomes with their fixed reasons and pruned runs without a session link", async () => {
    useStore.setState({
      routinesState: routinesState({
        runs: [
          run({ id: "r1", outcome: "skipped", reasonCode: "overlap", firedAtMs: 4 }),
          run({ id: "r2", outcome: "failed", reasonCode: "cost-cap", tabId: "gone", firedAtMs: 3 }),
          run({ id: "r3", outcome: "failed", reasonCode: "wall-clock", firedAtMs: 2 }),
          run({ id: "r4", outcome: "on-time", tabId: "old", pruned: true, firedAtMs: 1 }),
        ],
      }),
    });
    render();
    await settle();
    await openEditor();
    act(() => routineTab("history").click());
    const history = document.querySelector("[data-run-history]")!;
    expect(history.textContent).toContain("Previous run still open");
    expect(history.textContent).toContain("Stopped at spend cap");
    expect(history.textContent).toContain("Timed out (wall-clock limit reached)");
    expect(history.textContent).toContain("pruned");
    expect([...history.querySelectorAll("button")]).toHaveLength(0);
  });

  it("starts a new routine from the default allow set the project offers", async () => {
    useStore.setState({ routinesState: routinesState({ routines: [] }) });
    render();
    await settle();
    expect(document.body.textContent).toContain("No routines on this host");
    act(() => buttonNamed("New routine").click());
    await settle();
    expect(loadRoutineToolCatalog).toHaveBeenCalledWith(PROJECT, null);
    // Run history tab is hidden for an unsaved routine.
    expect(document.querySelector('[data-routine-tab="history"]')).toBeNull();
    act(() => routineTab("policy").click());
    const read = document.querySelector<HTMLInputElement>('[data-tool-row="read"] input[type="checkbox"]')!;
    const send = document.querySelector<HTMLInputElement>('[data-tool-row="mcp__gmail_send"] input[type="checkbox"]')!;
    expect(read.checked).toBe(true);
    expect(send.checked).toBe(false);
    // Nothing reviewed yet: no drift chips on a new routine.
    expect(document.body.textContent).not.toContain("Added later · not allowed");
  });

  it("shows Dry run preview from any active tab", async () => {
    const result: RoutineDryRunResult = {
      routineId: "a".repeat(22),
      nextFireAtMs: Date.UTC(2026, 10, 23, 8),
      compiled: {
        approvalMode: "always-ask",
        overlayEntries: { read: "allow" },
        deniedBuiltins: [],
        addedLater: [],
        missingFromCatalog: [],
        cliBypassToolsAllowed: [],
        cliBypassWarning: false,
        overlayYamlPreview: "tools:\n",
        warnings: [],
      },
      warnCostUsd: 2,
      maxCostUsd: 5,
      staleServers: [],
      enumerationError: null,
      scripts: { pre: "", post: "" },
      timeoutMinutes: 30,
      notifications: { onStart: false, onComplete: false, onFail: false, onApproval: false, agentMessage: false },
    };
    dryRunRoutine.mockResolvedValueOnce(result);
    render();
    await settle();
    await openEditor();
    act(() => routineTab("policy").click());
    await act(async () => buttonNamed("Dry run").click());
    await settle();
    expect(document.querySelector("[data-dry-run]")).not.toBeNull();
    expect(routineTab("policy").getAttribute("aria-selected")).toBe("true");
  });

  it("opens ModelPalette, picks a reasoning model with catalog-only thinking, and clears incompatible thinking on switch", async () => {
    HTMLElement.prototype.scrollIntoView = vi.fn();
    readChatModels.mockResolvedValueOnce({
      models: [
        {
          provider: "anthropic",
          id: "claude-opus",
          name: "Claude Opus",
          reasoning: true,
          thinking: { efforts: ["low", "medium", "high"] },
        },
        {
          provider: "openai",
          id: "gpt-plain",
          name: "GPT Plain",
          reasoning: false,
        },
      ],
      discovered: true,
      error: null,
    });
    const updateRoutine = vi.fn(async (_id: string, patch: unknown) => ({ ...routine(), ...(patch as Partial<RoutineRecord>) }));
    useStore.setState({ updateRoutine });
    render();
    await settle();
    await openEditor();

    // Unpinned project with draft.model === null hides the thinking slider (no fallback ladder).
    expect(document.querySelector("[data-thinking-track]")).toBeNull();
    expect(document.body.textContent).toContain("Follows project default");

    // Open ModelPalette and select Claude Opus (reasoning).
    const modelBtn = document.querySelector<HTMLButtonElement>('button[aria-label="Model"]')!;
    act(() => modelBtn.click());
    const anthropicTab = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => b.title === "anthropic",
    )!;
    act(() => anthropicTab.click());
    const opusBtn = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => b.textContent?.includes("Claude Opus"),
    )!;
    act(() => opusBtn.click());

    // Catalog-reported efforts appear on ThinkingSliderControl.
    expect(document.querySelector("[data-thinking-track]")).not.toBeNull();
    const autoSwitch = document.querySelector<HTMLButtonElement>('button[role="switch"][aria-label="auto"]')!;
    act(() => autoSwitch.click());
    expect(autoSwitch.getAttribute("aria-checked")).toBe("true");

    // Clicking a specific effort pins it and disables auto.
    act(() => buttonNamed("high").click());
    expect(autoSwitch.getAttribute("aria-checked")).toBe("false");
    expect(buttonNamed("high").getAttribute("aria-pressed")).toBe("true");

    // Switch to a non-reasoning model: slider hides and thinking clears to null.
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Model"]')!.click());
    const openaiTab = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => b.title === "openai",
    )!;
    act(() => openaiTab.click());
    const plainBtn = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => b.textContent?.includes("GPT Plain"),
    )!;
    act(() => plainBtn.click());
    expect(document.querySelector("[data-thinking-track]")).toBeNull();
    expect(document.body.textContent).toContain("Not supported by model");

    // Save sends model: "openai/gpt-plain" and thinkingLevel: null.
    await act(async () => buttonNamed("Save routine").click());
    await settle();
    expect(updateRoutine).toHaveBeenCalledWith(
      "a".repeat(22),
      expect.objectContaining({ model: "openai/gpt-plain", thinkingLevel: null }),
      null,
    );

    // Saving returns to the gallery with the drawer open; drill back in.
    expect(document.querySelector("[data-routine-inspector]")).not.toBeNull();
    await openEditor();

    // Pick Project default from the palette and verify model returns to null.
    act(() => document.querySelector<HTMLButtonElement>('button[aria-label="Model"]')!.click());
    const projDefaultBtn = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (b) => b.textContent?.includes("Project default"),
    )!;
    act(() => projDefaultBtn.click());
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Model"]')!.textContent).toContain("Project default");
  });
});

describe("RoutinesView review-link focus (ADR-0100 amendment)", () => {
  it("picks the routine a transcript review link asked for and consumes the request", async () => {
    const second = routine({ id: "b".repeat(22), name: "Gmail triage" });
    useStore.setState({ routinesState: routinesState({ routines: [routine(), second] }), routineFocusId: second.id });
    const host = render();
    await settle();
    // The focus request opens the drawer over the gallery for that routine.
    expect(host.querySelector("[data-routine-inspector]")?.textContent).toContain("Gmail triage");
    expect(useStore.getState().routineFocusId).toBeNull();
  });

  it("clears a focus request for a routine that no longer exists", async () => {
    useStore.setState({ routinesState: routinesState(), routineFocusId: "g".repeat(22) });
    render();
    await settle();
    expect(useStore.getState().routineFocusId).toBeNull();
  });
});

describe("RoutinesView inspector drawer", () => {
  it("row click opens the drawer, Escape closes it, and the switch toggles via updateRoutine", async () => {
    const updateRoutine = vi.fn(async (_id: string, patch: unknown) => ({ ...routine(), ...(patch as Partial<RoutineRecord>) }));
    useStore.setState({ updateRoutine });
    const host = render();
    await settle();
    expect(host.querySelector("[data-routine-inspector]")).toBeNull();

    act(() => document.querySelector<HTMLElement>(`[data-routine-row="${"a".repeat(22)}"]`)!.click());
    await settle();
    const drawer = host.querySelector("[data-routine-inspector]")!;
    expect(drawer.textContent).toContain("Morning overview");
    expect(drawer.textContent).toContain("Weekdays at 08:00");

    // The switch inside the drawer routes through updateRoutine.
    const toggle = drawer.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    act(() => toggle.click());
    expect(updateRoutine).toHaveBeenCalledWith("a".repeat(22), { enabled: false }, null);

    // Escape closes the drawer.
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await settle();
    expect(host.querySelector("[data-routine-inspector]")).toBeNull();
  });

  it("Edit full routine drills to the editor and ← All routines reopens the drawer", async () => {
    const host = render();
    await settle();
    await openEditor();
    expect(host.querySelector("[data-routine-editor]")).not.toBeNull();
    expect(host.querySelector("[data-routine-inspector]")).toBeNull();

    await act(async () => buttonNamed("← All routines").click());
    await settle();
    expect(host.querySelector("[data-routine-editor]")).toBeNull();
    expect(host.querySelector("[data-routine-inspector]")?.getAttribute("data-routine-inspector")).toBe(
      "a".repeat(22),
    );
  });

  it("a waiting-approval run raises the attention strip and its button inspects that routine", async () => {
    const second = routine({ id: "b".repeat(22), name: "Gmail triage" });
    useStore.setState({
      routinesState: routinesState({
        routines: [routine(), second],
        runs: [run({ routineId: second.id, outcome: "waiting-approval" })],
      }),
    });
    const host = render();
    await settle();
    const strip = host.querySelector("[data-routines-attention-strip]")!;
    expect(strip.textContent).toContain("1 run waiting on an Approval card");
    const jump = [...strip.querySelectorAll("button")].find((b) => b.textContent?.includes("Gmail triage"))!;
    await act(async () => jump.click());
    await settle();
    expect(host.querySelector("[data-routine-inspector]")?.getAttribute("data-routine-inspector")).toBe(
      "b".repeat(22),
    );
  });

  it("search and filter pills narrow the table", async () => {
    const second = routine({ id: "b".repeat(22), name: "Gmail triage", enabled: false });
    useStore.setState({ routinesState: routinesState({ routines: [routine(), second] }) });
    const host = render();
    await settle();
    expect(host.querySelectorAll("[data-routine-row]")).toHaveLength(2);

    act(() => {
      const search = host.querySelector<HTMLInputElement>('input[type="search"]')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(search, "triage");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Search is debounced 150 ms; wait a real beat past it.
    const { promise: beat, resolve: done } = Promise.withResolvers<void>();
    setTimeout(done, 220);
    await act(async () => beat);
    await settle();
    expect(host.querySelectorAll("[data-routine-row]")).toHaveLength(1);
    expect(host.querySelector("[data-routine-row]")?.textContent).toContain("Gmail triage");
  });
});

describe("RoutinesView run hooks (#1283)", () => {
  function textareaByLabel(label: string): HTMLTextAreaElement {
    const found = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`);
    if (!found) throw new Error(`no textarea "${label}"`);
    return found;
  }

  function typeInto(el: HTMLTextAreaElement | HTMLInputElement, value: string): void {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(proto.prototype, "value")!.set!;
    act(() => {
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("hydrates both saved hooks and preserves them through an unrelated edit + save", async () => {
    const saved = routine({ scripts: { pre: "git fetch --all", post: "notify-done" } });
    useStore.setState({ routinesState: routinesState({ routines: [saved] }), routineFocusId: saved.id });
    const updateRoutine = vi.fn(async (_id: string, patch: unknown) => ({ ...saved, ...(patch as Partial<RoutineRecord>) }));
    useStore.setState({ updateRoutine });
    render();
    await settle();
    await openEditor(saved.id);

    expect(textareaByLabel("Run shell before starting").value).toBe("git fetch --all");
    expect(textareaByLabel("Run shell after the run ends").value).toBe("notify-done");

    // An unrelated edit (name) then save: both hooks must survive verbatim.
    typeInto(document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!, "Renamed");
    await act(async () => buttonNamed("Save routine").click());
    await settle();
    expect(updateRoutine).toHaveBeenCalledWith(
      saved.id,
      expect.objectContaining({ name: "Renamed", scripts: { pre: "git fetch --all", post: "notify-done" } }),
      null,
    );
  });

  it("the copper hook warning replaces the green safe box when only a hook is set", async () => {
    const saved = routine({ scripts: { pre: "", post: "echo done" } });
    useStore.setState({ routinesState: routinesState({ routines: [saved] }), routineFocusId: saved.id });
    render();
    await settle();
    await openEditor(saved.id);
    expect(document.body.textContent).toContain("Run hooks execute as you, unattended");
    expect(document.body.textContent).not.toContain("No shell tool allowed");
  });

  it("Dry run lists a post-only routine's hook and never the empty pre phase", async () => {
    const saved = routine({ scripts: { pre: "", post: "npm test" } });
    useStore.setState({ routinesState: routinesState({ routines: [saved] }), routineFocusId: saved.id });
    dryRunRoutine.mockResolvedValueOnce({
      routineId: saved.id,
      nextFireAtMs: null,
      compiled: {
        approvalMode: "always-ask",
        overlayEntries: { read: "allow" },
        deniedBuiltins: [],
        addedLater: [],
        missingFromCatalog: [],
        cliBypassToolsAllowed: [],
        cliBypassWarning: false,
        overlayYamlPreview: "tools:\n",
        warnings: [],
      },
      warnCostUsd: 2,
      maxCostUsd: 5,
      staleServers: [],
      enumerationError: null,
      scripts: { pre: "", post: "npm test" },
      timeoutMinutes: 30,
      notifications: { onStart: false, onComplete: false, onFail: false, onApproval: false, agentMessage: false },
    });
    render();
    await settle();
    await openEditor(saved.id);
    await act(async () => buttonNamed("Dry run").click());
    await settle();
    expect(document.querySelector("[data-dry-run-hook='post']")?.textContent).toContain("npm test");
    expect(document.querySelector("[data-dry-run-hook='pre']")).toBeNull();
  });

  it("Run now on a pre-skip (empty tabId) shows the neutral line, not a failure", async () => {
    const saved = routine({ scripts: { pre: "exit 78", post: "" } });
    useStore.setState({ routinesState: routinesState({ routines: [saved] }), routineFocusId: saved.id });
    runRoutineNow.mockResolvedValueOnce({ tabId: "", runId: "run-x" });
    render();
    await settle();
    await openEditor(saved.id);
    await act(async () => buttonNamed("Run now").click());
    await settle();
    expect(document.querySelector("[data-routine-skipped-now]")?.textContent).toContain("Nothing to do");
    expect(document.querySelector("[data-routine-action-error]")).toBeNull();
  });
});

describe("RoutinesView Variant B layout and Flight check (#1284)", () => {
  it("closes Routines from the header ← Sessions button and renders on studio-stage", async () => {
    const host = render();
    await settle();
    const view = host.querySelector("[data-routines-view]")!;
    expect(view.classList.contains("studio-stage")).toBe(true);
    expect(view.classList.contains("stage-void")).toBe(false);

    // The routines-specific inner sidebar is gone: the gallery fills the pane.
    expect(host.querySelector("[data-routines-sidebar]")).toBeNull();
    const header = host.querySelector("header")!;
    expect(header.textContent).toContain("Routines on work-laptop");
    const backButton = [...header.querySelectorAll("button")].find((b) => b.textContent?.includes("Sessions"));
    expect(backButton).toBeDefined();
    await act(async () => backButton!.click());
    expect(closeRoutines).toHaveBeenCalledTimes(1);
  });

  it("keeps the header host label and return path while sidebarCollapsed is true", async () => {
    useStore.setState({ sidebarCollapsed: true });
    const host = render();
    await settle();
    const header = host.querySelector("header")!;
    expect(header.textContent).toContain("Routines on work-laptop");
    const backButton = [...header.querySelectorAll("button")].find((b) => b.textContent?.includes("Sessions"));
    expect(backButton).toBeDefined();
    await act(async () => backButton!.click());
    expect(closeRoutines).toHaveBeenCalledTimes(1);
  });

  it("keeps the host-named header and ← Sessions return path in the empty state", async () => {
    useStore.setState({ routinesState: routinesState({ routines: [] }) });
    const host = render();
    await settle();
    expect(host.textContent).toContain("No routines on this host");
    const header = host.querySelector("header")!;
    expect(header.textContent).toContain("Routines on work-laptop");
    const backButton = [...header.querySelectorAll("button")].find((b) => b.textContent?.includes("Sessions"));
    expect(backButton).toBeDefined();
    await act(async () => backButton!.click());
    expect(closeRoutines).toHaveBeenCalledTimes(1);
  });

  it("renders the integrated Flight check bar in Configuration and links to Tool policy", async () => {
    const host = render();
    await settle();
    await openEditor();
    expect(host.querySelector('aside[aria-label="Flight check"]')).toBeNull();

    const bar = host.querySelector('[aria-label="Flight check"]')!;
    expect(bar).not.toBeNull();
    expect(bar.textContent).toContain("Policy enforced");
    expect(bar.textContent).not.toContain("Shell bypass enabled");

    const reviewButton = [...bar.querySelectorAll("button")].find((b) => b.textContent?.includes("Review all tools"));
    expect(reviewButton).toBeDefined();
    await act(async () => reviewButton!.click());
    expect(routineTab("policy").getAttribute("aria-selected")).toBe("true");
  });

  it("switches the Flight check chip to Shell bypass enabled when bash is allowed", async () => {
    const withBash = routine({
      toolPolicy: {
        allow: ["read", "bash"],
        deny: [],
        lastReviewedAt: "2026-11-01T00:00:00.000Z",
        reviewedCatalog: ["read", "bash", "mcp__gmail_list"],
      },
    });
    useStore.setState({ routinesState: routinesState({ routines: [withBash] }) });
    const host = render();
    await settle();
    await openEditor();
    const bar = host.querySelector('[aria-label="Flight check"]')!;
    expect(bar.textContent).toContain("Shell bypass enabled");
    expect(bar.textContent).not.toContain("Policy enforced");
  });

  it("opens the new-routine editor from the filter bar New routine button", async () => {
    useStore.setState({ routinesState: routinesState({ routines: [] }) });
    const host = render();
    await settle();
    expect(host.querySelector("[data-routine-editor]")).toBeNull();

    await act(async () => buttonNamed("New routine").click());
    await settle();
    expect(host.querySelector("[data-routine-editor]")).not.toBeNull();
  });
});

describe("RoutinesView configurable timeout (#1290)", () => {
  function typeInto(el: HTMLInputElement, value: string): void {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function timeoutInput(): HTMLInputElement | null {
    return document.querySelector<HTMLInputElement>('input[aria-label="Run timeout (minutes)"]');
  }

  it("defaults to 30 min in Flight check, saves custom minutes, switches to Unlimited, and resets back to Limit", async () => {
    let current = routine();
    const updateRoutine = vi.fn(async (_id: string, patch: unknown) => {
      current = { ...current, ...(patch as Partial<RoutineRecord>) };
      useStore.setState({ routinesState: routinesState({ routines: [current] }) });
      return current;
    });
    useStore.setState({ updateRoutine });
    render();
    await settle();
    await openEditor();

    expect(document.querySelector("[data-flight-timeout]")?.textContent).toBe("30 min");
    expect(timeoutInput()?.value).toBe("");

    // Enter 90 minutes -> formats as 1 h 30 min and saves timeoutMinutes: 90.
    typeInto(timeoutInput()!, "90");
    expect(document.querySelector("[data-flight-timeout]")?.textContent).toBe("1 h 30 min");
    await act(async () => buttonNamed("Save routine").click());
    await settle();
    expect(updateRoutine).toHaveBeenLastCalledWith(current.id, expect.objectContaining({ timeoutMinutes: 90 }), null);

    // Save returns to the gallery with the drawer open; drill back in for the next edit.
    await openEditor();

    // Switch to Unlimited -> Flight check shows Unlimited, lane warning appears, saves timeoutMinutes: 0.
    act(() => buttonNamed("Unlimited").click());
    expect(document.querySelector("[data-flight-timeout]")?.textContent).toBe("Unlimited");
    expect(timeoutInput()).toBeNull();
    expect(document.body.textContent).toContain("No wall-clock limit");
    await act(async () => buttonNamed("Save routine").click());
    await settle();
    expect(updateRoutine).toHaveBeenLastCalledWith(current.id, expect.objectContaining({ timeoutMinutes: 0 }), null);

    await openEditor();

    // Switch back to Limit -> resets to default (timeoutMinutes: null).
    act(() => buttonNamed("Limit").click());
    expect(document.querySelector("[data-flight-timeout]")?.textContent).toBe("30 min");
    expect(timeoutInput()?.value).toBe("");
    await act(async () => buttonNamed("Save routine").click());
    await settle();
    expect(updateRoutine).toHaveBeenLastCalledWith(current.id, expect.objectContaining({ timeoutMinutes: null }), null);
  });

  it("surfaces validation error and disables Save for invalid timeout values", async () => {
    render();
    await settle();
    await openEditor();

    for (const bad of ["-5", "1.5", "1441"]) {
      typeInto(timeoutInput()!, bad);
      expect(document.body.textContent).toContain("Run timeout is blank (30 min default)");
      expect(buttonNamed("Save routine").disabled).toBe(true);
    }

    // Whole hours format cleanly and re-enable Save.
    typeInto(timeoutInput()!, "120");
    expect(document.querySelector("[data-flight-timeout]")?.textContent).toBe("2 h");
    expect(buttonNamed("Save routine").disabled).toBe(false);
  });

  it("renders resolved timeout (custom and Unlimited) in Dry run summary", async () => {
    const baseDryRun: RoutineDryRunResult = {
      routineId: "a".repeat(22),
      nextFireAtMs: Date.UTC(2026, 10, 23, 8),
      compiled: {
        approvalMode: "always-ask",
        overlayEntries: { read: "allow" },
        deniedBuiltins: [],
        addedLater: [],
        missingFromCatalog: [],
        cliBypassToolsAllowed: [],
        cliBypassWarning: false,
        overlayYamlPreview: "tools:\n",
        warnings: [],
      },
      warnCostUsd: 2,
      maxCostUsd: 5,
      staleServers: [],
      enumerationError: null,
      scripts: { pre: "", post: "" },
      timeoutMinutes: 120,
      notifications: { onStart: false, onComplete: false, onFail: false, onApproval: false, agentMessage: false },
    };
    dryRunRoutine.mockResolvedValueOnce(baseDryRun);
    render();
    await settle();
    await openEditor();
    await act(async () => buttonNamed("Dry run").click());
    await settle();
    expect(document.querySelector("[data-dry-run]")?.textContent).toContain("timeout 2 h");

    dryRunRoutine.mockResolvedValueOnce({ ...baseDryRun, timeoutMinutes: 0 });
    await act(async () => buttonNamed("Dry run").click());
    await settle();
    expect(document.querySelector("[data-dry-run]")?.textContent).toContain("timeout Unlimited");
  });
});

describe("RoutinesView notifications (#1294)", () => {
  function checkbox(label: string): HTMLInputElement {
    const found = [...document.querySelectorAll<HTMLLabelElement>("[data-routine-notifications] label")].find(
      (l) => l.textContent?.trim() === label,
    );
    if (!found) throw new Error(`no "${label}" checkbox`);
    return found.querySelector("input")!;
  }

  it("defaults all off, gates agentMessage on onComplete, and saves the selections", async () => {
    let current = routine();
    const updateRoutine = vi.fn(async (_id: string, patch: unknown) => {
      current = { ...current, ...(patch as Partial<RoutineRecord>) };
      useStore.setState({ routinesState: routinesState({ routines: [current] }) });
      return current;
    });
    useStore.setState({ updateRoutine });
    render();
    await settle();
    await openEditor();

    for (const label of ["When routine starts", "When approval is needed", "When routine completes", "Let agent write completion message", "When routine fails"]) {
      expect(checkbox(label).checked).toBe(false);
    }
    expect(checkbox("Let agent write completion message").disabled).toBe(true);

    act(() => checkbox("When routine completes").click());
    expect(checkbox("Let agent write completion message").disabled).toBe(false);
    act(() => checkbox("Let agent write completion message").click());
    act(() => checkbox("When routine fails").click());
    await act(async () => buttonNamed("Save routine").click());
    await settle();
    expect(updateRoutine).toHaveBeenLastCalledWith(
      current.id,
      expect.objectContaining({
        notifications: { onStart: false, onComplete: true, onFail: true, onApproval: false, agentMessage: true },
      }),
      null,
    );
  });

  it("links to Settings when desktop notifications are off globally", async () => {
    const openSettings = vi.fn();
    useStore.setState((s) => ({ state: { ...s.state!, desktopNotifications: false }, openSettings }));
    render();
    await settle();
    await openEditor();
    const note = document.querySelector("[data-routine-notifications-disabled-note]");
    expect(note?.textContent).toContain("Desktop notifications are off in Settings → General.");
    act(() => buttonNamed("Open Settings").click());
    expect(openSettings).toHaveBeenCalledWith("general");
  });

  it("summarizes active notification events in the Dry run panel", async () => {
    dryRunRoutine.mockResolvedValueOnce({
      routineId: "a".repeat(22),
      nextFireAtMs: null,
      compiled: {
        approvalMode: "always-ask",
        overlayEntries: { read: "allow", "omp-ui_notify": "allow" },
        deniedBuiltins: [],
        addedLater: [],
        missingFromCatalog: [],
        cliBypassToolsAllowed: [],
        cliBypassWarning: false,
        overlayYamlPreview: "tools:\n",
        warnings: [],
      },
      warnCostUsd: 2,
      maxCostUsd: 5,
      staleServers: [],
      enumerationError: null,
      scripts: { pre: "", post: "" },
      timeoutMinutes: 30,
      notifications: { onStart: true, onComplete: true, onFail: true, onApproval: true, agentMessage: true },
    } satisfies RoutineDryRunResult);
    render();
    await settle();
    await openEditor();
    await act(async () => buttonNamed("Dry run").click());
    await settle();
    expect(document.querySelector("[data-dry-run-notifications]")?.textContent).toBe(
      "Notifications: start, approval, complete (agent message), fail",
    );
    expect(document.body.textContent).toContain("omp-ui_notify");
  });

  it("selects a focused routine once routinesState arrives after navigation", async () => {
    const second = routine({ id: "b".repeat(22), name: "Evening digest" });
    useStore.setState({ routinesState: null, routineFocusId: second.id });
    render();
    await settle();
    // Focus request survives while state is still null.
    expect(useStore.getState().routineFocusId).toBe(second.id);
    act(() => useStore.setState({ routinesState: routinesState({ routines: [routine(), second] }) }));
    await settle();
    expect(useStore.getState().routineFocusId).toBeNull();
    // The focus request opens the gallery drawer on that routine.
    expect(document.querySelector("[data-routine-inspector]")?.textContent).toContain("Evening digest");
  });
});

describe("RoutinesView remote hosts (issue #1306)", () => {
  it("displays remote routines, preserves ADR-0101 artifact bindings read-only on save, and passes remote instanceId to updateRoutine", async () => {
    const updateRoutine = vi.fn(async () => remoteRoutine);
    const remoteProject = "/remote/proj";
    const remoteRoutine = routine({
      id: "r".repeat(22),
      name: "Remote digest",
      destination: { projectCwd: remoteProject, workspace: "worktree" },
      artifact: { artifactId: "art-1", datasetIds: ["ds-1"], autoApply: true },
    });
    const remote = remoteInstance({
      id: "inst-studio",
      nickname: "studio",
      url: "https://studio.tailnet:4677",
      status: "joined",
      routinesEnabled: true,
      projects: [
        {
          project: {
            path: remoteProject,
            name: "Studio Repo",
            addedAt: "t",
            lastModel: null,
            lastThinkingLevel: null,
            lastAdvisor: null,
            lastAdvisorModel: null,
            defaultModel: null,
            defaultAdvisorModel: null,
            browserClock: false,
            councilRoster: null,
            knowledgeHome: null,
            repositoryKey: null,
            icon: null,
          },
          sessions: [],
        },
      ],
    });
    useStore.setState({
      state: backendState({ routinesEnabled: true, remoteInstances: [remote] }),
      routinesInstanceId: "inst-studio",
      routinesByInstance: {
        "inst-studio": routinesState({ machineLabel: "studio", routines: [remoteRoutine] }),
      },
      routinesLoadError: {},
      routinesLoading: {},
      updateRoutine,
      loadRoutineToolCatalog,
      readChatModels,
    });
    render();
    await settle();
    await openEditor("r".repeat(22));

    expect(document.body.textContent).toContain("Remote · studio");
    expect(readChatModels).toHaveBeenCalledWith("inst-studio");
    expect(loadRoutineToolCatalog).toHaveBeenCalledWith(remoteProject, "inst-studio");
    const preserved = document.querySelector("[data-routine-artifact-remote-preserved]");
    expect(preserved?.textContent).toContain("Artifact refresh binding configured on studio — preserved on save.");

    // Edit the name and save: the artifact binding must survive verbatim and route to inst-studio.
    const nameInput = document.querySelector<HTMLInputElement>('input[aria-label="Name"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(nameInput, "Remote digest v2");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => buttonNamed("Save routine").click());
    await settle();
    expect(updateRoutine).toHaveBeenCalledWith(
      remoteRoutine.id,
      expect.objectContaining({
        name: "Remote digest v2",
        artifact: { artifactId: "art-1", datasetIds: ["ds-1"], autoApply: true },
      }),
      "inst-studio",
    );
  });

  it("shows read-only cached banner when remote disconnects, unsupported state on unknown channel, and disabled state when routinesEnabled is off", async () => {
    const reconnectRemoteInstance = vi.fn(async () => {});
    const cached = routinesState({ machineLabel: "studio", routines: [routine({ name: "Cached job" })] });
    const offline = remoteInstance({ id: "inst-studio", nickname: "studio", status: "unreachable", routinesEnabled: true });
    useStore.setState({
      state: backendState({ routinesEnabled: true, remoteInstances: [offline] }),
      routinesInstanceId: "inst-studio",
      routinesByInstance: { "inst-studio": cached },
      routinesLoadError: {},
      routinesLoading: {},
      reconnectRemoteInstance,
    });
    render();
    await settle();

    expect(document.querySelector("[data-routines-disconnected-banner]")?.textContent).toContain(
      "studio is not connected — viewing cached snapshot",
    );
    // Read-only cached snapshot: the gallery renders no row Run/Inspect actions.
    const readOnlyRow = document.querySelector(`[data-routine-row="${"a".repeat(22)}"]`)!;
    expect([...readOnlyRow.querySelectorAll("button")].some((b) => b.textContent?.includes("Run"))).toBe(false);
    act(() => buttonNamed("Reconnect").click());
    expect(reconnectRemoteInstance).toHaveBeenCalledWith("inst-studio");

    // Unsupported (Host Lite / older omp-ui): unknown channel routines:getState.
    act(() =>
      useStore.setState({
        state: backendState({
          routinesEnabled: true,
          remoteInstances: [remoteInstance({ id: "inst-lite", nickname: "lite", status: "joined", routinesEnabled: false })],
        }),
        routinesInstanceId: "inst-lite",
        routinesByInstance: {},
        routinesLoadError: { "inst-lite": "unknown channel routines:getState" },
      }),
    );
    await settle();
    expect(document.querySelector("[data-routines-unsupported]")?.textContent).toContain("lite does not support Routines");

    // Routines disabled on remote host.
    act(() =>
      useStore.setState({
        state: backendState({
          routinesEnabled: true,
          remoteInstances: [remoteInstance({ id: "inst-off", nickname: "gpu-box", status: "joined", routinesEnabled: false })],
        }),
        routinesInstanceId: "inst-off",
        routinesByInstance: { "inst-off": routinesState({ enabled: false, machineLabel: "gpu-box", routines: [] }) },
        routinesLoadError: {},
      }),
    );
    await settle();
    expect(document.querySelector("[data-routines-disabled]")?.textContent).toContain("Routines are off on gpu-box");
  });
});

describe("RoutinesView Schedule refresh shortcut from Artifacts (#1307)", () => {
  it("preserves openNewRoutineForArtifact seed across store clear and resolves bound artifacts beyond page 1", async () => {
    const beyondPageId = "99999999-9999-4999-8999-999999999999";
    backendMock.artifactList.mockResolvedValueOnce({
      artifacts: [],
      nextCursor: null,
      libraryBytesUsed: 0,
      totalCount: 60,
      pendingReviewCount: 0,
      pendingReviewPreview: [],
      origins: [],
    });
    backendMock.artifactDescribe.mockResolvedValueOnce({
      artifact: {
        artifactId: beyondPageId,
        ownerInstanceId: "11111111-1111-4111-8111-111111111111",
        title: "Older Dashboard",
        managed: true,
        currentCodeRevisionId: "22222222-2222-4222-8222-222222222222",
        currentDataSnapshotId: "33333333-3333-4333-8333-333333333333",
        generation: 1,
        keptAt: "2026-11-01T00:00:00.000Z",
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        pinnedAt: null,
        origin: { ownerInstanceId: "11111111-1111-4111-8111-111111111111", lineageDir: "l", sessionId: null, runtimeKey: null, toolCallId: null, sourceHash: "a".repeat(64), createdAt: "2026-11-01T00:00:00.000Z" },
        originContext: { kind: "project", label: "one", path: PROJECT },
        sourceDraftId: "44444444-4444-4444-8444-444444444444",
      },
      code: {
        artifactId: beyondPageId,
        codeRevisionId: "22222222-2222-4222-8222-222222222222",
        revisionNumber: 1,
        baseRevisionId: null,
        definition: { protocolVersion: 1, stateSchema: "s-v1", datasets: [{ id: "metrics", title: "Metrics", schema: "m-v1" }] },
        source: { ownerInstanceId: "11111111-1111-4111-8111-111111111111", lineageDir: "l", sessionId: null, runtimeKey: null, toolCallId: null, sourceHash: "a".repeat(64), createdAt: "2026-11-01T00:00:00.000Z" },
        createdAt: "2026-11-01T00:00:00.000Z",
      },
      snapshot: { artifactId: beyondPageId, dataSnapshotId: "33333333-3333-4333-8333-333333333333", stateRevision: 0, cause: "initial", createdAt: "2026-11-01T00:00:00.000Z", datasets: [] },
      revisions: [],
      snapshots: [],
      references: [],
      captures: [],
      refreshRequests: [],
      candidates: [],
      retainedBytes: 512,
      libraryBytesUsed: 512,
      thumbnails: { dark: null, light: null },
    });
    const artifactList = backendMock.artifactList;
    const artifactDescribe = backendMock.artifactDescribe;

    useStore.setState({
      state: backendState({
        routinesEnabled: true,
        artifactLibraryEnabled: true,
        projects: [{
          project: { path: PROJECT, name: "one", addedAt: "2026-11-01T00:00:00.000Z", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null, browserClock: false, councilRoster: null, knowledgeHome: null, repositoryKey: null, icon: null },
          sessions: [],
        }],
      }),
      routinesState: routinesState({ routines: [] }),
      routinesInstanceId: null,
      refreshRoutines: vi.fn(async () => {}),
      loadRoutineToolCatalog: vi.fn(async () => CATALOG),
      readChatModels: vi.fn(async () => ({ models: [], discovered: true, error: null })),
    });

    act(() => {
      useStore.getState().openNewRoutineForArtifact({
        artifactId: beyondPageId,
        datasetIds: ["metrics"],
        projectCwd: PROJECT,
        title: "Older Dashboard",
      });
    });
    render();
    await settle();

    // Store cleared the seed once copied to local state, while editor retained prefilled values.
    expect(useStore.getState().routineDraftArtifact).toBeNull();
    const nameInput = document.querySelector<HTMLInputElement>('input[aria-label="Name"]');
    expect(nameInput?.value).toBe("Refresh Older Dashboard");
    expect(artifactList).toHaveBeenCalledWith({ filter: "managed", limit: 50 });
    expect(artifactDescribe).toHaveBeenCalledWith({ artifactId: beyondPageId });
    expect(document.body.textContent).toContain("Older Dashboard");
    expect(document.body.textContent).not.toContain("no longer exists");
  });
});

describe("RoutineEditor Plan-mode artifact guard (#1361)", () => {
  const ARTIFACT_ID = "0e9d8c7b-6a5f-4e3d-8c1b-0a9f8e7d6c5b";

  it("auto-switches Plan to Build when binding an artifact, disables Plan while bound, and re-enables Plan when cleared", async () => {
    backendMock.artifactList.mockResolvedValue({
      artifacts: [
        {
          artifactId: ARTIFACT_ID,
          ownerInstanceId: "11111111-1111-4111-8111-111111111111",
          title: "Jira Tickets",
          managed: true,
          currentCodeRevisionId: "22222222-2222-4222-8222-222222222222",
          currentDataSnapshotId: "33333333-3333-4333-8333-333333333333",
          generation: 1,
          keptAt: "2026-11-01T00:00:00.000Z",
          createdAt: "2026-11-01T00:00:00.000Z",
          updatedAt: "2026-11-01T00:00:00.000Z",
          pinnedAt: null,
          origin: {
            ownerInstanceId: "11111111-1111-4111-8111-111111111111",
            lineageDir: "l",
            sessionId: null,
            runtimeKey: null,
            toolCallId: null,
            sourceHash: "a".repeat(64),
            createdAt: "2026-11-01T00:00:00.000Z",
          },
          originContext: { kind: "project", label: "one", path: PROJECT },
          sourceDraftId: "44444444-4444-4444-8444-444444444444",
        },
      ],
      nextCursor: null,
      libraryBytesUsed: 0,
      totalCount: 1,
      pendingReviewCount: 0,
      pendingReviewPreview: [],
      origins: [],
    });
    backendMock.artifactDescribe.mockResolvedValue({
      artifact: {
        artifactId: ARTIFACT_ID,
        ownerInstanceId: "11111111-1111-4111-8111-111111111111",
        title: "Jira Tickets",
        managed: true,
        currentCodeRevisionId: "22222222-2222-4222-8222-222222222222",
        currentDataSnapshotId: "33333333-3333-4333-8333-333333333333",
        generation: 1,
        keptAt: "2026-11-01T00:00:00.000Z",
        createdAt: "2026-11-01T00:00:00.000Z",
        updatedAt: "2026-11-01T00:00:00.000Z",
        pinnedAt: null,
        origin: {
          ownerInstanceId: "11111111-1111-4111-8111-111111111111",
          lineageDir: "l",
          sessionId: null,
          runtimeKey: null,
          toolCallId: null,
          sourceHash: "a".repeat(64),
          createdAt: "2026-11-01T00:00:00.000Z",
        },
        originContext: { kind: "project", label: "one", path: PROJECT },
        sourceDraftId: "44444444-4444-4444-8444-444444444444",
      },
      code: {
        artifactId: ARTIFACT_ID,
        codeRevisionId: "22222222-2222-4222-8222-222222222222",
        revisionNumber: 1,
        baseRevisionId: null,
        definition: { protocolVersion: 1, stateSchema: "s-v1", datasets: [{ id: "tickets", title: "Tickets", schema: "t-v1" }] },
        source: {
          ownerInstanceId: "11111111-1111-4111-8111-111111111111",
          lineageDir: "l",
          sessionId: null,
          runtimeKey: null,
          toolCallId: null,
          sourceHash: "a".repeat(64),
          createdAt: "2026-11-01T00:00:00.000Z",
        },
        createdAt: "2026-11-01T00:00:00.000Z",
      },
      snapshot: { artifactId: ARTIFACT_ID, dataSnapshotId: "33333333-3333-4333-8333-333333333333", stateRevision: 0, cause: "initial", createdAt: "2026-11-01T00:00:00.000Z", datasets: [] },
      revisions: [],
      snapshots: [],
      references: [],
      captures: [],
      refreshRequests: [],
      candidates: [],
      retainedBytes: 512,
      libraryBytesUsed: 512,
      thumbnails: { dark: null, light: null },
    });
    const existing = routine({ mode: "plan", artifact: null });
    useStore.setState({
      state: backendState({
        routinesEnabled: true,
        artifactLibraryEnabled: true,
        projects: [{
          project: {
            path: PROJECT,
            name: "one",
            addedAt: "2026-11-01T00:00:00.000Z",
            lastModel: null,
            lastThinkingLevel: null,
            lastAdvisor: null,
            lastAdvisorModel: null,
            defaultModel: null,
            defaultAdvisorModel: null,
            browserClock: false,
            councilRoster: null,
            knowledgeHome: null,
            repositoryKey: null,
            icon: null,
          },
          sessions: [],
        }],
      }),
      routinesState: routinesState({ routines: [existing] }),
      routinesInstanceId: null,
      refreshRoutines: vi.fn(async () => {}),
      loadRoutineToolCatalog: vi.fn(async () => CATALOG),
      readChatModels: vi.fn(async () => ({ models: [], discovered: true, error: null })),
    });

    render();
    await settle();
    await openEditor(existing.id);

    const modeButtons = () => {
      const group = document.querySelector('[role="group"][aria-label="Mode"]')!;
      const buttons = [...group.querySelectorAll("button")];
      return {
        build: buttons.find((b) => b.textContent === "Build")!,
        plan: buttons.find((b) => b.textContent === "Plan")!,
      };
    };
    expect(modeButtons().plan.getAttribute("aria-pressed")).toBe("true");
    expect(modeButtons().plan.disabled).toBe(false);

    const select = document.querySelector<HTMLSelectElement>("[data-routine-artifact-select]")!;
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    await act(async () => {
      selectSetter.call(select, ARTIFACT_ID);
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();

    expect(modeButtons().build.getAttribute("aria-pressed")).toBe("true");
    expect(modeButtons().plan.disabled).toBe(true);
    expect(modeButtons().plan.title).toContain("Build mode");

    await act(async () => {
      selectSetter.call(select, "");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await settle();

    expect(modeButtons().plan.disabled).toBe(false);
  });

  it("surfaces validation alert and blocks Save for a remote routine in legacy Plan mode with an artifact until switched to Build", async () => {
    const remoteProject = "/remote/proj";
    const legacyRemote = routine({
      id: "p".repeat(22),
      name: "Legacy remote refresh",
      mode: "plan",
      destination: { projectCwd: remoteProject, workspace: "worktree" },
      artifact: { artifactId: ARTIFACT_ID, datasetIds: ["tickets"], autoApply: false },
    });
    const remote = remoteInstance({
      id: "inst-studio",
      nickname: "studio",
      url: "https://studio.tailnet:4677",
      status: "joined",
      routinesEnabled: true,
      projects: [{
        project: {
          path: remoteProject,
          name: "Studio Repo",
          addedAt: "t",
          lastModel: null,
          lastThinkingLevel: null,
          lastAdvisor: null,
          lastAdvisorModel: null,
          defaultModel: null,
          defaultAdvisorModel: null,
          browserClock: false,
          councilRoster: null,
          knowledgeHome: null,
          repositoryKey: null,
          icon: null,
        },
        sessions: [],
      }],
    });
    useStore.setState({
      state: backendState({ routinesEnabled: true, remoteInstances: [remote] }),
      routinesInstanceId: "inst-studio",
      routinesByInstance: {
        "inst-studio": routinesState({ machineLabel: "studio", routines: [legacyRemote] }),
      },
      routinesLoadError: {},
      routinesLoading: {},
      loadRoutineToolCatalog: vi.fn(async () => CATALOG),
      readChatModels: vi.fn(async () => ({ models: [], discovered: true, error: null })),
    });
    render();
    await settle();
    await openEditor(legacyRemote.id);

    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Artifact refresh routines must run in Build mode");
    expect(buttonNamed("Save routine").disabled).toBe(true);

    const group = document.querySelector('[role="group"][aria-label="Mode"]')!;
    const buildBtn = [...group.querySelectorAll("button")].find((b) => b.textContent === "Build")!;
    const planBtn = [...group.querySelectorAll("button")].find((b) => b.textContent === "Plan")!;
    expect(planBtn.disabled).toBe(true);
    expect(buildBtn.disabled).toBe(false);

    act(() => buildBtn.click());
    await settle();
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(buttonNamed("Save routine").disabled).toBe(false);
  });
});
