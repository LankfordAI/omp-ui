// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { remoteOwnedState, rpcTabState } from "../test/fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalPrompt } from "@omp-ui/core/approval";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no layout, hence no scrollIntoView; the card scrolls the first
// `?` segment row into view when the detail list overflows (issue #1208).
HTMLElement.prototype.scrollIntoView = vi.fn();
const rpcSend = vi.fn();
Object.assign(window, { ompBackend: { rpcSend } });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { ApprovalCard } = await import("./ApprovalCard");

const TAB = "tab-approval";
const FRAME = {
  type: "extension_ui_request",
  id: "a1",
  method: "select",
  title: "Allow tool: Bash",
  options: ["Approve", "Deny"],
};
const PROMPT: ApprovalPrompt = {
  toolName: "Bash",
  origin: "mcp",
  reason: "policy: shells need a person",
  details: ["ls -la /etc"],
  providerSafety: ["injection scan: passed"],
  sessionLabel: null,
  grants: [],
  restrictedFolder: null,
};
const GRANT_FRAME = {
  type: "extension_ui_request",
  id: "g1",
  method: "select",
  title: "Allow tool: Read",
  options: [
    "Approve Directory: /repo/src",
    "Approve File: /repo/src/a.ts",
    "Always Approve Directory: /repo/src",
    "Always Approve File: /repo/src/a.ts",
    "Approve Once",
    "Deny",
  ],
};
const GRANT_PROMPT: ApprovalPrompt = {
  ...PROMPT,
  toolName: "Read",
  grants: [
    {
      scope: "folder",
      label: "Approve Directory: /repo/src",
      alwaysLabel: "Always Approve Directory: /repo/src",
    },
    {
      scope: "target",
      label: "Approve File: /repo/src/a.ts",
      alwaysLabel: "Always Approve File: /repo/src/a.ts",
    },
  ],
};

let root: Root | null = null;

function render(prompt: ApprovalPrompt | null, frame: unknown = FRAME): void {
  useStore.setState({
    rpc: {
      [TAB]: rpcTabState({
        approvalPrompt: prompt === null ? null : { prompt, frame },
      }),
    },
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<ApprovalCard tabId={TAB} />));
}

function button(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll("button")].find((b) => b.textContent === label);
  if (!found) throw new Error(`no "${label}" button`);
  return found as HTMLButtonElement;
}

function press(el: Element, key: string): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  rpcSend.mockClear();
});

