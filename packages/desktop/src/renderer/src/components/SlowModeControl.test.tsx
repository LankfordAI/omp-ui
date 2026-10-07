// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySessionRuntime } from "../lib/rpc-types";
import { rpcTabState } from "../test/fixtures";
import { t } from "../lib/i18n";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(window, { ompBackend: {} });
// Dynamic import is required because store.ts captures window.ompBackend at
// module evaluation.
const { useStore } = await import("../store");
const { SlowModeControl } = await import("./SlowModeControl");

const TAB = "tab-slow";
const setSlowMode = vi.fn(async () => {});
let root: Root | null = null;

/** Seeds the setting truth the control reads; support is the callsite's gate. */
const seed = (
  opts: { enabled?: boolean; scope?: "session" | "global" | null },
): void => {
  useStore.setState({
    rpc: {
      [TAB]: rpcTabState({
        status: "ready",
        session: {
          ...emptySessionRuntime(),
          slowModeSupported: true,
          slowModeEnabled: opts.enabled ?? false,
          slowModeScope: opts.scope ?? null,
        },
      }),
    },
  });
};

const render = (layout?: "inline" | "sheet", disabled = false): HTMLElement => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<SlowModeControl tabId={TAB} layout={layout} disabled={disabled} />));
  return host;
};

beforeEach(() => {
  vi.clearAllMocks();
  useStore.setState({ setSlowMode });
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.innerHTML = "";
});

describe("SlowModeControl (issue #777)", () => {
  it("titles an enabled capsule with the shared-setting text only for global scope", () => {
    seed({ enabled: true, scope: "global" });
    expect(
      render().querySelector("button")?.getAttribute("aria-label"),
    ).toBe(t("hud.slow.onGlobalTitle"));
    act(() => root?.unmount());
    root = null;
    seed({ enabled: true, scope: "session" });
    expect(render().querySelector("button")?.getAttribute("aria-label")).toBe(
      t("hud.slow.onTitle"),
    );
  });

  it("titles a disabled-scope capsule with the per-session off text when scope is unknown", () => {
    seed({ enabled: false, scope: null });
    expect(render().querySelector("button")?.getAttribute("aria-label")).toBe(
      t("hud.slow.offTitle"),
    );
  });

  it("titles a global-scope off capsule with the shared-setting off text", () => {
    seed({ enabled: false, scope: "global" });
    expect(render().querySelector("button")?.getAttribute("aria-label")).toBe(
      t("hud.slow.offGlobalTitle"),
    );
  });

  it("shows the copper dot while on and neutral while off", () => {
    seed({ enabled: true });
    const dot = render().querySelector("button span")!;
    expect(dot.classList.contains("bg-copper")).toBe(true);
    act(() => root?.unmount());
    root = null;
    seed({ enabled: false });
    expect(render().querySelector("button span")?.classList.contains("bg-copper")).toBe(false);
  });

  it("a capsule click sends the toggled setting", () => {
    seed({ enabled: true });
    const on = render();
    act(() => on.querySelector("button")!.click());
    expect(setSlowMode).toHaveBeenCalledWith(TAB, false);
    act(() => root?.unmount());
    root = null;
    seed({ enabled: false });
    const off = render();
    act(() => off.querySelector("button")!.click());
    expect(setSlowMode).toHaveBeenCalledWith(TAB, true);
  });

  it("the sheet row keeps the switch reachable while off and titles by scope", () => {
    seed({ enabled: false, scope: "global" });
    const host = render("sheet");
    const sw = host.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(sw.getAttribute("title")).toBe(t("hud.slow.offGlobalTitle"));
    act(() => sw.click());
    expect(setSlowMode).toHaveBeenCalledWith(TAB, true);
  });

  it("the sheet on-state line names the setting, not a tier", () => {
    seed({ enabled: true, scope: "global" });
    const host = render("sheet");
    expect(host.textContent).toContain(t("hud.slow.labelLong"));
    expect(host.textContent).toContain(t("hud.slow.on"));
  });

  it("disables both faces when the callsite marks the session unavailable", () => {
    seed({ enabled: true });
    expect(render(undefined, true).querySelector<HTMLButtonElement>("button")?.disabled).toBe(true);
    act(() => root?.unmount());
    root = null;
    expect(
      render("sheet", true).querySelector<HTMLButtonElement>('button[role="switch"]')?.disabled,
    ).toBe(true);
  });
});
