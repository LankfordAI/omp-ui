// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GoalState, NativeGoal } from "@omp-ui/core/goal";
import type { AutoresearchSnapshot } from "@omp-ui/core/autoresearch";
import type { LimitsView } from "@omp-ui/core/limits";
import type { BackendState, ExperimentRecord, OmpSettingsSnapshot, ProjectExperiments, ServiceTier } from "@omp-ui/core/types";
import type { CapabilitySnapshot } from "@omp-ui/core/capabilities";
import { emptySessionRuntime } from "../lib/rpc-types";
import type { SessionRuntime } from "../lib/rpc-types";
import { localeTag, t } from "../lib/i18n";
import { backendState, remoteInstance, rpcTabState, tabInfo } from "../test/fixtures";
import type { ExperimentsCache, RpcTabState } from "../store/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const readOmpSettings = vi.fn((): Promise<OmpSettingsSnapshot> =>
  Promise.resolve({ entries: [], agentDir: null, projectConfigPath: null, error: null }),
);
Object.assign(window, {
  ompBackend: {
    // The approval-mode sheet row reads omp's config when it opens to show
    // the inherit default; everything else in this file drives the store.
    readOmpSettings,
    setSessionApprovalMode: vi.fn(async () => {}),
  },
});
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { SessionHud } = await import("./SessionHud");

const TAB = "tab-mobile";
const BUILD_MODE_TOOLTIP = "Build mode — working-tree writes and state-changing commands are allowed";
const PLAN_MODE_TOOLTIP_WITH_PATH = "Plan mode — read-only exploration — /plan.md";
const PLAN_MODE_TOOLTIP_WITHOUT_PATH = "Plan mode — read-only exploration — no plan drafted";
const compactSession = vi.fn(async () => "acked" as const);
const exportHtml = vi.fn(async () => {});
const shareSession = vi.fn(async () => {});
const branchSession = vi.fn(async () => {});
const newSession = vi.fn(async () => {});
const toggleConsole = vi.fn();
let root: Root | null = null;

