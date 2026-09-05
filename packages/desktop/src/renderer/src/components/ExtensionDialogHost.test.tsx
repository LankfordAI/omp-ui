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
const { ExtensionDialogHost, INITIAL_EXTENSION_DIALOG_STATE, reduceExtensionDialog } = await import("./ExtensionDialogHost");

const TAB = "tab-question";
let root: Root | null = null;

function runtime(queue: unknown[]): RpcTabState {
  return { status: "ready", items: [], todos: [], model: null, availableModels: [], commands: [],
    session: emptySessionRuntime(), stats: null, subagents: [], extensionStatus: {},
    extensionQueue: queue, busy: false, initialPrompt: null, autoTitleSent: null, hasRenamed: true,
    plan: null, planReview: null,
    planHtml: null, planText: null, planDeferred: false, plans: [], advisorStats: null, mcpStatus: null, advisorReply: true, capabilities: null, capabilitiesLoad: "idle" };
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

describe("reduceExtensionDialog", () => {
  it("purely carries a confirmed multi-select toggle into the next frame", () => {
    const initial = { ...INITIAL_EXTENSION_DIALOG_STATE, inputValue: "draft" };
    const first = reduceExtensionDialog(initial, {
      type: "request",
      current: { method: "select", title: "Tools? (1/2)" },
      method: "select",
    });
    const pending = reduceExtensionDialog(first, {
      type: "pick",
      pending: "Alpha",
    });
    const next = reduceExtensionDialog(pending, {
      type: "request",
      current: { method: "select", title: "(1 selected) Tools? (1/2)" },
      method: "select",
    });

    expect(initial.inputValue).toBe("draft");
    expect(first.inputValue).toBe("");
    expect(pending.lastSent).toBe("Alpha");
    expect(next.picked).toEqual(["Alpha"]);
    expect(next.lastSent).toBeNull();
  });
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

  it("subscribes to window keydown once across request transitions", () => {
    const add = vi.spyOn(window, "addEventListener");
    try {
      renderRequest({ id: "one", method: "select", title: "One", options: ["A"] });
      act(() =>
        useStore.setState({
          rpc: { [TAB]: runtime([{ id: "two", method: "select", title: "Two", options: ["B"] }]) },
        }),
      );
      expect(add.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(1);
    } finally {
      add.mockRestore();
    }
  });
});

describe("question series rail", () => {
  const button = (text: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === text,
    );
  const dot = (label: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.getAttribute("aria-label") === label,
    );
  const railButtons = () =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].filter((candidate) =>
      candidate.getAttribute("aria-label")?.startsWith("question "),
    );
  const advance = (frame: unknown) =>
    act(() => useStore.setState({ rpc: { [TAB]: runtime([frame]) } }));
  const key = (k: string) =>
    act(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })),
    );

  it("renders the rail with the marker stripped from the title", () => {
    renderRequest({ id: "p2", method: "select", title: "Format? (2/7)", options: ["Alpha", "Beta"] });
    expect(railButtons()).toHaveLength(7);
    expect(document.body.querySelector("h2")!.textContent).toBe("Format?");
    expect(document.body.textContent).toContain("Question 2 of 7");
    expect(document.body.textContent).not.toContain("(2/7)");
  });

  it("fills progress as pages are answered", () => {
    renderRequest({ id: "p1", method: "select", title: "Format? (1/2)", options: ["Alpha", "Beta"] });
    act(() => button("Alpha")!.click());
    advance({ id: "p2", method: "select", title: "Deliverable? (2/2)", options: ["X", "Y"] });
    expect(dot("question 1 of 2, answered")).toBeDefined();
    const current = document.body.querySelector('button[aria-current="step"]')!;
    expect(current.getAttribute("aria-label")).toBe("question 2 of 2, current");
  });

  it("opens a read-only review from an answered dot", () => {
    renderRequest({ id: "p1", method: "select", title: "Format? (1/2)", options: ["Alpha", "Beta"] });
    act(() => button("Alpha")!.click());
    advance({ id: "p2", method: "select", title: "Deliverable? (2/2)", options: ["X", "Y"] });
    act(() => dot("question 1 of 2, answered")!.click());
    expect(document.body.querySelector("h2")!.textContent).toBe("Format?");
    expect(document.body.textContent).toContain("answered");
    const alpha = [...document.body.querySelectorAll<HTMLSpanElement>("span")].find(
      (candidate) => candidate.textContent === "Alpha",
    )!;
    expect(alpha.className).toContain("text-signal");
    // The live question's options are not rendered — review sends nothing.
    expect(button("X")).toBeUndefined();
    expect(button("Y")).toBeUndefined();
    expect(document.body.textContent).not.toContain("Deliverable?");
    expect(rpcSend.mock.calls).toHaveLength(1);
  });

  it("returns from review on Escape without cancelling", () => {
    renderRequest({ id: "p1", method: "select", title: "Format? (1/2)", options: ["Alpha", "Beta"] });
    act(() => button("Alpha")!.click());
    advance({ id: "p2", method: "select", title: "Deliverable? (2/2)", options: ["X", "Y"] });
    act(() => dot("question 1 of 2, answered")!.click());
    key("Escape");
    expect(document.body.textContent).toContain("Deliverable?");
    expect(rpcSend.mock.calls).toHaveLength(1); // no {cancelled:true} from review
    key("Escape");
    expect(lastFrame()).toMatchObject({ id: "p2", cancelled: true });
  });

  it("walks reviewed pages with arrows and returns via the back button", () => {
    renderRequest({ id: "p1", method: "select", title: "One? (1/3)", options: ["A", "B"] });
    act(() => button("A")!.click());
    advance({ id: "p2", method: "select", title: "Two? (2/3)", options: ["C", "D"] });
    act(() => button("C")!.click());
    advance({ id: "p3", method: "select", title: "Three? (3/3)", options: ["E", "F"] });
    act(() => dot("question 1 of 3, answered")!.click());
    expect(document.body.textContent).toContain("Reviewing 1 of 3");
    act(() => button("back to question 3")!.click());
    expect(document.body.textContent).toContain("Question 3 of 3");
    act(() => dot("question 1 of 3, answered")!.click());
    key("ArrowRight");
    expect(document.body.textContent).toContain("Reviewing 2 of 3");
    key("ArrowLeft");
    expect(document.body.textContent).toContain("Reviewing 1 of 3");
    key("ArrowRight");
    key("ArrowRight"); // past the last answered page → live question
    expect(document.body.textContent).toContain("Question 3 of 3");
    expect(rpcSend.mock.calls).toHaveLength(2);
  });

  it("disables dots for upcoming questions", () => {
    renderRequest({ id: "p1", method: "select", title: "Format? (1/3)", options: ["Alpha", "Beta"] });
    expect(dot("question 3 of 3, not answered")!.disabled).toBe(true);
  });

  it("resets when a new series starts", () => {
    renderRequest({ id: "p2", method: "select", title: "Format? (2/7)", options: ["Alpha", "Beta"] });
    advance({ id: "n1", method: "select", title: "Fresh? (1/3)", options: ["Alpha", "Beta"] });
    expect(railButtons()).toHaveLength(3);
    expect(
      [...document.body.querySelectorAll<HTMLButtonElement>("button")].filter((candidate) =>
        candidate.getAttribute("aria-label")?.includes(", answered"),
      ),
    ).toHaveLength(0);
  });

  it("records a multi-select page with its picked labels", () => {
    renderRequest({
      id: "t1",
      method: "select",
      title: "Tools? (1/2)",
      options: ["Alpha", "Beta", "Gamma", "Other (type your own)"],
    });
    act(() => button("Alpha")!.click());
    expect(lastFrame()).toMatchObject({ value: "Alpha" });
    advance({
      id: "t2",
      method: "select",
      title: "(1 selected) Tools? (1/2)",
      options: ["Alpha", "Beta", "Gamma", "Other (type your own)"],
    });
    act(() => button("done selecting")!.click());
    expect(lastFrame()).toMatchObject({ id: "t2", value: "✔ Done selecting" });
    advance({ id: "t3", method: "select", title: "Format? (2/2)", options: ["X", "Y"] });
    act(() => dot("question 1 of 2, answered")!.click());
    const alpha = [...document.body.querySelectorAll<HTMLSpanElement>("span")].find(
      (candidate) => candidate.textContent === "Alpha",
    )!;
    expect(alpha.className).toContain("text-signal");
    const beta = [...document.body.querySelectorAll<HTMLSpanElement>("span")].find(
      (candidate) => candidate.textContent === "Beta",
    )!;
    expect(beta.className).toContain("text-ink-dim");
  });

  it("keeps the page unanswered through Other until the editor submits", () => {
    renderRequest({
      id: "p1",
      method: "select",
      title: "Format? (1/2)",
      options: ["Alpha", "Beta", "Other (type your own)"],
    });
    act(() => button("Other — type your own…")!.click());
    expect(lastFrame()).toMatchObject({ value: "Other (type your own)" });
    advance({ id: "e1", method: "editor", title: "Enter your response:" });
    // The marker-less editor frame continues the live page — rail intact.
    expect(railButtons()).toHaveLength(2);
    expect(dot("question 1 of 2, current")).toBeDefined();
    const field = document.body.querySelector<HTMLTextAreaElement>("textarea")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => { setter.call(field, "custom answer"); field.dispatchEvent(new Event("input", { bubbles: true })); });
    act(() => button("submit")!.click());
    expect(lastFrame()).toMatchObject({ id: "e1", value: "custom answer" });
    advance({ id: "p2", method: "select", title: "Deliverable? (2/2)", options: ["X", "Y"] });
    act(() => dot("question 1 of 2, answered")!.click());
    expect(document.body.textContent).toContain("custom answer");
  });

  it("no longer renders the protocol method chip", () => {
    renderRequest({ id: "s", method: "select", title: "Pick", options: ["Alpha", "Beta"] });
    expect(document.querySelector('[title="the extension method awaiting a reply"]')).toBeNull();
  });

  it("degrades to a meter past ten questions", () => {
    renderRequest({ id: "p3", method: "select", title: "Format? (3/12)", options: ["Alpha", "Beta"] });
    expect(railButtons()).toHaveLength(0);
    expect(document.body.querySelector('[title="Question 3 of 12"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Question 3 of 12");
  });
});
