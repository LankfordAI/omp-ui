// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@omp-ui/core/types";
import type { ModelInfo } from "../lib/rpc-types";
import { backendState, rpcTabState, tabInfo } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const advisorConfig = vi.hoisted(() => ({ enabled: false, model: null as string | null }));

const backendMock = {
  getAdvisorDefaults: vi.fn(async () => advisorConfig),
  setSessionAdvisor: vi.fn(async () => {}),
  setProjectDefaultAdvisorModel: vi.fn(async () => {}),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic import: store.ts reads window.ompBackend at module load.
const { useStore } = await import("../store");
const { AdvisorControl } = await import("./AdvisorControl");

const TAB = "tab-gate-1";
const PIN = "p/advisor-a";
const GATE = "gate/gaterati:low";

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

const advisorA: ModelInfo = { id: "advisor-a", name: "Advisor A", provider: "p" };
const gatedCatalog: ModelInfo = {
  id: "gaterati",
  name: "Gaterati",
  provider: "gate",
  thinking: { efforts: ["low", "high"] },
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
    advisor: true,
    advisorModel: PIN,
    cachedTitle: "Gated session",
    cachedModified: "t",
    title: "Gated session",
    status: null,
    live: "live",
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
    ...patch,
  };
}

function seed(opts: {
  gate?: string | null;
  models?: ModelInfo[];
  recordPatch?: Partial<SessionSummary>;
  defaultModel?: string | null;
} = {}): void {
  advisorConfig.enabled = false;
  advisorConfig.model = opts.defaultModel ?? null;
  useStore.setState({
    state: backendState({
      projects: [{ project: PROJECT, sessions: [record(opts.recordPatch ?? {})] }],
      spawnGate: { model: null, advisorModel: opts.gate ?? null },
    }),
    tabs: [tabInfo({ tabId: TAB, projectCwd: "/p" })],
    rpc: { [TAB]: rpcTabState({ availableModels: opts.models ?? [] }) },
    advisorDefaults: {},
  });
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<AdvisorControl tabId={TAB} />));
  // Mount's loadAdvisorDefaults hop has to land before the precedence reads it.
  await act(async () => {});
  await act(async () => {});
}

const buttons = (): HTMLButtonElement[] => [
  ...document.body.querySelectorAll<HTMLButtonElement>("button"),
];

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("advisor controls under a dev/test override (issue #372)", () => {
  it("the gate beats a non-null session pin and a configured default, with editing locked", async () => {
    seed({ gate: GATE, models: [advisorA, gatedCatalog], defaultModel: "d/defaulta" });
    await render();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Gaterati"); // the gated model is what the row says
    expect(text).not.toContain("Advisor A"); // the pin is not the effective model
    expect(text).toContain("dev/test"); // the compact source label is visible

    const modelChip = buttons().find((b) =>
      b.title.startsWith("Dev/test advisor override"),
    )!;
    expect(modelChip.disabled).toBe(true);
    // A programmatic click must not open the palette or persist anything.
    await act(async () => {
      modelChip.click();
    });
    expect(backendMock.setSessionAdvisor).not.toHaveBeenCalled();

    // On/off stays usable and persists the SAVED selector, never the gate.
    const toggle = buttons().find((b) => b.getAttribute("aria-pressed") !== null)!;
    await act(async () => {
      toggle.click();
    });
    expect(backendMock.setSessionAdvisor).toHaveBeenCalledWith(TAB, false, PIN);
  });

  it("a gated effort stays visible and read-only without a model catalog", async () => {
    seed({ gate: GATE, models: [] });
    await render();

    const text = document.body.textContent ?? "";
    expect(text).toContain("gaterati"); // catalog-miss fallback: selector tail
    const effort = buttons().find((b) => b.textContent === "low");
    expect(effort).toBeDefined();
    expect(effort!.disabled).toBe(true);
  });

  it("a gated selector without an effort shows no effort value", async () => {
    seed({ gate: "gate/gaterati", models: [gatedCatalog] });
    await render();
    // Not the stored level, not the ungated fallback — the gated value simply
    // has no effort, and the row must not imply one.
    expect(document.body.textContent ?? "").not.toContain("low");
    expect(document.body.textContent ?? "").not.toContain("think —");
  });

  it("an off advisor under the gate shows provenance without claiming a running model", async () => {
    seed({ gate: GATE, models: [gatedCatalog], recordPatch: { advisor: false } });
    await render();

    const text = document.body.textContent ?? "";
    expect(text).toContain("dev/test");
    const toggle = buttons().find((b) => b.getAttribute("aria-pressed") !== null)!;
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.title).toContain("When the advisor is enabled");
    await act(async () => {
      toggle.click();
    });
    expect(backendMock.setSessionAdvisor).toHaveBeenCalledWith(TAB, true, PIN);
  });

  it("a dormant record's tooltip promises the override on resume, not in place", async () => {
    seed({ gate: GATE, models: [gatedCatalog], recordPatch: { live: "dormant" } });
    await render();
    const toggle = buttons().find((b) => b.getAttribute("aria-pressed") !== null)!;
    expect(toggle.title).toContain("On resume");
  });

  it("ungated controls keep their saved-choice behavior", async () => {
    seed({ gate: null, models: [advisorA, gatedCatalog] });
    await render();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Advisor A");
    expect(text).not.toContain("dev/test");
    const modelChip = buttons().find((b) => b.textContent?.includes("Advisor A"))!;
    expect(modelChip.disabled).toBe(false);
  });
});
