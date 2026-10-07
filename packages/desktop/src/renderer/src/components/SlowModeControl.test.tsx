// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CapabilitySnapshot } from "@omp-ui/core/capabilities";
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

const gate = (ompVersion: string | null): CapabilitySnapshot => ({
  version: 1 as const,
  processKey: "p",
  sessionId: null,
  revision: 1,
  updatedAt: 0,
  ompVersion,
  skillCommandsEnabled: null,
  skills: { status: "unavailable", reason: "missing-api" },
  tools: { status: "unavailable", reason: "missing-api" },
  magicKeywords: { status: "available", items: [] },
  toolControl: "unsupported",
  toolMutation: null,
});

/** Seeds the gate pair plus the setting truth; version null reads incapable. */
const seed = (
  opts: {
    supported?: boolean;
    enabled?: boolean;
    scope?: "session" | "global" | null;
    version?: string | null;
  },
): void => {
  useStore.setState({
    rpc: {
      [TAB]: rpcTabState({
        status: "ready",
        capabilities: gate(opts.version === undefined ? "18.7.0" : opts.version),
        session: {
          ...emptySessionRuntime(),
          slowModeSupported: opts.supported ?? false,
          slowModeEnabled: opts.enabled ?? false,
          slowModeScope: opts.scope ?? null,
        },
      }),
    },
  });
};

const render = (layout?: "inline" | "sheet"): HTMLElement => {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<SlowModeControl tabId={TAB} layout={layout} />));
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
  it("renders nothing when the runtime reports no support", () => {
    seed({ supported: false, enabled: true });
    expect(render().textContent).toBe("");
  });

  it("renders nothing below 18.6.3 even when the flag says supported", () => {
    seed({ supported: true, enabled: true, version: "18.4.11" });
    expect(render().textContent).toBe("");
  });

  it("renders nothing when the version is unknown", () => {
    seed({ supported: true, enabled: true, version: null });
    expect(render().textContent).toBe("");
  });

  it("hides the inline capsule while slow mode is off", () => {
    seed({ supported: true, enabled: false });
    expect(render().textContent).toBe("");
  });

  it("shows the signal capsule when on, naming the global scope in the tooltip", () => {
    seed({ supported: true, enabled: true, scope: "global" });
    const chip = render().querySelector<HTMLButtonElement>("button")!;
    expect(chip).not.toBeNull();
    expect(chip.textContent).toContain(t("hud.slow.label"));
    expect(chip.getAttribute("aria-label")).toBe(
      `${t("hud.slow.onTitle")} · ${t("hud.slow.scopeGlobalTitle")}`,
    );
    expect(chip.querySelector("span")?.classList.contains("bg-signal")).toBe(true);
  });

  it("omits the scope clause when the scope is unknown", () => {
    seed({ supported: true, enabled: true, scope: null });
    const chip = render().querySelector<HTMLButtonElement>("button")!;
    expect(chip.getAttribute("aria-label")).toBe(t("hud.slow.onTitle"));
  });

  it("a capsule click turns slow mode off", () => {
    seed({ supported: true, enabled: true });
    const chip = render().querySelector<HTMLButtonElement>("button")!;
    act(() => chip.click());
    expect(setSlowMode).toHaveBeenCalledWith(TAB, false);
  });

  it("the sheet row stays reachable while off and sends the enable", () => {
    seed({ supported: true, enabled: false });
    const host = render("sheet");
    const sw = host.querySelector<HTMLButtonElement>(
      'button[role="switch"][aria-label="slow mode"]',
    )!;
    expect(sw).not.toBeNull();
    expect(sw.getAttribute("title")).toBe(t("hud.slow.offTitle"));
    act(() => sw.click());
    expect(setSlowMode).toHaveBeenCalledWith(TAB, true);
  });

  it("appends the scope word to the sheet's on-state line", () => {
    seed({ supported: true, enabled: true, scope: "global" });
    const host = render("sheet");
    expect(host.textContent).toContain(`${t("hud.slow.on")} · ${t("hud.slow.stageGlobal")}`);
  });

  it("names the session scope word when the flex tier is session-scoped", () => {
    seed({ supported: true, enabled: true, scope: "session" });
    const host = render("sheet");
    expect(host.textContent).toContain(`${t("hud.slow.on")} · ${t("hud.slow.stageSession")}`);
  });
});