describe("ApprovalCard (issue #681)", () => {
  it("blocks Android Back without denying or answering the held frame", () => {
    render(PROMPT);
    const event = new Event("omp-android-back", { cancelable: true });
    act(() => { window.dispatchEvent(event); });
    expect(event.defaultPrevented).toBe(true);
    expect(rpcSend).not.toHaveBeenCalled();
    expect(useStore.getState().rpc[TAB]!.approvalPrompt?.frame).toEqual(FRAME);
    expect(document.querySelector("[data-approval-card]")).not.toBeNull();
  });

  it("renders the frame's parts", () => {
    render(PROMPT);
    const card = document.querySelector("[data-approval-card]")!;
    expect(card.textContent).toContain("Allow tool");
    expect(card.textContent).toContain("Bash");
    expect(card.textContent).toContain("MCP server tool");
    expect(card.textContent).toContain("policy: shells need a person");
    expect(card.textContent).toContain("ls -la /etc");
    expect(card.textContent).toContain("Provider safety checks");
    expect(card.textContent).toContain("injection scan: passed");
  });

  it("renders nothing without a held frame", () => {
    render(null);
    expect(document.querySelector("[data-approval-card]")).toBeNull();
  });

  it("answers Allow with the exact approve string", () => {
    render(PROMPT);
    act(() => button("Allow").click());
    expect(rpcSend).toHaveBeenCalledWith(TAB, {
      type: "extension_ui_response",
      id: "a1",
      value: "Approve",
    });
    expect(useStore.getState().rpc[TAB]!.approvalPrompt).toBeNull();
  });

  it("answers Deny with the deny string", () => {
    render(PROMPT);
    act(() => button("Deny").click());
    expect(rpcSend.mock.calls.at(-1)![1]).toMatchObject({ value: "Deny" });
  });

  it("offers the session option and answers with its verbatim label (issue #883)", () => {
    render({ ...PROMPT, sessionLabel: "Approve Bash for this session" });
    act(() => button("Approve Bash for this session").click());
    expect(rpcSend).toHaveBeenCalledWith(TAB, {
      type: "extension_ui_response",
      id: "a1",
      value: "Approve Bash for this session",
    });
    expect(useStore.getState().rpc[TAB]!.approvalPrompt).toBeNull();
  });

  it("shows no session button on the two-option shape", () => {
    render(PROMPT);
    const texts = [...document.querySelectorAll("button")].map((b) => b.textContent);
    expect(texts).toContain("Allow");
    expect(texts).toContain("Deny");
    expect(texts.some((t) => t?.includes("for this session"))).toBe(false);
  });

  it("names the restricted folder in place of the generic reason (issue #951)", () => {
    render({
      ...PROMPT,
      origin: null,
      providerSafety: [],
      reason: "Restricted folder: /home/u/secrets",
      restrictedFolder: "/home/u/secrets",
    });
    const card = document.querySelector("[data-approval-card]")!;
    expect(card.textContent).toContain("Restricted folder");
    expect(card.textContent).toContain("/home/u/secrets");
    expect(card.textContent).toContain("ask in every approval mode");
    expect(card.textContent).not.toContain("Reason:");
    const texts = [...document.querySelectorAll("button")].map((b) => b.textContent);
    expect(texts).toEqual(["Deny", "Allow"]);
  });

  it("maps Escape to Deny — a dropped dialog is a refusal, never silence", () => {
    render(PROMPT);
    act(() => press(document.body, "Escape"));
    expect(rpcSend.mock.calls.at(-1)![1]).toMatchObject({ id: "a1", value: "Deny" });
    expect(useStore.getState().rpc[TAB]!.approvalPrompt).toBeNull();
  });

  it("leaves Escape to the composer while the user is typing", () => {
    render(PROMPT);
    const input = document.createElement("textarea");
    document.body.append(input);
    act(() => press(input, "Escape"));
    expect(rpcSend).not.toHaveBeenCalled();
    expect(useStore.getState().rpc[TAB]!.approvalPrompt).not.toBeNull();
  });
});

describe("ApprovalCard grants (issue #950)", () => {
  const alwaysSwitch = (): HTMLButtonElement =>
    document.querySelector('[data-approval-grants] [role="switch"]') as HTMLButtonElement;

  it("renders the grant labels verbatim and Allow once answers Approve Once", () => {
    render(GRANT_PROMPT, GRANT_FRAME);
    const row = document.querySelector("[data-approval-grants]")!;
    expect(row.textContent).toContain("Remember");
    expect(row.textContent).toContain("Approve Directory: /repo/src");
    expect(row.textContent).toContain("Approve File: /repo/src/a.ts");
    expect(alwaysSwitch().getAttribute("aria-checked")).toBe("false");
    act(() => button("Allow once").click());
    expect(rpcSend).toHaveBeenCalledWith(TAB, {
      type: "extension_ui_response",
      id: "g1",
      value: "Approve Once",
    });
  });

  it("shows no grant row on a grant-less prompt", () => {
    render(PROMPT);
    expect(document.querySelector("[data-approval-grants]")).toBeNull();
    expect(button("Allow")).toBeTruthy();
  });

  it("clicking a grant answers its label", () => {
    render(GRANT_PROMPT, GRANT_FRAME);
    act(() => button("Approve File: /repo/src/a.ts").click());
    expect(rpcSend.mock.calls.at(-1)![1]).toMatchObject({ id: "g1", value: "Approve File: /repo/src/a.ts" });
    expect(useStore.getState().rpc[TAB]!.approvalPrompt).toBeNull();
  });

  it("the in-every-session switch relabels grants and answers the always label", () => {
    render(GRANT_PROMPT, GRANT_FRAME);
    act(() => alwaysSwitch().click());
    expect(alwaysSwitch().getAttribute("aria-checked")).toBe("true");
    const row = document.querySelector("[data-approval-grants]")!;
    expect(row.textContent).toContain("in every session");
    expect(row.textContent).toContain("Always Approve File: /repo/src/a.ts");
    act(() => button("Always Approve Directory: /repo/src").click());
    expect(rpcSend.mock.calls.at(-1)![1]).toMatchObject({
      id: "g1",
      value: "Always Approve Directory: /repo/src",
    });
  });

  it("a newly held frame resets the switch", () => {
    render(GRANT_PROMPT, GRANT_FRAME);
    act(() => alwaysSwitch().click());
    expect(alwaysSwitch().getAttribute("aria-checked")).toBe("true");
    act(() =>
      useStore.setState({
        rpc: {
          [TAB]: rpcTabState({
            approvalPrompt: { prompt: GRANT_PROMPT, frame: { ...GRANT_FRAME, id: "g2" } },
          }),
        },
      }),
    );
    expect(alwaysSwitch().getAttribute("aria-checked")).toBe("false");
    expect(button("Approve Directory: /repo/src")).toBeTruthy();
  });
});

