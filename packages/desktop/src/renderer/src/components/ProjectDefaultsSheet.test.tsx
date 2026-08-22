// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRecord } from "@omp-ui/core/types";
import { backendState } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();

const backendMock = {
  getAdvisorDefaults: vi.fn(async () => ({ enabled: false, model: "omp/advisor" })),
  setProjectDefaultModel: vi.fn(async () => {}),
  setProjectDefaultAdvisorModel: vi.fn(async () => {}),
};
Object.assign(window, { ompBackend: backendMock });

const { useStore } = await import("../store");
const { ProjectDefaultsSheet } = await import("./ProjectDefaultsSheet");

const project: ProjectRecord = {
  path: "/p",
  name: "Project",
  addedAt: "t",
  lastModel: "last/main",
  lastAdvisor: false,
  lastAdvisorModel: "last/advisor",
  defaultModel: "pin/main",
  defaultAdvisorModel: "pin/advisor:high",
};

let root: Root | null = null;

function renderSheet(value: ProjectRecord = project): void {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<ProjectDefaultsSheet project={value} onClose={vi.fn()} />));
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

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({
    state: backendState({
      defaultAdvisor: false,
      projects: [{ project, sessions: [] }],
    }),
    rpc: {},
    advisorDefaults: { "/p": { enabled: false, model: "omp/advisor" } },
  });
});

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("ProjectDefaultsSheet", () => {
  it("renders both pins and explains a dormant advisor pin", () => {
    renderSheet();

    expect(document.body.textContent).toContain("Default model");
    expect(document.body.textContent).toContain("pin/main");
    expect(document.body.textContent).toContain("Default advisor model");
    expect(document.body.textContent).toContain("pin/advisor:high");
    expect(document.body.textContent).toContain("The advisor starts off for new sessions");
    expect(buttons("Clear")).toHaveLength(2);
  });

  it("clears each pin through its project action", async () => {
    renderSheet();

    await act(async () => buttons("Clear")[0]!.click());
    expect(backendMock.setProjectDefaultModel).toHaveBeenCalledWith("/p", null);

    await act(async () => buttons("Clear")[1]!.click());
    expect(backendMock.setProjectDefaultAdvisorModel).toHaveBeenCalledWith("/p", null);
  });

  it("validates a typed main selector, then saves the valid value", async () => {
    renderSheet({ ...project, defaultModel: null });

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
      "/p",
      "provider/model-id",
    );
  });

  it("treats an empty typed advisor selector as clearing the pin", async () => {
    renderSheet({ ...project, defaultAdvisorModel: null });

    await act(async () => buttons("Change")[1]!.click());
    const input = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="Default advisor model"]',
    )!;
    await type(input, "   ");
    await act(async () => button("Set").click());

    expect(backendMock.setProjectDefaultAdvisorModel).toHaveBeenCalledWith("/p", null);
  });
});
