// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { rpcTabState } from "../test/fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalPrompt } from "@omp-ui/core/approval";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
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
};

let root: Root | null = null;

function render(prompt: ApprovalPrompt | null): void {
  useStore.setState({
    rpc: {
      [TAB]: rpcTabState({
        approvalPrompt: prompt === null ? null : { prompt, frame: FRAME },
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
