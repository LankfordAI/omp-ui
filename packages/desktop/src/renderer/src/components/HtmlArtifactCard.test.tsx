// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HTML_ARTIFACT_DEFAULT_HEIGHT, HTML_ARTIFACT_MAX_HEIGHT, HTML_ARTIFACT_PARTITION } from "@omp-ui/core/html-artifact";
import type { ToolItem } from "../lib/transcript";
import { backendState } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({ electron: true }));

vi.mock("../lib/platform", () => ({
  get IS_ELECTRON() {
    return mocks.electron;
  },
  IS_MAC: false,
  IS_WINDOWS: false,
}));

Object.assign(window, { ompBackend: {} });
// Dynamic imports are required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { HtmlArtifactCard } = await import("./HtmlArtifactCard");

let root: Root | null = null;

function artifact(overrides: Partial<ToolItem> = {}): ToolItem {
  return {
    kind: "tool",
    id: "t1",
    toolCallId: "call-1",
    name: "omp-ui_render_html",
    args: { title: "Chart", html: "<script>draw()</script><canvas></canvas>" },
    status: "done",
    ...overrides,
  };
}

function render(item: ToolItem): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<HtmlArtifactCard item={item} />));
  return host;
}

/** Replay a guest height report: Electron puts the target URL on the event. */
function reportHeight(el: Element, url: string): void {
  act(() => {
    el.dispatchEvent(Object.assign(new Event("did-navigate-in-page"), { url }));
  });
}

function frameStyle(el: Element | null, prop: "height"): string | null {
  return el instanceof HTMLElement ? el.style[prop] : null;
}

beforeEach(() => {
  mocks.electron = true;
  useStore.setState({ state: backendState({ htmlArtifactScripts: true }) });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("HtmlArtifactCard surface", () => {
  it("runs scripts only in a guest on the locked artifact partition", () => {
    const host = render(artifact());
    const guest = host.querySelector("webview");
    expect(guest?.getAttribute("partition")).toBe(HTML_ARTIFACT_PARTITION);
    expect(guest?.getAttribute("src")).toMatch(/^data:text\/html;charset=utf-8;base64,/);
    expect(host.querySelector("iframe")).toBeNull();
  });

  it.each([
    ["the scripts setting is off", true, false],
    ["the viewer is a browser client", false, true],
  ])("never runs a script when %s", (_label, electron, setting) => {
    mocks.electron = electron;
    useStore.setState({ state: backendState({ htmlArtifactScripts: setting }) });
    const host = render(artifact());
    expect(host.querySelector("webview")).toBeNull();
    const frame = host.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("srcdoc")).toContain("script-src 'none'");
  });

  it("shows no document for a refused or still-streaming call", () => {
    for (const item of [
      artifact({ args: { title: "Chart" }, status: "error", resultText: "render_html refused: html must be a non-empty string" }),
      artifact({ status: "running" }),
    ]) {
      const host = render(item);
      expect(host.querySelector("webview, iframe")).toBeNull();
      act(() => root?.unmount());
      root = null;
    }
  });
});

describe("HtmlArtifactCard flush posture", () => {
  it("wears no chrome: no header, chip, or height steppers", () => {
    const host = render(artifact());
    expect(host.textContent).not.toContain("interactive");
    expect(host.querySelector('[aria-label="Taller"]')).toBeNull();
    expect(host.querySelector('[aria-label="Shorter"]')).toBeNull();
    // The document keeps its accessible name, and expand survives on the pill.
    expect(host.querySelector("h3.sr-only")?.textContent).toBe("Chart");
    expect(host.querySelector('[aria-label="Expand to full view"]')).not.toBeNull();
  });

  it("sizes the frame from the guest height channel", () => {
    const host = render(artifact());
    const guest = host.querySelector("webview");
    // Before the first report, the requested hint height shows.
    expect(frameStyle(guest, "height")).toBe(`${HTML_ARTIFACT_DEFAULT_HEIGHT}px`);
    reportHeight(guest!, "#omph640");
    expect(frameStyle(guest, "height")).toBe("640px");
  });

  it("clamps a reported height to the inline cap", () => {
    const host = render(artifact());
    const guest = host.querySelector("webview")!;
    reportHeight(guest, "data:text/html;charset=utf-8;base64,AAA#omph99999");
    expect(frameStyle(guest, "height")).toBe(`${HTML_ARTIFACT_MAX_HEIGHT}px`);
  });

  it("ignores a fragment navigation that is not a height report", () => {
    const host = render(artifact());
    const guest = host.querySelector("webview")!;
    reportHeight(guest, "about:blank#section-2");
    reportHeight(guest, "#omphNaN");
    expect(frameStyle(guest, "height")).toBe(`${HTML_ARTIFACT_DEFAULT_HEIGHT}px`);
  });

  it("keeps the requested height for the static iframe, which has no stub", () => {
    mocks.electron = false;
    useStore.setState({ state: backendState({ htmlArtifactScripts: true }) });
    const host = render(artifact({ args: { title: "Chart", html: "<b>x</b>", height: 500 } }));
    const frame = host.querySelector("iframe")!;
    expect(frameStyle(frame, "height")).toBe("500px");
    reportHeight(frame, "#omph640");
    expect(frameStyle(frame, "height")).toBe("500px");
  });

  it("shows a faint running line with no guest", () => {
    const host = render(artifact({ status: "running" }));
    expect(host.querySelector("webview, iframe")).toBeNull();
    expect(host.textContent).toContain("running");
    expect(host.querySelector(".animate-rise .h-px")).not.toBeNull();
  });

  it("shows the failure slab bare with no guest", () => {
    const host = render(
      artifact({ status: "error", resultText: "render_html refused: html must be a non-empty string" }),
    );
    expect(host.querySelector("webview, iframe")).toBeNull();
    expect(host.textContent).toContain("html must be a non-empty string");
  });
});