describe("ApprovalCard compound bash segments (issue #1208)", () => {
  const COMPOUND_DETAILS = [
    "Command:",
    "  ✓ git status (allowed: git *)",
    "  ✓ git diff (allowed: git *)",
    "  ? rm -rf build (requires approval)",
  ];

  it("marks allowed and needs-approval rows with distinct styles", () => {
    render({ ...PROMPT, details: COMPOUND_DETAILS });
    const allowed = [...document.querySelectorAll('[data-approval-segment="allowed"]')];
    const prompted = [...document.querySelectorAll('[data-approval-segment="prompted"]')];
    expect(allowed).toHaveLength(2);
    expect(prompted).toHaveLength(1);
    expect(allowed[0]!.textContent).toBe("  ✓ git status (allowed: git *)");
    expect(prompted[0]!.textContent).toBe("  ? rm -rf build (requires approval)");
    // Distinct theme classes: signal glyph on allowed, copper on prompted.
    expect(allowed[0]!.querySelector("span")?.classList.contains("text-signal")).toBe(true);
    expect(prompted[0]!.querySelector("span")?.classList.contains("text-copper")).toBe(true);
  });

  it("scrolls the first needs-approval row into view", () => {
    const scroll = vi.mocked(HTMLElement.prototype.scrollIntoView);
    scroll.mockClear();
    render({ ...PROMPT, details: COMPOUND_DETAILS });
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.calls[0]![0]).toEqual({ block: "nearest" });
    // The scrolled element is the first `?` row itself.
    expect(scroll.mock.instances[0]).toBe(document.querySelector('[data-approval-segment="prompted"]'));
  });

  it("renders a plain prompt exactly as before: one verbatim text block, no segment rows", () => {
    const scroll = vi.mocked(HTMLElement.prototype.scrollIntoView);
    scroll.mockClear();
    render(PROMPT);
    const pre = document.querySelector("[data-approval-card] pre")!;
    expect(pre.textContent).toBe("ls -la /etc");
    expect(pre.childNodes).toHaveLength(1);
    expect(pre.firstChild?.nodeType).toBe(Node.TEXT_NODE);
    expect(document.querySelector("[data-approval-segment]")).toBeNull();
    expect(scroll).not.toHaveBeenCalled();
  });
});

describe("ApprovalCard on a Routine run (ADR-0100, issue #1261)", () => {
  const SESSION_PROMPT = { ...PROMPT, sessionLabel: "Approve Bash for this session" };
  const SESSION_FRAME = { ...FRAME, options: ["Approve", "Approve Bash for this session", "Deny"] };
  const seed = (routine: boolean): void => {
    const state = remoteOwnedState(TAB, "inst-1");
    const session = state.remoteInstances[0]!.projects[0]!.sessions[0]!;
    session.routine = routine
      ? { id: "r".repeat(22), name: "Triage", approvalEntries: {}, deniedBuiltins: [], warnCostUsd: 2, maxCostUsd: 5 }
      : null;
    useStore.setState({ state });
  };
  afterEach(() => useStore.setState({ state: null }));

  it("renders Deny and Allow once only, never the session-wide option", () => {
    seed(true);
    render(SESSION_PROMPT, SESSION_FRAME);
    const texts = [...document.querySelectorAll("[data-approval-card] button")].map((b) => b.textContent);
    expect(texts).toEqual(["Deny", "Allow"]);
    act(() => button("Allow").click());
    expect(rpcSend).toHaveBeenCalledWith(TAB, { type: "extension_ui_response", id: "a1", value: "Approve" });
  });

  it("keeps the three options on an ordinary session", () => {
    seed(false);
    render(SESSION_PROMPT, SESSION_FRAME);
    const texts = [...document.querySelectorAll("[data-approval-card] button")].map((b) => b.textContent);
    expect(texts).toEqual(["Deny", "Approve Bash for this session", "Allow"]);
  });
});