const state = backendState({
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
      sessions: [
        {
          tabId: TAB,
          sessionId: "s",
          lineageDir: "lineage",
          projectCwd: "/p",
          launchedAt: "t",
          mode: "rpc-ui",
          worktree: null,
          planImplementationSource: null, experiment: null,
          agentMode: "build",
          compactionMethod: null,
          approvalMode: null,
          serviceTier: null,
          model: null,
          thinkingLevel: null,
          advisor: false,
          advisorModel: null, subagentModels: null,
 proposedPlans: [],
          cachedTitle: "Mobile session",
          cachedModified: "t",
          title: "Mobile session",
          status: "complete",
          live: "live",
          pendingPlan: null,
          planSettle: null,
              streamStalled: false,
        },
      ],
    },
  ],
});

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  vi.clearAllMocks();
  useStore.setState({
    state,
    rpc: {
      [TAB]: rpcTabState({
        status: "ready",
        hasRenamed: true,
        session: {
          ...emptySessionRuntime(),
          contextUsage: { tokens: 20, contextWindow: 100, percent: 20 },
        },
        extensionStatus: { advisor: "available" },
        plan: {
          enabled: true,
          planFilePath: "/plan.md",
          planAbsPath: "/plan.md",
          approved: false,
        },
      }),
    },
    compactSurface: null,
    compactionSettings: {},
    compactSession, exportHtml, shareSession, branchSession, newSession, toggleConsole,
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("wide Session HUD", () => {
  it("opens the queue-modes popover outside the clipped HUD container (#78)", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="queue modes and retry"]')!;
    act(() => trigger.click());
    for (const label of ["steering", "follow-up", "interrupt", "auto-retry", "abort retry"]) {
      expect(document.body.textContent).toContain(label);
    }
    // The wide HUD root is overflow-hidden inside the h-9 title bar, so the
    // popover must portal out of the HUD subtree or it clips to invisibility.
    const steering = [...document.body.querySelectorAll("span")].find((s) => s.textContent === "steering")!;
    expect(host.contains(steering)).toBe(false);
    // Fail closed still holds with the panel portaled: inside pointerdown
    // keeps it open, outside pointerdown dismisses.
    const abort = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "abort retry")!;
    act(() => { abort.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(document.body.textContent).toContain("steering");
    // #79: the switch renders no visible text, so it must sit in the same
    // group as its "auto-retry" label — never beside the abort-retry button.
    const retrySwitch = document.body.querySelector('[role="switch"][aria-label="auto-retry"]')!;
    expect(retrySwitch.parentElement!.textContent).toContain("auto-retry");
    expect(retrySwitch.parentElement!.textContent).not.toContain("abort retry");
    // #80: every mode option carries an explanatory tooltip, and each row
    // header explains the mode itself.
    const oneAtATime = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "one-at-a-time")!;
    expect(oneAtATime.title).toContain("one by one");
    expect(document.body.querySelector('[title^="steering messages:"]')).not.toBeNull();
    // #81: omp's interrupt enum is immediate|wait — "queue" is stored by omp
    // but behaves as immediate, so it must never be offered.
    const waitOption = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "wait")!;
    expect(waitOption.title).toContain("let the current tool finish");
    expect([...document.body.querySelectorAll("button")].some((b) => b.textContent === "queue")).toBe(false);
    act(() => { document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); });
    expect(document.body.textContent).not.toContain("steering");
  });

  it("runs the /new spawn from the title-bar button (#82)", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="new session in current project"]')!;
    expect(trigger.disabled).toBe(false);
    act(() => trigger.click());
    expect(newSession).toHaveBeenCalledWith("/p", undefined, null);
  });

  it("shares from the title-bar icon strip (#679)", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    const trigger = host.querySelector<HTMLButtonElement>(
      'button[aria-label="publish an encrypted snapshot of this session"]',
    )!;
    expect(trigger.disabled).toBe(false);
    act(() => trigger.click());
    expect(shareSession).toHaveBeenCalledWith(TAB);
  });

  it("shows a remote worktree chip with only remote-safe actions (#435)", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    const group = state.projects[0]!;
    const remoteSession = {
      ...group.sessions[0]!,
      projectCwd: "/remote/project",
      title: "Remote worktree session",
      cachedTitle: "Remote worktree session",
      worktree: { path: "/remote/worktrees/feature", branch: "omp/remote-feature", base: "main" },
    };
    useStore.setState({
      state: backendState({
        projects: [],
        remoteInstances: [remoteInstance({
          id: "inst-remote",
          nickname: "build-box",
          projects: [{
            ...group,
            project: { ...group.project, path: "/remote/project", name: "Remote project" },
            sessions: [remoteSession],
          }],
        })],
      }),
    });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));

    const text = host.textContent!;
    expect(text).toContain("build-box");
    expect(text).toContain("⎇ omp/remote-feature");
    expect(text).toContain("Remote worktree session");
    expect(text.indexOf("build-box")).toBeLessThan(text.indexOf("⎇ omp/remote-feature"));
    expect(text.indexOf("⎇ omp/remote-feature")).toBeLessThan(text.indexOf("Remote worktree session"));

    const worktreeTrigger = host.querySelector<HTMLButtonElement>('button[title="/remote/worktrees/feature"]')!;
    act(() => worktreeTrigger.click());
    expect(document.body.textContent).toContain("finish worktree…");
    expect(document.body.textContent).not.toContain("Open in VS Code");
    expect(document.body.textContent).not.toContain("Open in Files");
  });

  it("co-locates the main spend with the main meter, before the advisor cluster (#107)", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB],
          stats: {
            userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
            tokens: { input: 60_000, output: 40_000, reasoning: 0, cacheRead: 1_000_000, cacheWrite: 0, total: 1_100_000 },
            cost: 0.0886, premiumRequests: 3, contextUsage: null,
          },
          advisorStats: {
            available: true, configured: true, active: false, model: "root/advisor", subscription: false,
            contextWindow: 1000, contextTokens: 200, cost: 0.273, totalTokens: 320_000, advisors: [], configWarnings: [],
          },
        },
      },
    });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    const text = document.body.textContent!;
    const mainCost = text.indexOf("$0.0886");
    const adv = text.indexOf("adv");
    const advisorCost = text.indexOf("$0.2730");
    expect(mainCost).toBeGreaterThanOrEqual(0);
    expect(mainCost).toBeLessThan(adv);
    expect(adv).toBeLessThan(advisorCost);
    expect(text.slice(0, adv)).toContain("1.1M tok");
    const advisorCluster = host.querySelector<HTMLElement>(".titlebar-advisor")!;
    expect(advisorCluster.title).toContain("parent advisor context · root/advisor");
    expect(advisorCluster.title).toContain("session-tree advisor spend $0.2730");
    expect(advisorCluster.title).toContain("session-tree advisor tokens 320,000");
  });

  it("keeps default Plan unnamed and gives exceptional Build its permission tooltip (#142)", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    useStore.setState((state) => ({
      rpc: {
        ...state.rpc,
        [TAB]: { ...state.rpc[TAB]!, plan: null },
      },
    }));
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    expect(host.querySelector("[title^=\"Plan mode\"]")).toBeNull();
    expect(host.querySelector("[title^=\"Build mode\"]")).toBeNull();
    // #167: the wide HUD's only mode surface is the exceptional chip — the
    // inline selector is gone. Capsule titles start lowercase; chip titles capital.
    expect(host.querySelector("[title^=\"build mode\"]")).toBeNull();
    expect(host.querySelector("[title^=\"plan mode:\"]")).toBeNull();

    act(() => useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB]!,
          plan: { enabled: true, planFilePath: "/plan.md", planAbsPath: "/plan.md", approved: false },
        },
      },
    }));
    expect(host.querySelector("[title^=\"Plan mode\"]")).toBeNull();
    expect(host.querySelector("[title^=\"Build mode\"]")).toBeNull();

    act(() => useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB]!,
          plan: { enabled: false, planFilePath: null, planAbsPath: null, approved: false },
        },
      },
    }));
    expect(host.querySelector(`[title="${BUILD_MODE_TOOLTIP}"]`)?.textContent).toContain("build");
  });

  it("describes exceptional Plan with its path or the undrafted fallback (#143)", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    useStore.setState((s) => ({ state: { ...s.state!, defaultAgentMode: "build" } }));
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    expect(host.querySelector(`[title="${PLAN_MODE_TOOLTIP_WITH_PATH}"]`)?.textContent).toContain("plan");

    act(() => useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB]!,
          plan: { enabled: true, planFilePath: null, planAbsPath: null, approved: false },
        },
      },
    }));
    expect(host.querySelector(`[title="${PLAN_MODE_TOOLTIP_WITHOUT_PATH}"]`)?.textContent).toContain("plan");
  });

  it("keeps the title bar's whitespace draggable without swallowing a control (#108)", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB],
          stats: {
            userMessages: 1, assistantMessages: 1, toolCalls: 0, toolResults: 0, totalMessages: 2,
            tokens: { input: 10, output: 10, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 20 },
            cost: 0.01, premiumRequests: 1, contextUsage: null,
          },
          advisorStats: {
            available: true, configured: true, active: false, model: null, subscription: false,
            contextWindow: 1000, contextTokens: 200, cost: 0.1, totalTokens: 0, advisors: [], configWarnings: [],
          },
        },
      },
    });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));

    // The HUD is the widest stretch of the merged title bar, so its root is
    // the window's drag surface — a blanket no-drag here left the strip
    // ungrabbable except for two 4px gaps (#108).
    const hud = host.firstElementChild as HTMLElement;
    expect(hud.classList.contains("[app-region:drag]")).toBe(true);

    // A drag region ignores all pointer events, so every control and every
    // hover tooltip must sit inside a no-drag box under that root.
    const carvedOut = (el: HTMLElement): boolean => {
      for (let n: HTMLElement | null = el; n; n = n.parentElement) {
        if (n.classList.contains("[app-region:no-drag]")) return true;
        if (n === hud) return false;
      }
      return false;
    };
    const controls = [...hud.querySelectorAll<HTMLElement>('button, input, [role="switch"], [title]')];
    expect(controls.length).toBeGreaterThan(8);
    for (const el of controls) {
      expect(carvedOut(el), el.getAttribute("aria-label") ?? el.getAttribute("title") ?? el.textContent ?? "").toBe(true);
    }

    // ...and the flexible spacer that supplies the drag surface must stay out
    // of every no-drag box, or there is nothing left to grab.
    const spacer = [...hud.children].find((c) => c.classList.contains("flex-1")) as HTMLElement | undefined;
    expect(spacer).toBeDefined();
    expect(carvedOut(spacer!)).toBe(false);
  });

  it("shows the wide MCP failure badge and accessible count", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    useStore.setState((state) => ({
      rpc: {
        ...state.rpc,
        [TAB]: rpcTabState({
          ...state.rpc[TAB],
          mcpStatus: {
            pendingServers: [],
            connectedServers: [],
            failedServers: Array.from({ length: 120 }, (_, index) => ({
              serverName: `server-${index}`,
              kind: "connection" as const,
            })),
          },
        }),
      },
    }));
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));

    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="Capabilities — 120 MCP failures"]');
    expect(trigger?.title).toBe("Capabilities — 120 MCP failures");
    expect(trigger?.parentElement?.textContent).toContain("99+");
  });
  it("opens the global catalog viewer, pinning no session (issue #383)", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));

    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Capabilities"]')!.click());
    // Not (scopeCwd, tabId): the catalog modal is scope-global from any context.
    expect(useStore.getState().capabilitiesViewer).toEqual({ scopeCwd: null, section: "mcp", instanceId: null });
  });

  it("renders the button even when the record has no working tree", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    const group = state.projects[0]!;
    useStore.setState({
      state: {
        ...state,
        projects: [
          // No record answers the tab at all: sessionCwd() is undefined here —
          // the case that used to hide the button.
          { ...group, sessions: [] },
        ],
      },
    });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));

    expect(host.querySelector('button[aria-label="Capabilities"]')).not.toBeNull();
  });
});

