// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySessionRuntime } from "../lib/rpc-types";
import type { RpcTabState } from "../store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const rpcSend = vi.fn();
Object.assign(window, { ompBackend: { rpcSend } });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { ExtensionDialogHost } = await import("./ExtensionDialogHost");

const TAB = "tab-question";
let root: Root | null = null;

function runtime(queue: unknown[]): RpcTabState {
  return { status: "ready", items: [], todos: [], model: null, availableModels: [], commands: [],
    session: emptySessionRuntime(), stats: null, subagents: [], extensionStatus: {}, pendingCommands: new Map(),
    extensionQueue: queue, busy: false, initialPrompt: null, hasRenamed: true, plan: null, planReview: null,
    planText: null, planDeferred: false, plans: [], advisorStats: null };
}

function renderRequest(...queue: unknown[]): void {
  useStore.setState({ rpc: { [TAB]: runtime(queue) } });
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root!.render(<ExtensionDialogHost tabId={TAB} />));
}

function lastFrame(): Record<string, unknown> {
  return rpcSend.mock.calls.at(-1)![1] as Record<string, unknown>;
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
  rpcSend.mockClear();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("compact ExtensionDialogHost", () => {
  it("answers confirm and select with their unchanged payloads", () => {
    renderRequest({ id: "c", method: "confirm", title: "Confirm?" });
    const button = (text: string) => [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === text)!;
    act(() => button("confirm").click());
    expect(lastFrame()).toMatchObject({ id: "c", confirmed: true });

    act(() => root!.unmount()); root = null; document.body.replaceChildren();
    renderRequest({ id: "s", method: "select", title: "Pick", options: ["Alpha", "Beta"] });
    act(() => button("Beta").click());
    expect(lastFrame()).toMatchObject({ id: "s", value: "Beta" });
  });

  it.each(["input", "editor"])("submits %s values", (method) => {
    renderRequest({ id: method, method, title: "Answer", message: "Value" });
    const field = document.body.querySelector<HTMLInputElement | HTMLTextAreaElement>(method === "input" ? "input" : "textarea")!;
    const proto = method === "input" ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
    act(() => { setter.call(field, "typed value"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    const submit = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === "submit")!;
    act(() => submit.click());
    expect(lastFrame()).toMatchObject({ id: method, value: "typed value" });
  });

  it("shows empty select and queue count, then cancels on Escape", () => {
    renderRequest(
      { id: "empty", method: "select", title: "Nothing", options: [] },
      { id: "next", method: "confirm", title: "Next" },
    );
    expect(document.body.textContent).toContain("No choices are available");
    expect(document.body.textContent).toContain("1 more");
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(lastFrame()).toMatchObject({ id: "empty", cancelled: true });
  });

  it("restores prior composer focus when the request queue completes", () => {
    const composer = document.createElement("textarea"); document.body.append(composer); composer.focus();
    renderRequest({ id: "cancel", method: "select", title: "Empty", options: [] });
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(lastFrame()).toMatchObject({ id: "cancel", cancelled: true });
    expect(document.activeElement).toBe(composer);
  });

  it("reconstructs and completes the multi-select loop", () => {
    renderRequest({ id: "m1", method: "select", title: "Which?", options: ["Alpha", "Beta"] });
    const alpha = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === "Alpha")!;
    act(() => alpha.click());
    expect(lastFrame()).toMatchObject({ value: "Alpha" });
    act(() => useStore.setState({ rpc: { [TAB]: runtime([{ id: "m2", method: "select", title: "(1 selected) Which?", options: ["Alpha", "Beta", "✔ Done selecting"] }]) } }));
    const done = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === "done selecting")!;
    act(() => done.click());
    expect(lastFrame()).toMatchObject({ id: "m2", value: "✔ Done selecting" });
  });
});
