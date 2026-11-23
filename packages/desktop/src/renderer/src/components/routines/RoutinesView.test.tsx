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
import { backendState } from "../../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(window, { ompBackend: {} });
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
    expect(host.querySelector("header")?.textContent).toContain("Routines on work-laptop");
  });

  it("lists each routine with its schedule, next run, and last outcome", async () => {
    useStore.setState({ routinesState: routinesState({ runs: [run({ outcome: "skipped", reasonCode: "host-lane-busy" })] }) });
    const host = render();
    await settle();
    const row = host.querySelector(`[data-routine-row="${"a".repeat(22)}"]`)!;
    expect(row.textContent).toContain("Morning overview");
    expect(row.textContent).toContain("Weekdays at 08:00");
    expect(row.textContent).toContain("Next:");
    expect(row.textContent).toContain("Skipped");
  });

  it("shows main's Run now refusal verbatim and starts nothing", async () => {
    runRoutineNow.mockRejectedValueOnce(
      new Error("Error invoking remote method 'routines:runNow': Error: Another routine is running — try again in a moment"),
    );
    render();
    await settle();
    await act(async () => buttonNamed("Run now").click());
    await settle();
    expect(runRoutineNow).toHaveBeenCalledWith("a".repeat(22));
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
    };
    dryRunRoutine.mockResolvedValueOnce(result);
    render();
    await settle();
    await act(async () => buttonNamed("Dry run").click());
    await settle();
    expect(dryRunRoutine).toHaveBeenCalledWith({ kind: "saved", id: "a".repeat(22) });
    const panel = document.querySelector("[data-dry-run]")!.parentElement!;
    expect(panel.textContent).toContain("Auto-allowed (2)");
    expect(panel.textContent).toContain("Will pause on Approval card (1)");
    expect(panel.textContent).toContain("Hard denied (1)");
    expect(panel.textContent).toContain("Added after last review: mcp__gmail_send");
  });

  it("marks a tool added since the review, and warns when a shell is allowed", async () => {
    render();
    await settle();
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
    act(() => routineTab("history").click());
    const history = document.querySelector("[data-run-history]")!;
    expect(history.textContent).toContain("Previous run still open");
    expect(history.textContent).toContain("Stopped at spend cap");
    expect(history.textContent).toContain("Timed out at 30 minutes");
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
    expect(loadRoutineToolCatalog).toHaveBeenCalledWith(PROJECT);
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
    };
    dryRunRoutine.mockResolvedValueOnce(result);
    render();
    await settle();
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
    );

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
    expect(host.querySelector('[aria-label="Name"]')?.getAttribute("value")).toBe("Gmail triage");
    expect(useStore.getState().routineFocusId).toBeNull();
  });

  it("clears a focus request for a routine that no longer exists", async () => {
    useStore.setState({ routinesState: routinesState(), routineFocusId: "g".repeat(22) });
    render();
    await settle();
    expect(useStore.getState().routineFocusId).toBeNull();
  });
});