describe("compact Session HUD", () => {
  it("shows the MCP failure count in the session-actions sheet", () => {
    useStore.setState((state) => ({
      rpc: {
        ...state.rpc,
        [TAB]: rpcTabState({
          ...state.rpc[TAB],
          mcpStatus: {
            pendingServers: [],
            connectedServers: [],
            failedServers: [
              { serverName: "one", kind: "auth" },
              { serverName: "two", kind: "connection" },
            ],
          },
        }),
      },
    }));
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label="session actions"]')!.click());

    const mcp = [...document.body.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.includes("Capabilities"));
    expect(mcp?.textContent).toContain("2 failed");
  });

  it("keeps the console control directly in the HUD and toggles this tab", () => {
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    const consoleToggles = document.body.querySelectorAll<HTMLButtonElement>('button[aria-label="toggle console (mod+j)"]');
    expect(consoleToggles).toHaveLength(1);
    const consoleToggle = consoleToggles[0]!;
    expect(consoleToggle.closest("header")).not.toBeNull();
    expect(useStore.getState().compactSurface).toBeNull();
    act(() => consoleToggle.click());
    expect(toggleConsole).toHaveBeenCalledWith(TAB);
  });

  it("keeps default Plan unnamed and gives exceptional Build its permission tooltip (#142)", () => {
    useStore.setState((state) => ({
      rpc: {
        ...state.rpc,
        [TAB]: { ...state.rpc[TAB]!, plan: null },
      },
    }));
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    expect(host.querySelector("header")?.textContent).not.toContain("plan");
    expect(host.querySelector("header")?.textContent).not.toContain("build");
    expect(host.querySelector("[title^=\"Plan mode\"]")).toBeNull();

    act(() => useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB]!,
          plan: { enabled: true, planFilePath: "/plan.md", planAbsPath: "/plan.md", approved: false },
        },
      },
    }));
    expect(host.querySelector("[title^=\"Plan mode\"]")).toBeNull();
    expect(host.querySelector("[title^=\"Build mode\"]")).toBeNull();

    act(() => useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB]!,
          plan: { enabled: false, planFilePath: null, planAbsPath: null, approved: false },
        },
      },
    }));
    expect(host.querySelector(`[title="${BUILD_MODE_TOOLTIP}"]`)?.textContent).toContain("build");
  });

  it("describes exceptional Plan with its path or the undrafted fallback (#143)", () => {
    useStore.setState((s) => ({ state: { ...s.state!, defaultAgentMode: "build" } }));
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    expect(host.querySelector(`[title="${PLAN_MODE_TOOLTIP_WITH_PATH}"]`)?.textContent).toContain("plan");

    act(() => useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB]!,
          plan: { enabled: true, planFilePath: null, planAbsPath: null, approved: false },
        },
      },
    }));
    expect(host.querySelector(`[title="${PLAN_MODE_TOOLTIP_WITHOUT_PATH}"]`)?.textContent).toContain("plan");
  });

  it("keeps displaced actions reachable and passes the same tab id", () => {
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    const actions = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("session actions"))!;
    act(() => actions.click());
    for (const label of ["build", "plan", "compact", "auto-compact", "export", "share", "Capabilities", "branch", "new", "refresh", "steering", "follow-up", "interrupt", "auto-retry", "abort retry"]) {
      expect(document.body.textContent).toContain(label);
    }
    const compact = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "compact")!;
    const exportButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "export")!;
    const branch = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "branch")!;
    const fresh = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "new")!;
    act(() => { compact.click(); exportButton.click(); branch.click(); fresh.click(); });
    const share = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "share")!;
    act(() => share.click());
    expect(compactSession).toHaveBeenCalledWith(TAB);
    expect(exportHtml).toHaveBeenCalledWith(TAB);
    expect(shareSession).toHaveBeenCalledWith(TAB);
    expect(branchSession).toHaveBeenCalledWith(TAB);
    // #82: "new" runs the same spawn as /new and mod+shift+n, not an in-tab reset.
    expect(newSession).toHaveBeenCalledWith("/p", undefined, null);
  });

  it("shows session-tree advisor tokens and cost in the actions sheet", () => {
    useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB]!,
          advisorStats: {
            available: true, configured: true, active: false, model: "root/advisor", subscription: false,
            contextWindow: 200_000, contextTokens: 12_000, cost: 0.375, totalTokens: 456_000, advisors: [], configWarnings: [],
          },
        },
      },
    });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    const actions = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("session actions"))!;
    act(() => actions.click());

    const totalLabel = [...document.body.querySelectorAll("span")].find((span) => span.textContent === "advisor total");
    expect(totalLabel).toBeDefined();
    expect(totalLabel?.parentElement?.textContent).toContain("456K tok");
    expect(totalLabel?.parentElement?.textContent).toContain("$0.3750");
    expect(totalLabel?.parentElement?.textContent).not.toContain("12K tok");
  });
});

