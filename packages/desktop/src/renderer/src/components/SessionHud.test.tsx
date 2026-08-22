// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySessionRuntime } from "../lib/rpc-types";
import { backendState, rpcTabState } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(window, { ompBackend: {} });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { SessionHud } = await import("./SessionHud");

const TAB = "tab-mobile";
const BUILD_MODE_TOOLTIP = "Build mode — working-tree writes and state-changing commands are allowed";
const PLAN_MODE_TOOLTIP_WITH_PATH = "Plan mode — read-only exploration — /plan.md";
const PLAN_MODE_TOOLTIP_WITHOUT_PATH = "Plan mode — read-only exploration — no plan drafted";
const compactSession = vi.fn(async () => {});
const exportHtml = vi.fn(async () => {});
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
        lastAdvisorModel: null,
      },
      sessions: [
        {
          tabId: TAB,
          sessionId: "s",
          lineageDir: "lineage",
          projectCwd: "/p",
          launchedAt: "t",
          mode: "rpc-ui",
          advisor: false,
          advisorModel: null,
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
    compactSession, exportHtml, branchSession, newSession, toggleConsole,
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
    // Fail closed still holds with the panel portaled: inside mousedown keeps
    // it open, outside mousedown dismisses.
    const abort = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "abort retry")!;
    act(() => { abort.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
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
    act(() => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
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
    expect(newSession).toHaveBeenCalledWith("/p");
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
            contextWindow: 1000, contextTokens: 200, cost: 0.273, totalTokens: 320_000,
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
            contextWindow: 1000, contextTokens: 200, cost: 0.1, totalTokens: 0,
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
});

describe("compact Session HUD", () => {
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
    for (const label of ["build", "plan", "compact", "auto-compact", "export", "MCP", "branch", "new", "refresh", "steering", "follow-up", "interrupt", "auto-retry", "abort retry"]) {
      expect(document.body.textContent).toContain(label);
    }
    const compact = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "compact")!;
    const exportButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "export")!;
    const branch = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "branch")!;
    const fresh = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "new")!;
    act(() => { compact.click(); exportButton.click(); branch.click(); fresh.click(); });
    expect(compactSession).toHaveBeenCalledWith(TAB);
    expect(exportHtml).toHaveBeenCalledWith(TAB);
    expect(branchSession).toHaveBeenCalledWith(TAB);
    // #82: "new" runs the same spawn as /new and mod+shift+n, not an in-tab reset.
    expect(newSession).toHaveBeenCalledWith("/p");
  });

  it("shows session-tree advisor tokens and cost in the actions sheet", () => {
    useStore.setState({
      rpc: {
        [TAB]: {
          ...useStore.getState().rpc[TAB]!,
          advisorStats: {
            available: true, configured: true, active: false, model: "root/advisor", subscription: false,
            contextWindow: 200_000, contextTokens: 12_000, cost: 0.375, totalTokens: 456_000,
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
    expect(chip?.querySelector("span")?.className).not.toContain("animate-breathe");
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
    expect(span?.querySelector("span")?.className).not.toContain("animate-breathe");
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
