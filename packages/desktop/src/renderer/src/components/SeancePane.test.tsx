// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilitySnapshot } from "@omp-ui/core/capabilities";
import { t } from "../lib/i18n";
import { SEANCE_MIN_OMP } from "../lib/seance";
import { rpcTabState } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const backendMock = {
  rpcSend: vi.fn(),
};
Object.assign(window, { ompBackend: backendMock });

// Dynamic imports are required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { SeancePane } = await import("./SeancePane");

const TAB = "tab-seance";
const PROJECT = "/projects/alpha";
let root: Root | null = null;

/** A capability snapshot with only the version gate material for this pane. */
function cap(ompVersion: string | null): CapabilitySnapshot {
  return {
    version: 1,
    processKey: "p",
    sessionId: null,
    revision: 1,
    updatedAt: 0,
    ompVersion,
    skillCommandsEnabled: null,
    skills: { status: "unavailable", reason: "missing-api" },
    tools: { status: "unavailable", reason: "missing-api" },
    magicKeywords: { status: "unavailable", reason: "missing-api" },
    toolControl: "unsupported",
    toolMutation: null,
  };
}

function renderPane(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<SeancePane tabId={TAB} />));
}

function button(label: string): HTMLButtonElement | null {
  return [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (b) => b.getAttribute("aria-label") === label || b.textContent === label,
  ) ?? null;
}

async function typeFollowUp(text: string): Promise<void> {
  const input = document.body.querySelector<HTMLInputElement>(
    `input[aria-label="${t("rail.seance.followUpPlaceholder")}"]`,
  )!;
  const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setValue.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  useStore.setState({
    tabs: [{ tabId: TAB, mode: "rpc-ui", projectCwd: PROJECT, hidden: false, instanceId: null }],
    rpc: { [TAB]: rpcTabState({ capabilities: cap("18.11.3") }) },
    seanceDialog: null,
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("SeancePane (issue #885)", () => {
  it("renders only the seance roster rows", () => {
    useStore.setState({
      rpc: {
        [TAB]: rpcTabState({
          capabilities: cap("18.11.3"),
          subagents: [
            { id: "s-1", agent: "seance", label: "consult A", status: "running" },
            { id: "t-1", name: "worker", agent: "task", status: "running" },
            { id: "s-2", agent: "seance", name: "consult-B", status: "completed" },
          ],
        }),
      },
    });
    renderPane();
    expect(document.body.textContent).toContain("consult A");
    // An id-named row falls back to name, then id (label ?? name ?? id).
    expect(document.body.textContent).toContain("consult-B");
    expect(document.body.textContent).not.toContain("worker");
    expect(document.body.textContent).not.toContain("t-1");
  });

  it("a running consult offers a follow-up box; submitting steers the consultant", async () => {
    const steerSubagent = vi.fn(async (): Promise<void> => {});
    useStore.setState({
      steerSubagent,
      rpc: {
        [TAB]: rpcTabState({
          capabilities: cap("18.11.3"),
          subagents: [{ id: "s-1", agent: "seance", label: "consult A", status: "running" }],
        }),
      },
    });
    renderPane();
    await typeFollowUp("  what did it decide?  ");
    const send = button(t("rail.seance.followUp"))!;
    act(() => send.click());
    expect(steerSubagent).toHaveBeenCalledWith(TAB, "s-1", "what did it decide?");
  });

  it("the follow-up dispatch is disabled while a verb is in flight", () => {
    useStore.setState({
      rpc: {
        [TAB]: rpcTabState({
          capabilities: cap("18.11.3"),
          subagents: [{ id: "s-1", agent: "seance", label: "consult A", status: "running" }],
          subagentControlBusy: { "s-1": "steer" },
        }),
      },
    });
    renderPane();
    expect(
      document.body.querySelector<HTMLInputElement>(
        `input[aria-label="${t("rail.seance.followUpPlaceholder")}"]`,
      )?.disabled,
    ).toBe(true);
  });

  it("a settled row has no follow-up box; ask again opens the dialog for this tab", () => {
    useStore.setState({
      rpc: {
        [TAB]: rpcTabState({
          capabilities: cap("18.11.3"),
          subagents: [{ id: "s-9", agent: "seance", label: "done consult", status: "completed" }],
        }),
      },
    });
    renderPane();
    expect(document.body.textContent).toContain(t("rail.seance.settledNote"));
    expect(
      document.body.querySelector<HTMLInputElement>(`input[aria-label="${t("rail.seance.followUpPlaceholder")}"]`),
    ).toBeNull();
    act(() => button(t("rail.seance.askAgain"))!.click());
    expect(useStore.getState().seanceDialog).toEqual({
      projectCwd: PROJECT,
      instanceId: null,
      sourceTabId: TAB,
    });
  });

  it("the header button opens the dialog; a row toggle opens and closes the transcript", () => {
    const openSubagent = vi.fn();
    const closeSubagent = vi.fn();
    useStore.setState({
      openSubagent,
      closeSubagent,
      rpc: {
        [TAB]: rpcTabState({
          capabilities: cap("18.11.3"),
          subagents: [{ id: "s-1", agent: "seance", label: "consult A", status: "running" }],
        }),
      },
    });
    renderPane();
    act(() => button(t("rail.seance.newConsult"))!.click());
    expect(useStore.getState().seanceDialog).toEqual({
      projectCwd: PROJECT,
      instanceId: null,
      sourceTabId: TAB,
    });
    useStore.setState({ seanceDialog: null });
    act(() => button(t("rail.seance.openTranscript"))!.click());
    expect(openSubagent).toHaveBeenCalledWith(TAB, "s-1");
    act(() =>
      useStore.setState({
        rpc: { [TAB]: rpcTabState({ capabilities: cap("18.11.3"), selectedSubagent: "s-1", subagents: [{ id: "s-1", agent: "seance", label: "consult A", status: "running" }] }) },
      }),
    );
    act(() => button(t("rail.seance.openTranscript"))!.click());
    expect(closeSubagent).toHaveBeenCalledWith(TAB);
  });

  it("shows the empty state with a working new-consult button", () => {
    renderPane();
    expect(document.body.textContent).toContain(t("rail.seance.emptyTitle"));
    expect(document.body.textContent).toContain(t("rail.seance.emptyHint"));
    act(() => button(t("rail.seance.newConsult"))!.click());
    expect(useStore.getState().seanceDialog).not.toBeNull();
  });

  it("below the version floor it names the requirement and offers no launch", () => {
    useStore.setState({
      rpc: {
        [TAB]: rpcTabState({
          capabilities: cap("18.11.2"),
          subagents: [{ id: "s-1", agent: "seance", label: "consult A", status: "running" }],
        }),
      },
    });
    renderPane();
    expect(document.body.textContent).toContain(t("rail.seance.needsNewerOmp", { version: SEANCE_MIN_OMP }));
    // Nothing dispatches: no launch control at all, and no row chrome.
    expect(button(t("rail.seance.newConsult"))).toBeNull();
    expect(document.body.textContent).not.toContain("consult A");
  });

  it("an unknown version gates the same way", () => {
    useStore.setState({ rpc: { [TAB]: rpcTabState({ capabilities: null }) } });
    renderPane();
    expect(document.body.textContent).toContain(t("rail.seance.needsNewerOmp", { version: SEANCE_MIN_OMP }));
  });
});
