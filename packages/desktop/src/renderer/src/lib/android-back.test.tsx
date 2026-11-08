// @vitest-environment jsdom
import { act, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AndroidBackTab } from "./android-back";
import { useDismissal } from "./use-dismissal";
import { Modal, Sheet } from "../components/ui";
import { rpcTabState } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
const rpcSend = vi.fn();
Object.assign(window, { ompBackend: { rpcSend } });
// Test module-loading boundary: backend.ts captures window.ompBackend on
// evaluation, so the real store and its consumers must load after the stub.
const { useStore } = await import("../store");
const { ComposerPlusMenu } = await import("../components/ComposerPlusMenu");
const { ExtensionDialogHost } = await import("../components/ExtensionDialogHost");

let root: Root | null = null;
const action = vi.fn();

function Menu() {
  return <ComposerPlusMenu tabId="tab" disabled={false} voiceRow={null} dictateDisabled={false}
    liveStartBlocked={false} draftEmpty stash="pick" onAttach={action} onDictate={action}
    onInsert={action} onStash={action} />;
}

function render(node: ReactNode): void {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(node));
}

function back(): Event {
  const event = new Event("omp-android-back", { cancelable: true });
  act(() => { window.dispatchEvent(event); });
  return event;
}

function openMenu(): void {
  const trigger = document.querySelector<HTMLButtonElement>('[aria-haspopup="menu"]')!;
  act(() => trigger.click());
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  action.mockClear();
  rpcSend.mockClear();
  useStore.setState({ rpc: {} });
});
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("Android visual Back ownership", () => {
  it("keeps a modal above a later-mounted sibling sheet", () => {
    const sheetClose = vi.fn();
    const modalClose = vi.fn();
    render(<><Modal onClose={modalClose}>modal body</Modal>
      <Sheet open placement="bottom" label="Below modal" onClose={sheetClose}>sheet body</Sheet></>);
    expect(back().defaultPrevented).toBe(true);
    expect(modalClose).toHaveBeenCalledOnce();
    expect(sheetClose).not.toHaveBeenCalled();
  });

  it.each(["sheet", "modal"])("closes the real menu above a %s, then closes the owning surface", (kind) => {
    function Surface() {
      const [open, setOpen] = useState(true);
      if (!open) return <p>surface closed</p>;
      const contents = <Menu />;
      return kind === "sheet"
        ? <Sheet open placement="bottom" label="Options" onClose={() => setOpen(false)}>{contents}</Sheet>
        : <Modal onClose={() => setOpen(false)}>{contents}</Modal>;
    }
    render(<Surface />);
    openMenu();
    expect(back().defaultPrevented).toBe(true);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(action).not.toHaveBeenCalled();
    expect(back().defaultPrevented).toBe(true);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.body.textContent).toContain("surface closed");
    expect(back().defaultPrevented).toBe(false);
  });

  it("peels nested sheets one at a time even when mounted together", () => {
    function Stack() {
      const [outer, setOuter] = useState(true);
      const [inner, setInner] = useState(true);
      return <Sheet open={outer} placement="left" label="Outer" onClose={() => setOuter(false)}>
        outer body
        <Sheet open={inner} placement="bottom" label="Inner" onClose={() => setInner(false)}>inner body</Sheet>
      </Sheet>;
    }
    render(<Stack />);
    back();
    expect(document.querySelector('[aria-label="Inner"]')).toBeNull();
    expect(document.querySelector('[aria-label="Outer"]')).not.toBeNull();
    back();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(back().defaultPrevented).toBe(false);
  });

  it("keeps an unrelated underlying menu open while the topmost modal closes", () => {
    const close = vi.fn();
    function Stack() {
      const [open, setOpen] = useState(false);
      return <><Menu /><button id="show-modal" onClick={() => setOpen(true)}>show</button>
        {open && <Modal onClose={() => { close(); setOpen(false); }}>top modal</Modal>}
      </>;
    }
    render(<Stack />);
    openMenu();
    act(() => document.querySelector<HTMLButtonElement>("#show-modal")!.click());
    back();
    expect(close).toHaveBeenCalledOnce();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    back();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(action).not.toHaveBeenCalled();
  });

  it("blocks on a visible agent prompt rather than closing an underlying menu or answering", () => {
    const frame = { id: "decision", method: "confirm", title: "Keep waiting" };
    useStore.setState({ rpc: { tab: rpcTabState({ extensionQueue: [frame] }) } });
    render(<><Menu /><ExtensionDialogHost tabId="tab" /></>);
    openMenu();
    expect(back().defaultPrevented).toBe(true);
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(document.body.textContent).toContain("Keep waiting");
    expect(useStore.getState().rpc.tab!.extensionQueue).toEqual([frame]);
    expect(rpcSend).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });

  it("ignores hidden tab portals, including a tab hidden after its modal opened", () => {
    const hiddenClose = vi.fn();
    const visibleClose = vi.fn();
    render(<>
      <div data-tab-id="visible"><AndroidBackTab.Provider value="visible">
        <Sheet open placement="left" label="Visible" onClose={visibleClose}>visible body</Sheet>
      </AndroidBackTab.Provider></div>
      <div data-tab-id="hidden"><AndroidBackTab.Provider value="hidden">
        <Modal onClose={hiddenClose}>hidden body</Modal>
      </AndroidBackTab.Provider></div>
    </>);
    document.querySelector<HTMLElement>('[data-tab-id="hidden"]')!.style.display = "none";
    back();
    expect(visibleClose).toHaveBeenCalledOnce();
    expect(hiddenClose).not.toHaveBeenCalled();
    document.querySelector<HTMLElement>('[data-tab-id="visible"]')!.style.display = "none";
    expect(back().defaultPrevented).toBe(false);
    expect(hiddenClose).not.toHaveBeenCalled();
    document.querySelector<HTMLElement>('[data-tab-id="hidden"]')!.style.display = "block";
    back();
    expect(hiddenClose).toHaveBeenCalledOnce();
  });

  it("ignores a hidden popover anchor even when its portaled panel is connected", () => {
    const close = vi.fn();
    function Portal() {
      const anchor = useRef<HTMLDivElement>(null);
      const panel = useRef<HTMLDivElement>(null);
      useDismissal({ open: true, refs: [anchor, panel], onClose: close });
      return <><div hidden><div ref={anchor}>anchor</div></div>
        {createPortal(<div ref={panel}>portaled panel</div>, document.body)}</>;
    }
    render(<Portal />);
    expect(back().defaultPrevented).toBe(false);
    expect(close).not.toHaveBeenCalled();
    act(() => root!.unmount());
    root = null;
    expect(back().defaultPrevented).toBe(false);
    expect(close).not.toHaveBeenCalled();
  });

  it("blocks a non-dismissible modal without closing a lower sheet", () => {
    const close = vi.fn();
    render(<Sheet open placement="left" label="Underneath" onClose={close}>
      <Modal>decision still pending</Modal>
    </Sheet>);
    expect(back().defaultPrevented).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
  });
});
