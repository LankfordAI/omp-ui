// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectRequestPrompt } from "@omp-ui/core/types";
import { remoteOwnedState } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const answerProjectRequest = vi.fn<
  (tabId: string, promptId: string, decision: "allow" | "deny", parent: string | null) => Promise<{ ok: true } | { ok: false; reason: string }>
>(async () => ({ ok: true }));
Object.assign(window, { ompBackend: { answerProjectRequest } });
// Dynamic import: store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { ProjectRequestCard } = await import("./ProjectRequestCard");

const TAB = "tab-request";
const REGISTER: ProjectRequestPrompt = {
  promptId: "p1",
  verb: "register",
  source: "/srv/repos/app",
  name: null,
  defaultParent: null,
  origin: "git@github.com:acme/app.git",
  executableConfig: [".omp/extensions", ".env"],
  requestedAt: "2026-11-18T00:00:00.000Z",
};
const CLONE: ProjectRequestPrompt = {
  ...REGISTER,
  promptId: "p2",
  verb: "clone",
  source: "https://github.com/acme/app",
  name: "app",
  defaultParent: "/srv/repos",
  origin: null,
  executableConfig: [],
};

let root: Root | null = null;

function render(request: ProjectRequestPrompt): void {
  const state = remoteOwnedState(TAB, "inst-a");
  const session = state.remoteInstances[0]!.projects[0]!.sessions[0]!;
  state.remoteInstances[0]!.projects[0]!.sessions[0] = { ...session, projectRequest: request };
  useStore.setState({ state });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<ProjectRequestCard tabId={TAB} />));
}

const card = (): Element | null => document.querySelector("[data-project-request-card]");
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`no "${label}" button`);
  return found as HTMLButtonElement;
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  answerProjectRequest.mockClear();
});

describe("ProjectRequestCard (#1228)", () => {
  it("renders the folder, origin, warning, and Found list for a register", () => {
    render(REGISTER);
    const text = card()!.textContent!;
    expect(text).toContain("Add project");
    expect(text).toContain("Folder: /srv/repos/app");
    expect(text).toContain("Origin: git@github.com:acme/app.git");
    expect(text).toContain("provider keys");
    expect(text).toContain("Found: .omp/extensions, .env");
  });

  it("renders the repository and default destination for a clone", () => {
    render(CLONE);
    const text = card()!.textContent!;
    expect(text).toContain("Clone and add project");
    expect(text).toContain("Repository: https://github.com/acme/app");
    expect(text).toContain("Save to: /srv/repos/app");
    expect(document.querySelector("[data-project-request-found]")).toBeNull();
  });

  it("Allow sends the default parent as null, and Escape sends deny", async () => {
    render(CLONE);
    await act(async () => button("Allow").click());
    expect(answerProjectRequest).toHaveBeenLastCalledWith(TAB, "p2", "allow", null);
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(answerProjectRequest).toHaveBeenLastCalledWith(TAB, "p2", "deny", null);
  });

  it("shows a refusal reason inline", async () => {
    answerProjectRequest.mockResolvedValueOnce({ ok: false, reason: "/srv/repos/app already exists" });
    render(CLONE);
    await act(async () => button("Allow").click());
    expect(card()!.querySelector("[role=alert]")?.textContent).toBe("/srv/repos/app already exists");
  });
});
