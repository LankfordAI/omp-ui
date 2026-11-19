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
const { ExtensionDialogHost, INITIAL_EXTENSION_DIALOG_STATE, reduceExtensionDialog, answerPendingQuestion, freeTextTarget, skipPendingQuestion } = await import("./ExtensionDialogHost");

const TAB = "tab-question";
const OTHER = "Other (type your own)";
const DONE = "✔ Done selecting";
let root: Root | null = null;

function runtime(queue: unknown[]): RpcTabState {
  return { status: "ready", items: [], transcriptRevision: 0, todos: [], model: null, availableModels: [], commands: [],
    activeTurnKeywords: [],
    session: emptySessionRuntime(), stats: null, subagents: [], subagentItems: {}, selectedSubagent: null,
    subagentMarkers: new Map(), stallCount: 0, extensionStatus: {},
    extensionQueue: queue, busy: false, initialPrompt: null, hasRenamed: true, titleAttempt: null,
    plan: null, planReview: null, planReadiness: null, experimentProposal: null, approvalPrompt: null,
    planSourceKey: null, planVoice: { ready: false, busy: false, error: null },
    planHtml: null, planText: null, planDeferred: false, advisorStats: null, mcpStatus: null, advisorReply: true, capabilities: null, capabilitiesLoad: "idle", goal: null, vibe: null, sideQuestions: null, sideCommands: null, live: null, autoresearch: null, limits: null,
    asyncJobs: null, asyncNotices: {}, asyncJobsKill: null, asyncJobsKillError: null, sessionSpend: null, composerPredictions: null, cacheWarming: null,
    subagentControlBusy: {}, subagentControlError: null,
    browserPane: { open: false, fullscreen: false, agentOpened: false, ensure: "idle", unavailableReason: null, state: null, frame: null },
    devicePane: { open: false, fullscreen: false, ensure: "idle", state: null, inventory: null, frame: null, streamGeneration: 0 } };
}

function renderRequest(...queue: unknown[]): void {
  useStore.setState({ rpc: { [TAB]: runtime(queue) } });
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root!.render(<ExtensionDialogHost tabId={TAB} />));
}

/** Desktop geometry (matchMedia override like Composer.test.tsx) with the
 *  floating composer present — the surfaces issue #421 changes. */
function renderDesktopHost(queue: unknown[], composerVisible = true): void {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })) });
  useStore.setState({ rpc: { [TAB]: runtime(queue) } });
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  act(() => root!.render(<ExtensionDialogHost tabId={TAB} composerVisible={composerVisible} />));
}

function advance(frame: unknown): void {
  act(() => useStore.setState({ rpc: { [TAB]: runtime([frame]) } }));
}

