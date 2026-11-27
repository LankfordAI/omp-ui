// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { FleetGrantRaisePrompt } from "@omp-ui/core/types";
import { remoteOwnedState } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const answerGrantRaise = vi.fn<
  (tabId: string, promptId: string, decision: "allow" | "deny", secret: string | null) => Promise<{ ok: true } | { ok: false; reason: string }>
>(async () => ({ ok: true }));
Object.assign(window, { ompBackend: { answerGrantRaise } });
// Dynamic import: store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { GrantRaiseCard } = await import("./GrantRaiseCard");

const TAB = "tab-raise";
const RAISE: FleetGrantRaisePrompt = {
  promptId: "g1",
  machine: "box-b",
  rung: "manage",
  currentRung: "dispatch",
  requestedAt: "2026-11-27T00:00:00.000Z",
};

let root: Root | null = null;

function render(request: FleetGrantRaisePrompt | null): void {
  const state = remoteOwnedState(TAB, "inst-a");
  const session = state.remoteInstances[0]!.projects[0]!.sessions[0]!;
  state.remoteInstances[0]!.projects[0]!.sessions[0] = { ...session, grantRaiseRequest: request };
  useStore.setState({ state });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<GrantRaiseCard tabId={TAB} />));
}

const card = (): Element | null => document.querySelector("[data-grant-raise-card]");
const secretInput = (): HTMLInputElement => {
  const found = document.querySelector("[data-grant-raise-secret]");
  if (!(found instanceof HTMLInputElement)) throw new Error("no secret input");
  return found;
};
function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`no "${label}" button`);
  return found as HTMLButtonElement;
}

function typeSecret(value: string): void {
  const input = secretInput();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  answerGrantRaise.mockClear();
});

describe("GrantRaiseCard (#1393)", () => {
  it("renders nothing without a pending raise", () => {
    render(null);
    expect(card()).toBeNull();
  });

  it("renders the member, current → requested rungs, and the secret field", () => {
    render(RAISE);
    const text = card()!.textContent!;
    expect(text).toContain("box-b");
    expect(text).toContain("Dispatch");
    expect(text).toContain("Manage projects");
    expect(secretInput().type).toBe("password");
  });

  it("Grant is disabled until the secret is non-empty; allow posts the typed secret", async () => {
    render(RAISE);
    expect(button("Grant").disabled).toBe(true);
    typeSecret("  s3cret  ");
    expect(button("Grant").disabled).toBe(false);
    await act(async () => button("Grant").click());
    expect(answerGrantRaise).toHaveBeenLastCalledWith(TAB, "g1", "allow", "  s3cret  ");
  });

  it("deny posts a null secret", async () => {
    render(RAISE);
    typeSecret("s3cret");
    await act(async () => button("Don't grant").click());
    expect(answerGrantRaise).toHaveBeenLastCalledWith(TAB, "g1", "deny", null);
  });

  it("shows a refusal reason inline", async () => {
    answerGrantRaise.mockResolvedValueOnce({
      ok: false,
      reason: "type the member's password or access token to grant",
    });
    render(RAISE);
    typeSecret("s3cret");
    await act(async () => button("Grant").click());
    expect(card()!.querySelector("[role=alert]")?.textContent).toBe(
      "type the member's password or access token to grant",
    );
  });
});
