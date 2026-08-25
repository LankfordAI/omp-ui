// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerEntry, McpServersResult, ProjectRecord } from "@omp-ui/core/types";
import { backendState } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();

// store.ts and backend.ts capture the preload bridge at module load, so
// install the mock before dynamically importing either.
const backendMock = {
  getMcpServers: vi.fn(),
  setMcpServerEnabled: vi.fn(),
  getAdvisorDefaults: vi.fn(async () => ({ enabled: false, model: "omp/advisor" })),
  setProjectDefaultModel: vi.fn(async () => {}),
  setProjectDefaultAdvisorModel: vi.fn(async () => {}),
};
Object.assign(window, { ompBackend: backendMock });

const { useStore } = await import("../store");
const { ProjectSettings } = await import("./ProjectSettings");

const PROJECT = "/p";

const writableRow: McpServerEntry = {
  name: "native-one",
  transport: "stdio",
  endpoint: "native-bin --flag",
  source: "native",
  scope: "project",
  sourcePath: `${PROJECT}/.omp/mcp.json`,
  effective: true,
  state: "enabled",
  writable: true,
};

/** A live session in the fixture: the dialog must still pin no tab. */
const liveSessionState = backendState({
  defaultAdvisor: false,
  projects: [
    {
      project: {
        path: PROJECT,
        name: "Proj",
        addedAt: "t",
        lastModel: null,
        lastThinkingLevel: null,
        lastAdvisor: null,
        lastAdvisorModel: null,
        defaultModel: null,
        defaultAdvisorModel: null,
      },
      sessions: [
        {
          tabId: "tab-1",
          sessionId: "s1",
          lineageDir: "omp-ui--p--s1",
          projectCwd: PROJECT,
          launchedAt: "t",
          mode: "rpc-ui",
          worktree: null,
          planImplementationSource: null,
          agentMode: "build",
          compactionMethod: null,
          model: null,
          thinkingLevel: null,
          lastViewedAt: null,
          advisor: false,
          advisorModel: null,
          cachedTitle: "T",
          cachedModified: "t",
          title: "T",
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

const project: ProjectRecord = {
  path: PROJECT,
  name: "Project",
  addedAt: "t",
  lastModel: "last/main",
  lastThinkingLevel: null,
  lastAdvisor: false,
  lastAdvisorModel: "last/advisor",
  defaultModel: "pin/main",
  defaultAdvisorModel: "pin/advisor:high",
};

/** Mirrors App.tsx's mounting: the dialog exists only while the store says so. */
function Gate() {
  const projectSettings = useStore((s) => s.projectSettings);
  const closeProjectSettings = useStore((s) => s.closeProjectSettings);
  const state = useStore((s) => s.state);
  const resolved =
    projectSettings === null
      ? null
      : state?.projects.find((g) => g.project.path === projectSettings.projectCwd)?.project ?? null;
  return resolved !== null ? (
    <ProjectSettings project={resolved} onClose={closeProjectSettings} />
  ) : null;
}

let root: Root | null = null;

async function renderDialog(): Promise<void> {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<Gate />));
}

function button(text: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  expect(found).toBeDefined();
  return found!;
}

function buttons(text: string): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>("button")].filter(
    (candidate) => candidate.textContent?.trim() === text,
  );
}

function switchFor(label: string): HTMLButtonElement {
  const found = document.body.querySelector<HTMLButtonElement>(
    `button[role="switch"][aria-label="${label}"]`,
  );
  if (found === null) throw new Error(`switch not found: ${label}`);
  return found;
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  backendMock.getMcpServers.mockResolvedValue({ servers: [], errors: [] });
  backendMock.setMcpServerEnabled.mockResolvedValue({ servers: [], errors: [] });
  useStore.setState({
    mcpManager: null,
    projectSettings: { projectCwd: PROJECT },
    state: backendState({
      defaultAdvisor: false,
      projects: [{ project, sessions: [] }],
    }),
    rpc: {},
    advisorDefaults: { [PROJECT]: { enabled: false, model: "omp/advisor" } },
  });
});

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("ProjectSettings", () => {
  it("renders both sections for the project", async () => {
    await renderDialog();

    // Header carries the project identity.
    expect(document.body.textContent).toContain("Project settings");
    expect(document.body.textContent).toContain("Project");
    expect(document.body.textContent).toContain(PROJECT);

    // MCP section: the empty state resolves for this project.
    expect(backendMock.getMcpServers).toHaveBeenCalledWith(PROJECT);
    expect(document.body.textContent).toContain("No MCP servers configured for this project.");

    // Models section: both pins are visible.
    expect(document.body.textContent).toContain("Default model");
    expect(document.body.textContent).toContain("Default advisor model");
    expect(document.body.textContent).toContain("pin/main");
    expect(document.body.textContent).toContain("pin/advisor:high");
  });

  it("writes project-scoped toggles with no sourcePath", async () => {
    backendMock.getMcpServers.mockResolvedValue({
      servers: [writableRow],
      errors: [],
    } satisfies McpServersResult);
    backendMock.setMcpServerEnabled.mockImplementation(async (req: { name: string }) => ({
      servers: [writableRow].map((s) =>
        s.name === req.name ? { ...s, state: "disabled" as const, disabledBy: "config" as const } : s,
      ),
      errors: [],
    }));
    await renderDialog();

    await act(async () => {
      switchFor("disable native-one").click();
    });
    expect(backendMock.setMcpServerEnabled).toHaveBeenCalledWith({
      projectCwd: PROJECT,
      name: "native-one",
      sourcePath: undefined,
      enabled: false,
    });
    // The list refreshes from the toggle's returned result.
    expect(document.body.textContent).toContain("disabled · config");
  });

  it("offers no session-scoped affordances even with a live session", async () => {
    backendMock.getMcpServers.mockResolvedValue({
      servers: [writableRow],
      errors: [],
    } satisfies McpServersResult);
    useStore.setState({ state: liveSessionState });

    await renderDialog();

    // The dialog pins no tab: neither the restart button (McpManager footer)
    // nor the TUI-reauth handoff exist.
    expect(document.body.textContent).not.toContain("restart session to apply");
    expect(
      [...document.body.querySelectorAll<HTMLButtonElement>("button")].filter(
        (b) => b.textContent === "authenticate",
      ),
    ).toHaveLength(0);
  });

  it("renders both pins and explains a dormant advisor pin", async () => {
    await renderDialog();

    expect(document.body.textContent).toContain("Default model");
    expect(document.body.textContent).toContain("pin/main");
    expect(document.body.textContent).toContain("Default advisor model");
    expect(document.body.textContent).toContain("pin/advisor:high");
    expect(document.body.textContent).toContain("The advisor starts off for new sessions");
    expect(buttons("Clear")).toHaveLength(2);
  });

  it("clears each pin through its project action", async () => {
    await renderDialog();

    await act(async () => buttons("Clear")[0]!.click());
    expect(backendMock.setProjectDefaultModel).toHaveBeenCalledWith(PROJECT, null);

    await act(async () => buttons("Clear")[1]!.click());
    expect(backendMock.setProjectDefaultAdvisorModel).toHaveBeenCalledWith(PROJECT, null);
  });

  it("validates a typed main selector, then saves the valid value", async () => {
    useStore.setState({
      state: backendState({
        defaultAdvisor: false,
        projects: [{ project: { ...project, defaultModel: null }, sessions: [] }],
      }),
    });
    await renderDialog();

    await act(async () => buttons("Change")[0]!.click());
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="Default model"]')!;
    await type(input, "missing-provider");
    await act(async () => button("Set").click());
    expect(document.body.querySelector('[role="alert"]')?.textContent).toContain(
      "use provider/model-id",
    );
    expect(backendMock.setProjectDefaultModel).not.toHaveBeenCalled();

    await type(input, "provider/model-id");
    await act(async () => button("Set").click());
    expect(backendMock.setProjectDefaultModel).toHaveBeenCalledWith(
      PROJECT,
      "provider/model-id",
    );
  });

  it("treats an empty typed advisor selector as clearing the pin", async () => {
    useStore.setState({
      state: backendState({
        defaultAdvisor: false,
        projects: [{ project: { ...project, defaultAdvisorModel: null }, sessions: [] }],
      }),
    });
    await renderDialog();

    await act(async () => buttons("Change")[1]!.click());
    const input = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="Default advisor model"]',
    )!;
    await type(input, "   ");
    await act(async () => button("Set").click());

    expect(backendMock.setProjectDefaultAdvisorModel).toHaveBeenCalledWith(PROJECT, null);
  });

  it("unmounts when the project is removed while open", async () => {
    await renderDialog();
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    const state = useStore.getState().state!;
    act(() => useStore.setState({ state: { ...state, projects: [] } }));
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});