describe("SessionHud stream-stall chip (issue #228)", () => {
  const desktop = (): void => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
  };

  const seedRunning = (patch: Record<string, unknown> = {}): void => {
    useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB]!,
          status: "running",
          ...patch,
        },
      },
    });
  };

  it("shows the live stall label while running and stalled (wide HUD)", () => {
    desktop();
    seedRunning({ streamStallMs: 30_000 });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    expect(host.textContent).toContain("no stream activity for 30.0s");
    const chip = host.querySelector<HTMLSpanElement>('span[title^="The renderer has received no model-stream"]');
    // Observation-only tooltip (#179): claims the renderer's observation,
    // never a cause.
    expect(chip?.title).toContain("The session may still recover");
    // Copper "attention" tone (ADR-0004) and the wide-row drag exemption.
    expect(chip?.className).toContain("text-copper");
    expect(chip?.className).toContain("[app-region:no-drag]");
    // No pulse: a stalled stream is not "work happening right now".
    expect(chip?.querySelector("span")?.className).not.toContain("active-halo");
  });

  it("shows the short stall label in the compact shell", () => {
    seedRunning({ streamStallMs: 30_000 });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    expect(host.querySelector("header")?.textContent).toContain("stalled 30.0s");
    expect(host.textContent).not.toContain("no stream activity");
  });

  it("keeps the plain status label when not stalled", () => {
    desktop();
    seedRunning();
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    expect(host.textContent).toContain("running");
    expect(host.textContent).not.toContain("stalled");
  });

  it("lets the compacting chip take priority over the stall chip", () => {
    desktop();
    seedRunning({
      streamStallMs: 30_000,
      session: { ...emptySessionRuntime(), isCompacting: true },
    });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    expect(host.textContent).toContain("compacting");
    expect(host.textContent).not.toContain("no stream activity for");
  });

  it("reads compacting from the renderer's own record while the chain is blocked (issue #625)", () => {
    desktop();
    // The get_state field cannot know: every poll queues behind the blocked
    // chain, so the HUD must trust the tab's own compaction record.
    useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB]!,
          status: "ready",
          session: { ...emptySessionRuntime(), isCompacting: false },
          compacting: { startedAt: Date.now() },
        },
      },
    });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    expect(host.textContent).toContain("compacting");
    const compact = host.querySelector<HTMLButtonElement>('button[title="compact the conversation now"]')!;
    expect(compact.disabled).toBe(true);
  });
});

describe("SessionHud hibernated label (issue #246)", () => {
  it("shows the neutral hibernated label over the stale status", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB]!,
          status: "ready",
        },
      },
      exited: { [TAB]: 0 },
      hibernated: { [TAB]: true },
    });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    const span = host.querySelector('span[title="rpc status: hibernated"]')!;
    expect(span?.textContent?.trim()).toBe("hibernated");
    // Neutral, no pulse: liveness styling stays with the signal accent.
    expect(span?.querySelector("span")?.className).not.toContain("active-halo");
  });
});

describe("SessionHud compaction threshold notch (issue #249)", () => {
  const desktop = (): void => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
  };

  const seed = (
    autoCompaction: boolean,
    settings?: Record<string, { thresholdPercent?: number; thresholdTokens?: number; reserveTokens?: number } | null>,
  ): void => {
    useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB]!,
          session: {
            ...useStore.getState().rpc[TAB]!.session!,
            autoCompactionEnabled: autoCompaction,
          },
        },
      },
      ...(settings !== undefined ? { compactionSettings: settings } : {}),
    });
  };

  const meter = (host: HTMLElement): HTMLElement =>
    host.querySelector<HTMLElement>(".titlebar-context-meter")!;

  it("marks the auto-compaction threshold on the context meter while auto-compact is on", () => {
    desktop();
    seed(true, { "/p": { thresholdPercent: -1, thresholdTokens: -1 } });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    const bar = meter(host);
    expect(bar).not.toBeNull();
    const notch = bar.querySelector("span");
    expect(notch).not.toBeNull();
    // 85 of the fixture's 100-token window: for such a small window the 16K
    // default reserve is impossible, so the 15% reserve decides.
    expect(notch!.style.left).toBe("calc(85% - 1px)");
    expect(notch!.classList.contains("bg-void")).toBe(true);
    expect(bar.title).toContain("omp auto-compacts when context exceeds 85 of 100 tokens (85.0% of window)");
  });

  it("hides the notch while auto-compact is off, even with settings loaded", () => {
    desktop();
    seed(false, { "/p": { thresholdPercent: -1, thresholdTokens: -1 } });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    const bar = meter(host);
    expect(bar.querySelector("span")).toBeNull();
    expect(bar.title).not.toContain("omp auto-compacts");
  });

  it("shows no notch while the settings read is still in flight", () => {
    desktop();
    seed(true);
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    const bar = meter(host);
    expect(bar).not.toBeNull();
    expect(bar.querySelector("span")).toBeNull();
    // The meter itself is unaffected by the missing settings.
    expect(host.textContent).toContain("20.0%");
  });

  it("shows no notch when the settings read failed (cached null)", () => {
    desktop();
    seed(true, { "/p": null });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    expect(meter(host).querySelector("span")).toBeNull();
    expect(host.textContent).toContain("20.0%");
  });

  it("marks the compact shell's header meter too", () => {
    // The default beforeEach matchMedia matches: true (compact shell).
    seed(true, { "/p": { thresholdPercent: -1, thresholdTokens: -1 } });
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    const bar = meter(host);
    expect(bar.closest("header")).not.toBeNull();
    const notch = bar.querySelector("span");
    expect(notch).not.toBeNull();
    expect(notch!.style.left).toBe("calc(85% - 1px)");
  });
});

