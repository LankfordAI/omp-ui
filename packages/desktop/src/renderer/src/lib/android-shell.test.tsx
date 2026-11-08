// @vitest-environment jsdom
import { act, type Dispatch, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ANDROID_VIEW_STORAGE_KEY, androidViewStorage, loadAndroidDraft, useComposerText, type AndroidSubmissionRecovery } from "./android-shell";
import { DESKTOP_VIEW_STORAGE_KEY, loadDesktopView } from "./desktop-view-state";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | null = null;
let setText: Dispatch<SetStateAction<string>>;
let text = "";
let recovery: AndroidSubmissionRecovery;

function Probe({ tabId }: { tabId: string }) {
  [text, setText, recovery] = useComposerText(tabId);
  return <textarea value={text} readOnly />;
}
function mount(tabId = "one") {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Probe tabId={tabId} />));
}
function restart(tabId = "one") {
  act(() => root!.unmount());
  root = null;
  mount(tabId);
}

beforeEach(() => {
  window.localStorage.clear();
  window.__ompAndroidViewport = { bookSplitX: null };
});
afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  delete window.__ompAndroidViewport;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Android-only bounded text recovery", () => {
  it("keys draft text by tab and synchronously clears a committed draft", () => {
    mount();
    act(() => {
      setText("one's draft");
      setText((previous) => previous + "\nnext line");
    });
    act(() => root!.render(<Probe tabId="two" />));
    expect(text).toBe("");
    act(() => setText("two's draft"));
    expect(loadAndroidDraft("one")).toBe("one's draft\nnext line");
    restart("one");
    expect(text).toBe("one's draft\nnext line");
    act(() => {
      setText("");
      expect(loadAndroidDraft("one")).toBe("");
    });
    restart("one");
    expect(text).toBe("");
    expect(loadAndroidDraft("two")).toBe("two's draft");
  });

  it("never writes or reads a draft without the native marker", () => {
    delete window.__ompAndroidViewport;
    mount();
    const write = vi.spyOn(Storage.prototype, "setItem");
    act(() => setText("browser text remains memory-only"));
    expect(write).not.toHaveBeenCalled();
    restart();
    expect(text).toBe("");
  });

  it("ignores corrupt persisted text and replaces it on the next edit", () => {
    mount();
    act(() => setText("before corruption"));
    const key = window.localStorage.key(0)!;
    window.localStorage.setItem(key, "{not json");
    restart();
    expect(text).toBe("");
    act(() => setText("after corruption"));
    restart();
    expect(text).toBe("after corruption");
    window.localStorage.setItem(key, JSON.stringify([{ tabId: "one", text: { secret: "invalid" } }]));
    restart();
    expect(text).toBe("");
  });

  it("keeps typing and clearing when localStorage is denied or full", () => {
    const denied = vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("denied"); });
    mount();
    act(() => setText("still editable"));
    expect(text).toBe("still editable");
    denied.mockRestore();
    const full = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
    act(() => setText("not blocked by quota"));
    expect(text).toBe("not blocked by quota");
    full.mockRestore();
    act(() => setText("persisted"));
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new Error("denied"); });
    act(() => setText(""));
    expect(text).toBe("");
  });

  it("bounds saved draft count and never restores a silently truncated long prompt", () => {
    mount();
    for (let i = 0; i < 20; i++) {
      act(() => root!.render(<Probe tabId={`tab-${i}`} />));
      act(() => setText(`draft-${i}`));
    }
    expect(loadAndroidDraft("tab-0")).toBe("");
    expect(loadAndroidDraft("tab-19")).toBe("draft-19");
    const long = "x".repeat(32_769);
    act(() => setText(long));
    expect(text).toBe(long);
    expect(loadAndroidDraft("tab-19")).toBe("");
    restart("tab-19");
    expect(text).toBe("");
  });

  it("does not write on unrelated rerenders", () => {
    mount();
    act(() => setText("unchanged"));
    const write = vi.spyOn(Storage.prototype, "setItem");
    act(() => root!.render(<Probe tabId="one" />));
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps an unconfirmed submission separate until explicitly recovered", () => {
    mount();
    let finish: ((accepted: boolean) => void) | null = null;
    act(() => setText("delivery uncertain"));
    act(() => {
      finish = recovery.beginSubmission(text);
      setText("");
    });
    restart();
    expect(text).toBe("");
    expect(recovery.pendingText).toBe("delivery uncertain");
    act(() => recovery.recover());
    expect(text).toBe("delivery uncertain");
    expect(recovery.pendingText).toBeNull();
    restart();
    expect(text).toBe("delivery uncertain");
    act(() => finish!(true));
    expect(loadAndroidDraft("one")).toBe("delivery uncertain");
  });

  it("retires only the accepted submission and never erases a newer draft", () => {
    mount();
    let first: ((accepted: boolean) => void) | null = null;
    let second: ((accepted: boolean) => void) | null = null;
    act(() => {
      first = recovery.beginSubmission("first");
      second = recovery.beginSubmission("second");
      setText("new unsent draft");
      first!(true);
    });
    restart();
    expect(text).toBe("new unsent draft");
    expect(recovery.pendingText).toBe("second");
    act(() => second!(true));
    restart();
    expect(text).toBe("new unsent draft");
    expect(recovery.pendingText).toBeNull();
  });

  it("allows an uncertain copy to be dismissed without discarding the current draft", () => {
    mount();
    act(() => {
      recovery.beginSubmission("maybe sent");
      setText("keep this draft");
    });
    restart();
    act(() => recovery.dismiss());
    restart();
    expect(text).toBe("keep this draft");
    expect(recovery.pendingText).toBeNull();
  });

  it("keeps oversized submissions memory-only without truncating them", () => {
    mount();
    const long = "x".repeat(32_769);
    expect(recovery.beginSubmission(long)).toBeNull();
    act(() => setText(long));
    expect(text).toBe(long);
    restart();
    expect(recovery.pendingText).toBeNull();
  });

  it("isolates and bounds the view snapshot without throwing on corruption", () => {
    const storage = androidViewStorage()!;
    storage.setItem(DESKTOP_VIEW_STORAGE_KEY, "{broken");
    expect(window.localStorage.getItem(DESKTOP_VIEW_STORAGE_KEY)).toBeNull();
    expect(window.localStorage.getItem(ANDROID_VIEW_STORAGE_KEY)).toBe("{broken");
    expect(loadDesktopView(storage)).toBeNull();
    window.localStorage.setItem(ANDROID_VIEW_STORAGE_KEY, "x".repeat(65_537));
    expect(storage.getItem(DESKTOP_VIEW_STORAGE_KEY)).toBeNull();
    delete window.__ompAndroidViewport;
    expect(androidViewStorage()).toBeNull();
  });
});
