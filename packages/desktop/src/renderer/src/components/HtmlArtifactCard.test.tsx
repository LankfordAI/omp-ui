// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HTML_ARTIFACT_PARTITION } from "@omp-ui/core/html-artifact";
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