describe("SessionHud goal chip (issue #381, ADR-0046)", () => {
  const runSlashCommand = vi.fn(async () => {});

  const seedGoal = (goal: GoalState | null): void => {
    useStore.setState({
      runSlashCommand,
      rpc: { [TAB]: { ...useStore.getState().rpc[TAB]!, goal } },
    });
  };

  const nativeGoal = (patch: Partial<NativeGoal> = {}): NativeGoal => ({
    id: "g1",
    objective: "finish the migration",
    status: "active",
    tokenBudget: 40_000,
    tokensUsed: 12_345,
    timeUsedSeconds: 90,
    createdAt: 1,
    updatedAt: 2,
    ...patch,
  });

  const goalState = (patch: Partial<NativeGoal> = {}): GoalState => {
    const goal = nativeGoal(patch);
    return {
      enabled: goal.status === "active" || goal.status === "budget-limited",
      exiting: goal.status === "complete",
      goal,
    };
  };

  const render = (): HTMLElement => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    return host;
  };

  /** Buttons in the portaled popover, by visible text. */
  const popoverButton = (text: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent?.trim() === text,
    );

  it("shows the goal's status and OMP's token accounting", () => {
    seedGoal(goalState());
    const host = render();
    const chip = host.querySelector<HTMLButtonElement>('button[aria-label^="goal: finish the migration"]');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain("goal");
    // The numbers are OMP's accounting, rendered exactly.
    expect(chip?.textContent).toContain("12,345 / 40,000 tokens");
  });

  it("opens goal controls instead of dispatching a command", () => {
    seedGoal(goalState({ objective: "line one\nline two" }));
    const host = render();
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label^="goal: line one"]')!.click());
    expect(runSlashCommand).not.toHaveBeenCalled();
    // The objective renders whole, and the usage line comes from goalDetails.
    expect(document.body.textContent).toContain("line one\nline two");
    expect(document.body.textContent).toContain("12,345 of 40,000 used, 27,655 remaining");
    // An active goal offers Pause, never Resume.
    expect(popoverButton("Pause")).toBeDefined();
    expect(popoverButton("Resume")).toBeUndefined();
  });

  it("pauses the goal through the composer's goal command", () => {
    seedGoal(goalState());
    const host = render();
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label^="goal: finish"]')!.click());
    act(() => popoverButton("Pause")!.click());
    expect(runSlashCommand).toHaveBeenCalledWith(TAB, "/goal pause");
    // The action closes the popover.
    expect(popoverButton("Drop")).toBeUndefined();
  });

  it("resumes a paused goal", () => {
    seedGoal(goalState({ status: "paused", tokenBudget: null }));
    const host = render();
    act(() => host.querySelector<HTMLButtonElement>('button[aria-label^="goal paused"]')!.click());
    expect(popoverButton("Pause")).toBeUndefined();
    act(() => popoverButton("Resume")!.click());
    expect(runSlashCommand).toHaveBeenCalledWith(TAB, "/goal resume");
  });

  it("drops only on the second, confirming click", () => {
    seedGoal(goalState());
    const host = render();
    const chip = host.querySelector<HTMLButtonElement>('button[aria-label^="goal: finish"]')!;
    act(() => chip.click());
    act(() => popoverButton("Drop")!.click());
    expect(runSlashCommand).not.toHaveBeenCalled();
    // Cancel backs out of the confirmation without dispatching.
    act(() => popoverButton("Cancel")!.click());
    expect(runSlashCommand).not.toHaveBeenCalled();
    act(() => popoverButton("Drop")!.click());
    // Closing the popover resets the armed confirmation.
    act(() => chip.click());
    act(() => chip.click());
    expect(popoverButton("Confirm drop")).toBeUndefined();
    act(() => popoverButton("Drop")!.click());
    act(() => popoverButton("Confirm drop")!.click());
    expect(runSlashCommand).toHaveBeenCalledTimes(1);
    expect(runSlashCommand).toHaveBeenCalledWith(TAB, "/goal drop");
  });

  it("leaves no chip behind when there is no goal", () => {
    seedGoal(null);
    const host = render();
    expect(host.textContent).not.toContain("tokens");
    expect(host.querySelector('button[aria-label^="goal"]')).toBeNull();
  });
});

describe("SessionHud autoresearch chip (issue #559)", () => {
  const openLab = vi.fn();
  const loadExperiments = vi.fn(async () => {});

  const snapshot = (patch: Partial<AutoresearchSnapshot> = {}): AutoresearchSnapshot => ({
    version: 1,
    processKey: "proc",
    sessionId: "s",
    revision: 1,
    available: true,
    unavailable: null,
    mode: "on",
    goal: "make the benchmark faster",
    goalTruncated: false,
    lastTool: null,
    proposeUnavailable: null,
    ...patch,
  });

  const seed = (
    autoresearch: AutoresearchSnapshot | null,
    experiments: Record<string, ExperimentsCache> = {},
  ): void => {
    useStore.setState({
      openLab,
      loadExperiments,
      experiments,
      tabs: [tabInfo({ tabId: TAB, projectCwd: "/p" })],
      rpc: { [TAB]: { ...useStore.getState().rpc[TAB]!, autoresearch } },
    });
  };

  const render = (): HTMLElement => {
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    return host;
  };

  const chip = (host: HTMLElement): HTMLButtonElement | null =>
    host.querySelector<HTMLButtonElement>('button[aria-label^="autoresearch: "]');

  it("renders no chip while omp's mode is off or unreported", () => {
    for (const value of [null, snapshot({ mode: "off" })]) {
      seed(value);
      const host = render();
      expect(chip(host)).toBeNull();
      expect(host.textContent).not.toContain("autoresearch");
      if (root) act(() => root!.unmount());
      root = null;
      document.body.replaceChildren();
    }
  });

  it("names the goal, reads the project's experiments once, and opens the Lab on this tab", () => {
    seed(snapshot());
    const host = render();
    const button = chip(host)!;
    expect(button).not.toBeNull();
    expect(button.getAttribute("aria-label")).toBe("autoresearch: make the benchmark faster");
    expect(button.textContent).toBe("autoresearch");
    // The cache is empty for this project, so the chip makes the first read.
    expect(loadExperiments).toHaveBeenCalledTimes(1);
    expect(loadExperiments).toHaveBeenCalledWith("/p", null);
    act(() => button.click());
    expect(openLab).toHaveBeenCalledWith("/p", null, { tabId: TAB });
  });

  it("reports the linked experiment's run count, best delta and pending log from the Lab's cache", () => {
    const branch = "autoresearch/faster/ab12cd";
    const session = state.projects[0]!.sessions[0]!;
    const withProvenance: BackendState = {
      ...state,
      projects: [
        {
          ...state.projects[0]!,
          sessions: [
            {
              ...session,
              experiment: {
                goal: "make the benchmark faster",
                metric: "p95_ms",
                unit: "ms",
                direction: "lower",
                launchedBranch: branch,
                launchedAt: "t",
              },
            },
          ],
        },
      ],
    };
    const record: ExperimentRecord = {
      id: 1,
      name: "faster",
      goal: "make the benchmark faster",
      primaryMetric: "p95_ms",
      metricUnit: "ms",
      direction: "lower",
      preferredCommand: null,
      branch,
      baselineCommit: null,
      currentSegment: 1,
      maxIterations: 10,
      scopePaths: [],
      offLimits: [],
      constraints: [],
      secondaryMetrics: [],
      notes: "",
      createdAt: 1,
      closedAt: null,
      progress: {
        segmentRuns: 3,
        kept: 2,
        discarded: 1,
        crashed: 0,
        checksFailed: 0,
        baseline: { runId: 1, metric: 200 },
        best: { runId: 3, metric: 175 },
        pendingRunId: 4,
        lastActivityAt: 5,
        metricSeries: [],
      },
    };
    const overview: ProjectExperiments = {
      projectCwd: "/p",
      repo: "git",
      checkouts: [
        {
          cwd: "/p",
          tabId: null,
          branch: null,
          result: {
            source: { cwd: "/p", key: "--p--", dbPath: "/db/--p--.db" },
            experiments: [record],
            error: null,
          },
        },
      ],
      pendingLaunches: [],
    };
    useStore.setState({ state: withProvenance });
    seed(snapshot(), { "/p": { load: "ready", result: overview, detail: {}, error: null, revision: 1 } });
    const host = render();
    const text = chip(host)!.textContent ?? "";
    expect(text).toContain("run 3/10");
    expect(text).toContain("best \u221212.5%");
    expect(text).toContain("log pending");
    // The Lab already holds this project: no second read on the chip's behalf.
    expect(loadExperiments).not.toHaveBeenCalled();
  });
});

