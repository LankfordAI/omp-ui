// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolItem } from "../lib/transcript";
import { backendState } from "../test/fixtures";

const mocks = vi.hoisted(() => ({ electron: true }));
vi.mock("../lib/platform", () => ({
  get IS_ELECTRON() { return mocks.electron; },
  IS_MAC: false,
  IS_WINDOWS: false,
}));
vi.mock("../backend", () => {
  const client = new Proxy({}, { get: () => async () => undefined });
  return { backend: client, backendFor: () => client, displayMessage: (error: unknown) => String(error) };
});

import { useStore } from "../store";
import { HtmlArtifactCard } from "./HtmlArtifactCard";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TAB = "lifecycle-tab";
let root: Root | null = null;
let host: HTMLElement;

function artifact(args: Record<string, unknown>): ToolItem {
  return { kind: "tool", id: "t1", toolCallId: "call-1", name: "omp-ui_render_html", args, status: "done" };
}

function render(item: ToolItem): void {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<HtmlArtifactCard item={item} tabId={TAB} />));
}

beforeEach(() => {
  mocks.electron = true;
  useStore.setState({ state: backendState({ htmlArtifactScripts: true, artifactLibraryEnabled: false }), activeTabId: TAB });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("HtmlArtifactCard guest lifecycle", () => {
  it("mounts no surface while its tab is hidden and keeps the clamped placeholder height", () => {
    render(artifact({ title: "Chart", html: "<p>plain</p>", height: 60 }));
    act(() => { useStore.setState({ activeTabId: "another-tab" }); });
    expect(host.querySelector("webview, iframe")).toBeNull();
    const placeholder = host.querySelector("div[aria-hidden]");
    expect(placeholder).not.toBeNull();
    // Requested hint 60 clamps up to the minimum guest height.
    expect(placeholder instanceof HTMLElement ? placeholder.style.height : null).toBe("120px");
  });

  it("runs scripts in a guest once visible again and keeps exactly one guest while expanded", () => {
    render(artifact({ title: "Chart", html: "<script>draw()</script>", height: 300 }));
    act(() => { useStore.setState({ activeTabId: "another-tab" }); });
    expect(host.querySelector("webview")).toBeNull();
    act(() => { useStore.setState({ activeTabId: TAB }); });
    expect(host.querySelector("webview")).not.toBeNull();
    const expand = [...host.querySelectorAll("button")].find(b => (b.getAttribute("aria-label") || "") === "Expand to full view");
    expect(expand).toBeDefined();
    act(() => { expand!.click(); });
    // Plain expansion swaps the inline surface for the placeholder: the modal viewer holds the one guest.
    expect(host.querySelector("webview")).toBeNull();
    expect(document.querySelectorAll("webview")).toHaveLength(1);
    const close = [...document.querySelectorAll("button")].find(b => (b.getAttribute("aria-label") || "") === "close dialog");
    expect(close).toBeDefined();
    act(() => { close!.click(); });
    // Closing restores the inline guest; the modal viewer's own guest is gone.
    expect(document.querySelectorAll('[role="dialog"] webview, dialog webview')).toHaveLength(0);
    expect(host.querySelector("webview")).not.toBeNull();
  });

  it("replaces a crashed plain guest with the trusted failure row and Reload remounts", () => {
    render(artifact({ title: "Chart", html: "<script>draw()</script>", height: 300 }));
    const frame = host.querySelector("webview");
    expect(frame).not.toBeNull();
    act(() => { frame!.dispatchEvent(new Event("render-process-gone")); });
    expect(host.querySelector("webview")).toBeNull();
    const alert = host.querySelector("[role='alert']");
    expect(alert?.textContent).toContain("This artifact failed to load.");
    expect(alert?.querySelector("button")?.textContent).toContain("Reload");
    act(() => { (alert!.querySelector("button") as HTMLButtonElement).click(); });
    expect(host.querySelector("webview")).not.toBeNull();
  });
});

describe("HtmlArtifactCard scripts-off hint", () => {
  it("names the scripts-off state only for script-bearing static documents", () => {
    useStore.setState({ state: backendState({ htmlArtifactScripts: false, artifactLibraryEnabled: false }), activeTabId: TAB });
    render(artifact({ title: "Chart", html: "<script>draw()</script><canvas></canvas>", height: 200 }));
    expect(host.querySelector("iframe")).not.toBeNull();
    const hint = [...host.querySelectorAll("span")].find(s => /scripts/i.test(s.textContent || ""));
    expect(hint?.textContent).toContain("off in Settings");
    act(() => root?.unmount());
    root = null;
    document.body.innerHTML = "";
    // A genuinely static document under scripts-off still wears zero chrome.
    render(artifact({ title: "Quiet", html: "<p>plain</p>", height: 200 }));
    expect([...host.querySelectorAll("span")].some(s => /scripts/i.test(s.textContent || ""))).toBe(false);
    expect(host.querySelector("[role='alert']")).toBeNull();
  });

  it("never hints on a desktop scripts-on guest", () => {
    render(artifact({ title: "Chart", html: "<script>draw()</script>", height: 200 }));
    expect(host.querySelector("webview")).not.toBeNull();
    expect([...host.querySelectorAll("span")].some(s => /scripts/i.test(s.textContent || ""))).toBe(false);
  });
});