/** The composer's Enter, from outside React. */
function ask(text: string): string {
  let outcome = "";
  act(() => { outcome = answerPendingQuestion(TAB, text); });
  return outcome;
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
  it.each(["confirm", "select", "input", "editor"])("blocks Android Back without cancelling or answering %s", (method) => {
    const frame = { id: "held", method, title: "Keep this decision", options: ["Alpha"] };
    renderRequest(frame);
    const event = new Event("omp-android-back", { cancelable: true });
    act(() => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(rpcSend).not.toHaveBeenCalled();
    expect(useStore.getState().rpc[TAB]!.extensionQueue).toEqual([frame]);
    expect(document.body.textContent).toContain("Keep this decision");
  });

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

describe("omp 18.18.3 / 18.20.0 ask frames (issue #1190)", () => {
  const button = (text: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === text,
    );
  const railButtons = () =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].filter((candidate) =>
      candidate.getAttribute("aria-label")?.startsWith("question "),
    );
  const advanceFrame = (frame: unknown) =>
    act(() => useStore.setState({ rpc: { [TAB]: runtime([frame]) } }));
  const textAreaSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;

  it("opens the editor on its prefill and submits the edited value", () => {
    // ask.ts askText sends ui.editor(title, field.value): the prefill is the
    // field's current value — blanking it would erase the model's default.
    renderRequest({ id: "ed", method: "editor", title: "Session lifetime (days)?", prefill: "30" });
    const field = document.body.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(field.value).toBe("30");
    act(() => {
      textAreaSetter.call(field, "45");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => button("submit")!.click());
    expect(lastFrame()).toMatchObject({ id: "ed", value: "45" });
  });

  it("shows the 18.20.0 question in the header with its form context separate", () => {
    // promptTitle(text, question) = `${context}\n\n${question}`.
    renderRequest({
      id: "s",
      method: "select",
      title: "Sessions live in memory and are lost on restart.\n\nWhich store?",
      options: ["SQLite", "Redis", OTHER],
    });
    expect(document.body.querySelector("h2")!.textContent).toBe("Which store?");
    expect(document.body.textContent).toContain("Sessions live in memory and are lost on restart.");
  });

  it("paints checkbox state from checkedIndices, not the toggle reconstruction", () => {
    // We answered Beta, but the frame's authoritative set says Alpha is
    // checked — a second client toggled, or omp preselected. The frame wins.
    renderRequest({ id: "c1", method: "select", title: "Tools?", options: ["Alpha", "Beta", OTHER] });
    act(() => button("Beta")!.click());
    advanceFrame({
      id: "c2",
      method: "select",
      title: "(1 selected) Tools?",
      options: ["Alpha", "Beta", DONE, OTHER],
      initialIndex: 0,
      selectionMarker: "checkbox",
      checkedIndices: [0],
      markableCount: 3,
    });
    const row = (label: string) =>
      [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
        (candidate) => candidate.textContent?.includes(label),
      )!;
    expect(row("Alpha").querySelector(".text-signal")).not.toBeNull();
    expect(row("Beta").querySelector(".text-signal")).toBeNull();
    expect(document.body.textContent).toContain("1 selected");
  });

  it("opens a radio frame on initialIndex", () => {
    renderRequest({
      id: "r1",
      method: "select",
      title: "Which store?",
      options: ["SQLite", "Redis"],
      initialIndex: 1,
      selectionMarker: "radio",
    });
    // border-line-strong marks the open row; every row carries hover:bg-hover.
    expect(button("Redis")!.className).toContain("border-line-strong");
    expect(button("SQLite")!.className).not.toContain("border-line-strong");
  });

  it("shows checkbox markers on the first 18.20.0 frame, before any (N selected) prefix", () => {
    // selectionMarker: "checkbox" is what makes a checkbox group's opening
    // frame recognizable; the count prefix only appears once something is
    // checked. The count chip stays hidden at zero.
    renderRequest({
      id: "c0",
      method: "select",
      title: "Tools?",
      options: ["Alpha", "Beta", OTHER],
      selectionMarker: "checkbox",
      checkedIndices: [],
      markableCount: 2,
    });
    // Checkbox rows prepend the ✓ marker glyph, so match rows by substring.
    const alpha = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.includes("Alpha"),
    )!;
    expect(alpha.querySelector('[class*="rounded-sm"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain("selected");
  });

  it("answers a disambiguated Other row with its exact frame label", () => {
    // disambiguateDisplayLabels may shadow the row as "Other (type your own) (2)";
    // askChoice compares replies against that exact string.
    renderRequest({ id: "s", method: "select", title: "Pick", options: ["Alpha", `${OTHER} (2)`] });
    const otherRow = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.includes("Other —"),
    )!;
    act(() => otherRow.click());
    expect(lastFrame()).toMatchObject({ id: "s", value: `${OTHER} (2)` });
  });

  it("degrades without a series rail when frames carry no (i/n) markers", () => {
    // 18.18.3+ field-by-field asks send no page markers at all: consecutive
    // fields are just consecutive frames. The rail stays absent and every
    // question renders normally — including one whose mid-title
    // parenthetical must never pass for a page marker.
    renderRequest({ id: "a", method: "select", title: "Session store?", options: ["SQLite", "Redis", OTHER] });
    expect(railButtons()).toHaveLength(0);
    act(() => button("SQLite")!.click());
    advanceFrame({ id: "b", method: "select", title: "Session lifetime (days)?", options: ["30", "60", OTHER] });
    expect(railButtons()).toHaveLength(0);
    expect(document.body.querySelector("h2")!.textContent).toBe("Session lifetime (days)?");
  });

  it("keeps a marker rail across an 18.20.0 Other follow-up input frame", () => {
    // The follow-up is ui.input(question) — no marker, no context: the live
    // page stays live and its dot fills when the text lands.
    renderRequest({
      id: "p1",
      method: "select",
      title: "Format? (1/2)",
      options: ["Alpha", "Beta", OTHER],
    });
    act(() => button("Other — type your own…")!.click());
    advanceFrame({ id: "in", method: "input", title: "Format?" });
    expect(railButtons()).toHaveLength(2);
    const field = document.body.querySelector<HTMLInputElement>("input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(field, "custom answer");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => button("submit")!.click());
    expect(lastFrame()).toMatchObject({ id: "in", value: "custom answer" });
    advanceFrame({ id: "p2", method: "select", title: "Deliverable? (2/2)", options: ["X", "Y"] });
    expect(document.body.textContent).toContain("Question 2 of 2");
  });
});

describe("freeTextTarget", () => {
  it("classifies every frame shape", () => {
    expect(freeTextTarget(undefined)).toBe("none");
    expect(freeTextTarget({ method: "confirm", title: "Run it?" })).toBe("none");
    expect(freeTextTarget({ method: "select", title: "Pick", options: ["Alpha", "Beta"] })).toBe("none");
    // Any select with an Other row answers free text through that row —
    // single-selects included, because askChoice cancels the whole ask on a
    // reply that matches no option label (issue #1190).
    expect(freeTextTarget({ method: "select", title: "Pick", options: ["Alpha", OTHER] })).toBe("other");
    expect(freeTextTarget({ method: "select", title: "(1 selected) Which?", options: ["Alpha", OTHER] })).toBe("other");
    expect(freeTextTarget({ method: "select", title: "Which?", options: ["Alpha", DONE, OTHER] })).toBe("other");
    // omp's label disambiguation may suffix the row; shape still matches.
    expect(freeTextTarget({ method: "select", title: "Pick", options: ["Alpha", `${OTHER} (2)`] })).toBe("other");
    expect(freeTextTarget({ method: "editor", title: "Enter your response:" })).toBe("answer");
    expect(freeTextTarget({ method: "input", title: "Value" })).toBe("answer");
  });
});

describe("composer answer path (issue #421)", () => {
  const dot = (label: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.getAttribute("aria-label") === label,
    );

  it("routes unlisted free text through the Other row and collects it on the follow-up (issue #1190)", () => {
    // A single-select never takes unlisted text outright: askChoice answers
    // `labels.indexOf(reply)` → no option → the whole ask is cancelled. The
    // text goes out as the frame's Other row, and omp's follow-up input
    // frame (18.18+) collects it with a second Enter.
    renderDesktopHost([{ id: "q1", method: "select", title: "Format? (1/2)", options: ["Alpha", "Beta", OTHER] }]);
    expect(ask("forty-two")).toBe("kept-draft");
    expect(lastFrame()).toMatchObject({ type: "extension_ui_response", id: "q1", value: OTHER });
    advance({ id: "in", method: "input", title: "Format? (1/2)" });
    expect(ask("forty-two")).toBe("answered");
    expect(lastFrame()).toMatchObject({ type: "extension_ui_response", id: "in", value: "forty-two" });
    advance({ id: "q2", method: "select", title: "Deliverable? (2/2)", options: ["X", "Y"] });
    act(() => dot("question 1 of 2, answered")!.click());
    // The follow-up's answer lands on the question page it continues.
    expect(document.body.textContent).toContain("forty-two");
  });

  it("answers a select with a draft that names a listed option verbatim", () => {
    renderDesktopHost([{ id: "q1", method: "select", title: "Format? (1/2)", options: ["Alpha", "Beta", OTHER] }]);
    expect(ask("Beta")).toBe("answered");
    expect(lastFrame()).toMatchObject({ type: "extension_ui_response", id: "q1", value: "Beta" });
  });

  it("reconstructs the picked set through the one-step answer, then takes the sentinel on the loop frame", () => {
    renderDesktopHost([{ id: "m1", method: "select", title: "Tools?", options: ["Alpha", "Beta", OTHER] }]);
    // A multi question's first frame is indistinguishable from a single one:
    // the text lands verbatim and records pending for the reconstruction.
    expect(ask("Alpha")).toBe("answered");
    expect(lastFrame()).toMatchObject({ id: "m1", value: "Alpha" });
    advance({ id: "m2", method: "select", title: "(1 selected) Tools?", options: ["Alpha", "Beta", DONE, OTHER] });
    const alpha = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.includes("Alpha"),
    )!;
    expect(alpha.querySelector(".text-signal")).not.toBeNull();
    expect(ask("plus custom stuff")).toBe("kept-draft");
    expect(lastFrame()).toMatchObject({ id: "m2", value: OTHER });
    advance({ id: "ed", method: "editor", title: "Enter your response:" });
    expect(ask("plus custom stuff")).toBe("answered");
    expect(lastFrame()).toMatchObject({ id: "ed", value: "plus custom stuff" });
  });

  it("renders hint and cancel instead of a field where the composer owns it", () => {
    renderDesktopHost([{ id: "ed", method: "editor", title: "Enter your response:\n- [ ] flagged", message: "Answer" }]);
    expect(document.body.querySelector("textarea")).toBeNull();
    expect(document.body.textContent).toContain("Type your answer in the box below");
    // The multi-line editor title survives the swap of answer surfaces.
    expect(document.body.textContent).toContain("- [ ] flagged");
    const cancel = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === "cancel",
    )!;
    act(() => cancel.click());
    expect(lastFrame()).toMatchObject({ id: "ed", cancelled: true });
  });

  it("keeps the panel field when no composer answers", () => {
    renderDesktopHost([{ id: "ed", method: "editor", title: "Enter your response:" }], false);
    expect(document.body.querySelector("textarea")).not.toBeNull();
    expect(ask("typed through the card")).toBe("answered");
    expect(lastFrame()).toMatchObject({ id: "ed", value: "typed through the card" });
  });

  it("leaves the caret in the composer for answer-capable select frames", () => {
    const box = document.createElement("textarea"); document.body.append(box); box.focus();
    renderDesktopHost([{ id: "q", method: "select", title: "Pick", options: ["Alpha", OTHER] }]);
    expect(document.activeElement).toBe(box);
  });

  it("still focuses the card when the composer cannot answer", () => {
    const box = document.createElement("textarea"); document.body.append(box); box.focus();
    renderDesktopHost([{ id: "q", method: "select", title: "Pick", options: ["Alpha", "Beta"] }]);
    expect((document.activeElement as HTMLElement).textContent).toContain("Alpha");
  });
});

// The probed wire frame (issue #1234): method:"ask" carries questions and no
// title at all — the shape 18.22.2 and 19.0.0 emit identically once
// set_ask_dialog succeeds.
const ASK_FRAME = {
  id: "ask1",
  method: "ask",
  questions: [
    { id: "db", question: "Which database?", options: [{ label: "Postgres" }, { label: "SQLite" }], recommended: 1 },
    { id: "features", question: "Which features?", options: [{ label: "Auth" }, { label: "Billing" }], multi: true },
  ],
};

describe("multi-question ask form (issue #1234)", () => {
  const button = (text: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === text,
    );
  const row = (label: string) =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
      candidate.textContent?.includes(label),
    )!;

  it("renders every question of the frame with its recommendation marked", () => {
    renderDesktopHost([ASK_FRAME]);
    expect(document.body.textContent).toContain("Which database?");
    expect(document.body.textContent).toContain("recommended");
    const second = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
      candidate.getAttribute("aria-label")?.startsWith("edit your answer to: Which features?"),
    );
    expect(second).toBeDefined();
  });

  it("lands focus on the recommended option's row when the form opens", () => {
    renderDesktopHost([ASK_FRAME]);
    // Upstream parks its cursor at `recommended ?? 0`; the card mirrors that
    // with real focus (db recommends index 1 = SQLite).
    expect(document.activeElement).toBe(row("SQLite"));
  });

  it("focuses the first row when no option is recommended", () => {
    renderDesktopHost([{ id: "ask2", method: "ask", questions: [{ id: "q", question: "Pick?", options: ["Alpha", "Beta"] }] }]);
    expect(document.activeElement).toBe(row("Alpha"));
  });

  it("advances to the next unanswered question on a single-select answer and collapses the answered one", () => {
    renderDesktopHost([ASK_FRAME]);
    act(() => row("SQLite")!.click());
    // The answer summary replaces the expanded first question…
    const collapsed = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
      candidate.getAttribute("aria-label")?.startsWith("edit your answer to: Which database?"),
    )!;
    expect(collapsed.textContent).toContain("SQLite");
    // …and the second question is open for its own answer.
    expect(document.body.querySelector("input")).not.toBeNull();
  });

  it("submits the whole form from the submit button — in-order ids, exact labels", () => {
    renderDesktopHost([ASK_FRAME]);
    act(() => row("SQLite")!.click());
    act(() => row("Auth")!.click()); // a multi flip stays put; nothing sends yet
    expect(rpcSend).not.toHaveBeenCalled();
    act(() => button("submit")!.click());
    expect(lastFrame()).toEqual({
      type: "extension_ui_response",
      id: "ask1",
      answers: [
        { id: "db", selectedOptions: ["SQLite"] },
        { id: "features", selectedOptions: ["Auth"] },
      ],
    });
  });

  it("keeps partial answers editable and submits untouched questions as empty entries", () => {
    renderDesktopHost([ASK_FRAME]);
    // The field belongs to the open question (db): its typed answer rides the
    // wire while the never-opened multi stays an empty entry, not a default.
    const field = document.body.querySelector<HTMLInputElement>("input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(field, "DuckDB");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => button("submit")!.click());
    expect(lastFrame()).toEqual({
      type: "extension_ui_response",
      id: "ask1",
      answers: [
        { id: "db", selectedOptions: [], customInput: "DuckDB" },
        { id: "features", selectedOptions: [] },
      ],
    });
  });

  it("clears a single-select pick when free text lands, and vice versa", () => {
    renderDesktopHost([ASK_FRAME]);
    act(() => row("Postgres")!.click());
    // Reopen the collapsed answer and type: the wire forbids option+text on a
    // single-select, so the typed answer replaces the pick.
    const collapsed = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
      candidate.getAttribute("aria-label")?.startsWith("edit your answer to: Which database?"),
    )!;
    act(() => collapsed.click());
    const field = document.body.querySelector<HTMLInputElement>("input")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(field, "DuckDB");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => button("submit")!.click());
    expect(lastFrame()).toMatchObject({
      id: "ask1",
      answers: [
        { id: "db", selectedOptions: [], customInput: "DuckDB" },
        { id: "features", selectedOptions: [] },
      ],
    });
  });

  it("dismisses on Escape with a cancel, never an answer", () => {
    renderDesktopHost([ASK_FRAME]);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(lastFrame()).toMatchObject({ id: "ask1", cancelled: true });
  });

  it("sends from Enter on the last question once every answer is in", () => {
    renderDesktopHost([ASK_FRAME]);
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    // Enter in the open question's free text advances to the next empty one…
    const first = document.body.querySelector<HTMLInputElement>("input")!;
    act(() => {
      setter.call(first, "DuckDB");
      first.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => first.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(rpcSend).not.toHaveBeenCalled();
    // …and on the last question with nothing left empty it submits.
    const last = document.body.querySelector<HTMLInputElement>("input")!;
    act(() => {
      setter.call(last, "Auth");
      last.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => last.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    expect(lastFrame()).toEqual({
      type: "extension_ui_response",
      id: "ask1",
      answers: [
        { id: "db", selectedOptions: [], customInput: "DuckDB" },
        { id: "features", selectedOptions: [], customInput: "Auth" },
      ],
    });
  });

  it("moves between questions with Tab and Shift-Tab, falling through at the last one", () => {
    renderDesktopHost([ASK_FRAME]);
    // The card's Tab handler sits on the open question's container, so the
    // keystroke comes from the control inside it — where focus actually is —
    // and bubbles up exactly as a real Tab does.
    const tab = (shiftKey: boolean) =>
      act(() =>
        (document.activeElement ?? document.body).dispatchEvent(
          new KeyboardEvent("keydown", { key: "Tab", shiftKey, bubbles: true, cancelable: true }),
        ),
      );
    // Open question starts at the first; Tab opens the next.
    tab(false);
    const collapsed = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.getAttribute("aria-label")?.startsWith("edit your answer to: Which database?"),
    );
    expect(collapsed).toBeDefined();
    // Shift+Tab returns to the first.
    tab(true);
    expect(document.body.querySelector("h3")!.textContent).toBe("Which database?");
    // Tab to the last, then Tab again past it: nothing is swallowed, the open
    // question stays put so native focus order can leave the form.
    tab(false);
    expect(document.body.querySelector("h3")!.textContent).toBe("Which features?");
    tab(false);
    expect(document.body.querySelector("h3")!.textContent).toBe("Which features?");
  });

  it("keeps plain Tab alive for the panel's own controls inside an open question", () => {
    renderDesktopHost([{ id: "ask3", method: "ask", questions: [{ id: "only", question: "Pick?", options: ["Alpha"] }] }]);
    const event = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    act(() => (document.activeElement ?? document.body).dispatchEvent(event));
    expect(event.defaultPrevented).toBe(false);
  });

  it("leaves the draft unanswerable from the composer — free text is never an ask reply", () => {
    renderDesktopHost([ASK_FRAME]);
    expect(freeTextTarget(ASK_FRAME)).toBe("none");
    expect(ask("just a message")).toBe("not-answerable");
  });

  it("skips the pending ask for the composer and drops it from the queue", () => {
    renderDesktopHost([ASK_FRAME]);
    act(() => row("SQLite")!.click()); // a partial answer exists; skip sends none of it
    expect(skipPendingQuestion(TAB)).toBe(true);
    expect(lastFrame()).toMatchObject({ type: "extension_ui_response", id: "ask1", cancelled: true });
    expect(useStore.getState().rpc[TAB]!.extensionQueue).toEqual([]);
  });

  it("reports no skip once the ask is gone", () => {
    renderDesktopHost([ASK_FRAME]);
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    expect(skipPendingQuestion(TAB)).toBe(false);
  });

  it("drops an unanswerable form quietly when a cancel frame names it (issue #1191 rule)", () => {
    // A timeout on omp's side answers its defaults and emits cancel{targetId};
    // the queue removal (frame-reduction) unmounts the card — never an answer.
    renderDesktopHost([ASK_FRAME]);
    act(() => useStore.setState({ rpc: { [TAB]: runtime([]) } }));
    expect(document.body.textContent).not.toContain("Which database?");
  });

  it("keeps answers of two consecutive asks apart by frame id", () => {
    renderDesktopHost([ASK_FRAME]);
    act(() => row("SQLite")!.click());
    advance({ ...ASK_FRAME, id: "ask2" });
    expect(document.body.querySelector("input")).not.toBeNull();
    act(() => button("submit")!.click());
    expect(lastFrame()).toMatchObject({
      id: "ask2",
      answers: [
        { id: "db", selectedOptions: [] },
        { id: "features", selectedOptions: [] },
      ],
    });
  });
});