describe("retitle affordance (issue #433)", () => {
  const seedExchange = (): void => {
    useStore.setState({
      rpc: {
        ...useStore.getState().rpc,
        [TAB]: {
          ...useStore.getState().rpc[TAB],
          items: [
            { kind: "user", id: "u1", text: "the login button is broken" },
            { kind: "assistant", id: "a1", text: "the sheet collapses", thinking: "", streaming: false },
          ],
        },
      },
    });
  };
  const renderWide = (): HTMLElement => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    return host;
  };

  it("reveals a retitle button that reaches the action with the tab id", () => {
    const regenerateSessionTitle = vi.fn(async (): Promise<void> => {});
    useStore.setState({ regenerateSessionTitle });
    seedExchange();
    const host = renderWide();
    const button = host.querySelector<HTMLButtonElement>('button[aria-label="retitle"]')!;
    // Hidden until hover — and until keyboard focus, like the row controls.
    expect(button.className).toContain("opacity-0");
    expect(button.className).toContain("focus-visible:opacity-100");
    expect(button.title).toContain("regenerate the title");
    act(() => button.click());
    expect(regenerateSessionTitle).toHaveBeenCalledWith(TAB);
  });

  it("stays enabled with no local gate (issue #788)", () => {
    // The engine digests the session itself and answers its own decline,
    // so the row no longer gates on a local transcript digest or a local
    // in-flight flag — omp's command row is the feedback.
    const host = renderWide();
    expect(host.querySelector<HTMLButtonElement>('button[aria-label="retitle"]')!.disabled).toBe(false);
  });
});

describe("SessionHud provider quota readout (issue #673)", () => {
  const renderWide = (): HTMLElement => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    return host;
  };

  const seedLimits = (
    limits: LimitsView | null,
    quotaEvent?: RpcTabState["quotaEvent"],
  ): void => {
    useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB]!,
          limits,
          ...(quotaEvent === undefined ? {} : { quotaEvent }),
        },
      },
    });
  };

  it("renders the rate windows and their nearest reset countdown", () => {
    seedLimits({
      available: true,
      provider: "anthropic",
      windows: [
        { id: "anthropic:5h", label: "5 hour", percent: 72, resetsAtMs: Date.now() + 40 * 60_000 },
        { id: "anthropic:week", label: "week", percent: null, resetsAtMs: null },
      ],
      bankedResets: 2,
      fetchedAtMs: Date.now() - 60_000,
    });
    const host = renderWide();
    const cluster = host.querySelector<HTMLElement>(".titlebar-limits")!;
    expect(cluster.textContent).toContain("5 hour 72%");
    expect(cluster.textContent).toContain("week");
    expect(cluster.textContent).toContain("resets in");
    // An unknown percent still gets a row; the tooltip names it.
    expect(cluster.getAttribute("title")).toContain("usage unknown");
    expect(cluster.getAttribute("title")).toContain("anthropic rate limits, fetched");
    expect(cluster.textContent).toContain("×2");
  });

  it("hides the cluster when the bridge reports unavailable", () => {
    seedLimits({
      available: false,
      unavailable: "this omp build does not report provider usage",
      provider: null,
      windows: [],
      bankedResets: 0,
      fetchedAtMs: 0,
    });
    const host = renderWide();
    expect(host.querySelector(".titlebar-limits")).toBeNull();
  });

  it("hides the cluster for a provider that reports no windows", () => {
    seedLimits({
      available: true,
      provider: "mistral",
      windows: [],
      bankedResets: 0,
      fetchedAtMs: Date.now(),
    });
    const host = renderWide();
    expect(host.querySelector(".titlebar-limits")).toBeNull();
  });

  it("shows the credential-switch chip and the wait chip with its delay", () => {
    seedLimits(null, { at: Date.now(), kind: "rotation" });
    const host = renderWide();
    expect(host.textContent).toContain("credential switched");
    host.remove();
    root = null;
    seedLimits(null, { at: Date.now(), kind: "wait", delayMs: 65_000 });
    const host2 = renderWide();
    expect(host2.textContent).toContain("rate limit — waiting for 1m 05s");
  });

  it("keeps the new readouts inside no-drag boxes in the wide face", () => {
    seedLimits(
      {
        available: true,
        provider: "anthropic",
        windows: [{ id: "anthropic:5h", label: "5 hour", percent: 32, resetsAtMs: Date.now() + 60_000 }],
        bankedResets: 0,
        fetchedAtMs: Date.now(),
      },
      { at: Date.now(), kind: "rotation" },
    );
    const host = renderWide();
    const hud = host.firstElementChild as HTMLElement;
    const carvedOut = (el: HTMLElement): boolean => {
      for (let n: HTMLElement | null = el; n; n = n.parentElement) {
        if (n.classList.contains("[app-region:no-drag]")) return true;
        if (n === hud) return false;
      }
      return false;
    };
    const cluster = host.querySelector<HTMLElement>(".titlebar-limits-cluster")!;
    expect(carvedOut(cluster)).toBe(true);
    const chip = [...hud.querySelectorAll<HTMLElement>("span")].find(
      (s) => s.textContent === "credential switched",
    )!;
    expect(carvedOut(chip)).toBe(true);
  });
});

describe("SessionHud fast mode chip (issue #677)", () => {
  const desktop = (): void => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
  };

  const seedFast = (enabled: boolean, active: boolean, tier?: {
    serviceTiers: string[];
    serviceTier: ServiceTier | null;
  }): void => {
    useStore.setState((state) => ({
      state: tier === undefined ? state.state : {
        ...state.state!,
        projects: state.state!.projects.map((group) => ({
          ...group,
          sessions: group.sessions.map((record) =>
            record.tabId === TAB ? { ...record, serviceTier: tier.serviceTier } : record,
          ),
        })),
      },
      rpc: {
        ...state.rpc,
        [TAB]: {
          ...state.rpc[TAB]!,
          model: tier === undefined ? state.rpc[TAB]!.model : {
            id: "model-x",
            name: "Model X",
            provider: "test",
            input: ["text"],
            contextWindow: 1000,
            serviceTiers: tier.serviceTiers,
          },
          session: {
            ...state.rpc[TAB]!.session!,
            fastModeEnabled: enabled,
            fastModeActive: active,
          },
        },
      },
    }));
  };

  const renderWide = (): HTMLElement => {
    desktop();
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    return host;
  };

  it("hides the chip when fast mode is neither enabled nor active", () => {
    seedFast(false, false);
    const host = renderWide();
    expect(host.textContent).not.toContain("fast");
  });

  it("shows the signal chip when only active is true (Fireworks provider tier)", () => {
    seedFast(false, true);
    const host = renderWide();
    const chip = host.querySelector<HTMLButtonElement>(
      'button[aria-label="fast mode active — priority serving live · click to turn off"]',
    )!;
    expect(chip).not.toBeNull();
    expect(chip.querySelector("span")?.classList.contains("bg-signal")).toBe(true);
  });

  it("shows the copper declined chip when the setting is on but the provider refused", () => {
    seedFast(true, false);
    const host = renderWide();
    const chip = host.querySelector<HTMLButtonElement>(
      'button[aria-label="fast mode enabled but the provider declined it · click to retry"]',
    )!;
    expect(chip).not.toBeNull();
    expect(chip.querySelector("span")?.classList.contains("bg-copper")).toBe(true);
  });

  it("a chip click sends set_fast_mode with the toggled setting", () => {
    const setFastMode = vi.fn(async () => {});
    useStore.setState({ setFastMode });
    seedFast(true, true);
    const host = renderWide();
    const chip = host.querySelector<HTMLButtonElement>(
      'button[aria-label="fast mode active — priority serving live · click to turn off"]',
    )!;
    act(() => chip.click());
    expect(setFastMode).toHaveBeenCalledWith(TAB, false);
  });

  it("the modes popover row carries the always-available switch", () => {
    const setFastMode = vi.fn(async () => {});
    useStore.setState({ setFastMode });
    seedFast(false, false);
    const host = renderWide();
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="queue modes and retry"]')!;
    act(() => trigger.click());
    const sw = document.body.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="fast mode"]',
    )!;
    expect(sw).not.toBeNull();
    expect(sw.getAttribute("role")).toBe("switch");
    expect(sw.getAttribute("title")).toBe("fast mode off · click to enable priority serving");
    act(() => sw.click());
    expect(setFastMode).toHaveBeenCalledWith(TAB, true);
  });

  it("the modes popover offers the ultrafast capsule instead of a switch", async () => {
    const setServiceTier = vi.fn(async () => {});
    useStore.setState({ setServiceTier });
    seedFast(false, false, { serviceTiers: ["priority", "ultrafast"], serviceTier: null });
    const host = renderWide();
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="queue modes and retry"]')!;
    act(() => trigger.click());
    const group = document.body.querySelector('[role="group"][aria-label="fast mode"]')!;
    expect(group).not.toBeNull();
    expect(document.body.querySelector('[role="switch"][aria-label="fast mode"]')).toBeNull();
    const choices = [...group.querySelectorAll<HTMLButtonElement>("button")];
    expect(choices.map((button) => button.textContent)).toEqual([
      t("hud.fast.tierOff"),
      t("hud.fast.tierPriority"),
      t("hud.fast.tierUltrafast"),
    ]);
    expect(choices[0]!.getAttribute("aria-pressed")).toBe("true");
    await act(async () => choices[2]!.click());
    expect(setServiceTier).toHaveBeenCalledWith(TAB, "ultrafast");
  });

  it("titles an active ultrafast chip with the ultrafast serving tooltip", () => {
    seedFast(true, true, { serviceTiers: ["priority", "ultrafast"], serviceTier: "ultrafast" });
    const host = renderWide();
    const chip = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === t("hud.fast.label"))!;
    expect(chip).toBeDefined();
    expect(chip.getAttribute("aria-label")).toBe(t("hud.fast.ultraTitle"));
  });

  it("titles a declined ultrafast chip with the declined tooltip", () => {
    seedFast(true, false, { serviceTiers: ["priority", "ultrafast"], serviceTier: "ultrafast" });
    const host = renderWide();
    const chip = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .find((button) => button.textContent?.trim() === t("hud.fast.label"))!;
    expect(chip).toBeDefined();
    expect(chip.getAttribute("aria-label")).toBe(t("hud.fast.declinedTitle"));
  });
});

describe("SessionHud slow mode chip (issue #777)", () => {
  const desktop = (): void => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
  };

  /** A capabilities snapshot whose only relevant field is the version. */
  const gate = (ompVersion: string | null): CapabilitySnapshot => ({
    version: 1 as const,
    processKey: "p",
    sessionId: null,
    revision: 1,
    updatedAt: 0,
    ompVersion,
    skillCommandsEnabled: null,
    skills: { status: "unavailable", reason: "missing-api" },
    tools: { status: "unavailable", reason: "missing-api" },
    magicKeywords: { status: "available", items: [] },
    toolControl: "unsupported",
    toolMutation: null,
  });

  const seedSlow = (fields: Partial<SessionRuntime>, ompVersion: string | null = "18.7.0"): void => {
    useStore.setState((s) => ({
      rpc: {
        ...s.rpc,
        [TAB]: {
          ...s.rpc[TAB]!,
          capabilities: gate(ompVersion),
          session: { ...s.rpc[TAB]!.session!, ...fields },
        },
      },
    }));
  };

  const renderWide = (): HTMLElement => {
    desktop();
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    return host;
  };

  it("hides the chip when slow mode is off", () => {
    seedSlow({ slowModeSupported: true, slowModeEnabled: false });
    expect(renderWide().textContent).not.toContain(t("hud.slow.label"));
  });

  it("hides the chip on an unsupported model even while enabled", () => {
    seedSlow({ slowModeSupported: false, slowModeEnabled: true });
    expect(renderWide().textContent).not.toContain(t("hud.slow.label"));
  });

  it("hides the chip below omp 18.6.3 even when the flag says supported", () => {
    seedSlow({ slowModeSupported: true, slowModeEnabled: true }, "18.4.11");
    expect(renderWide().textContent).not.toContain(t("hud.slow.label"));
  });

  it("shows the capsule when enabled on a supported model, and a click disables", () => {
    const setSlowMode = vi.fn(async () => {});
    useStore.setState({ setSlowMode });
    seedSlow({ slowModeSupported: true, slowModeEnabled: true, slowModeScope: "session" });
    const host = renderWide();
    const chip = host.querySelector<HTMLButtonElement>(
      `button[aria-label="${t("hud.slow.onTitle")} · ${t("hud.slow.scopeSessionTitle")}"]`,
    )!;
    expect(chip).not.toBeNull();
    act(() => chip.click());
    expect(setSlowMode).toHaveBeenCalledWith(TAB, false);
  });

  it("the modes popover row carries the always-available switch", () => {
    const setSlowMode = vi.fn(async () => {});
    useStore.setState({ setSlowMode });
    seedSlow({ slowModeSupported: true, slowModeEnabled: false });
    const host = renderWide();
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="queue modes and retry"]')!;
    act(() => trigger.click());
    const sw = document.body.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="slow mode"]',
    )!;
    expect(sw).not.toBeNull();
    expect(sw.getAttribute("title")).toBe(t("hud.slow.offTitle"));
    act(() => sw.click());
    expect(setSlowMode).toHaveBeenCalledWith(TAB, true);
  });

  it("hides the popover switch below the gate", () => {
    seedSlow({ slowModeSupported: true, slowModeEnabled: false }, "18.4.11");
    const host = renderWide();
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="queue modes and retry"]')!;
    act(() => trigger.click());
    expect(
      document.body.querySelector('button[role="switch"][aria-label="slow mode"]'),
    ).toBeNull();
  });
});

describe("SessionHud usage-limit chip (issue #777)", () => {
  const desktop = (): void => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
  };

  const seedLimit = (limit: SessionRuntime["usageLimit"]): void => {
    useStore.setState((s) => ({
      rpc: {
        ...s.rpc,
        [TAB]: {
          ...s.rpc[TAB]!,
          session: { ...s.rpc[TAB]!.session!, usageLimit: limit },
        },
      },
    }));
  };

  const renderWide = (): HTMLElement => {
    desktop();
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    return host;
  };

  it("renders no chip while no stage is reported", () => {
    seedLimit(null);
    const host = renderWide();
    expect(host.textContent).not.toContain(t("hud.limits.wrapUp"));
    expect(host.textContent).not.toContain(t("hud.limits.lowPriority"));
  });

  it("names the wrap-up stage in rose with its reset time", () => {
    const at = Date.now() + 60 * 60 * 1000;
    seedLimit({ stage: "wrap_up", resetsAtMs: at, extraUsage: false });
    const host = renderWide();
    const chip = [...host.querySelectorAll<HTMLElement>("span")]
      .find((span) => span.className.includes("bg-rose-wash"))!;
    expect(chip).toBeDefined();
    expect(chip.textContent).toContain(t("hud.limits.wrapUp"));
    expect(chip.getAttribute("title")).toContain(
      t("hud.limits.resetAt", { at: new Date(at).toLocaleString(localeTag()) }),
    );
    expect(chip.getAttribute("title")).toContain(t("hud.limits.extraUsageOff"));
  });

  it("names the low-priority stage in copper with the allowance", () => {
    seedLimit({ stage: "low_priority", resetsAtMs: null, allowanceLeftPercent: 4 });
    const host = renderWide();
    const chip = [...host.querySelectorAll<HTMLElement>("span")]
      .find((span) => span.className.includes("bg-copper-wash"))!;
    expect(chip).toBeDefined();
    expect(chip.textContent).toContain(t("hud.limits.lowPriority"));
    // No reset time: the tooltip carries the allowance line alone.
    expect(chip.getAttribute("title")).toBe(t("hud.limits.allowance", { percent: 4 }));
  });
});


describe("SessionHud approval mode control (issue #681)", () => {
  const desktop = (): void => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
  };

  const seedApproval = (mode: "always-ask" | "write" | "yolo" | null): void => {
    useStore.setState((s) => ({
      state: {
        ...s.state!,
        projects: s.state!.projects.map((group) => ({
          ...group,
          sessions: group.sessions.map((rec) =>
            rec.tabId === TAB ? { ...rec, approvalMode: mode, serviceTier: null } : rec,
          ),
        })),
      },
    }));
  };

  const renderWide = (): HTMLElement => {
    desktop();
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    return host;
  };

  it("renders no chip while the session inherits omp's config", () => {
    seedApproval(null);
    const host = renderWide();
    expect(host.querySelector('[title*="approval mode pinned"]')).toBeNull();
  });

  it("shows a chip naming the pinned tier", () => {
    seedApproval("write");
    const host = renderWide();
    expect(
      host.querySelector('[title="approval mode pinned to write · change it under session modes"]'),
    ).not.toBeNull();
  });

  it("the modes popover row offers inherit plus the tiers and calls the setter", () => {
    const setSessionApprovalMode = vi.fn(async () => {});
    useStore.setState({ setSessionApprovalMode });
    seedApproval("write");
    const host = renderWide();
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="queue modes and retry"]')!;
    act(() => trigger.click());
    const pick = (label: string): HTMLButtonElement => {
      const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
        (b) => b.textContent === label,
      );
      if (!found) throw new Error(`no "${label}" choice`);
      return found;
    };
    act(() => pick("yolo").click());
    expect(setSessionApprovalMode).toHaveBeenCalledWith(TAB, "yolo");
    act(() => pick("inherit").click());
    expect(setSessionApprovalMode).toHaveBeenCalledWith(TAB, null);
    expect(pick("always-ask").title).toContain("every tool waits");
  });

  it("shows the resolved omp value while inheriting", async () => {
    readOmpSettings.mockResolvedValueOnce({
      entries: [
        {
          key: "tools.approvalMode",
          type: "enum",
          description: "",
          value: "always-ask",
          globalValue: "always-ask",
          options: null,
          layer: "global",
        },
      ],
      agentDir: null,
      projectConfigPath: null,
      error: null,
    });
    seedApproval(null);
    const host = renderWide();
    const trigger = host.querySelector<HTMLButtonElement>('button[aria-label="queue modes and retry"]')!;
    act(() => trigger.click());
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.body.textContent).toContain("omp resolves: always-ask");
  });
});