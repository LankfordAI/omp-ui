// PROTOTYPE (#527) — throwaway. Activation gate, variant store, per-tab pane
// store, navigation model, and the fake agent driver. Module-level external
// stores (read via useSyncExternalStore), following InspectorRail's
// `selectedTab` precedent: view preference, not session state.
import { useSyncExternalStore } from "react";
import type { FakeFrame } from "./frame-source";

/** Inert in production builds and under vitest (MODE === "test"). */
export const PROTOTYPE_ACTIVE: boolean =
  import.meta.env.DEV && import.meta.env.MODE !== "test";

/* ---------------------------------------------------------------- variant */

export const VARIANTS = ["A", "B", "C"] as const;
export type Variant = (typeof VARIANTS)[number];
export const VARIANT_NAMES: Record<Variant, string> = {
  A: "Split beside the transcript (⤢ fullscreen → full column)",
  B: "Sixth inspector-rail pane",
  C: "Full-column view",
};

const variantListeners = new Set<() => void>();

function subscribeVariant(listener: () => void): () => void {
  variantListeners.add(listener);
  return () => {
    variantListeners.delete(listener);
  };
}

/** null when the prototype is inert (prod build, vitest). */
export function readVariant(): Variant | null {
  if (!PROTOTYPE_ACTIVE) return null;
  const raw = new URLSearchParams(window.location.search).get("variant")?.toUpperCase() ?? "";
  return (VARIANTS as readonly string[]).includes(raw) ? (raw as Variant) : "A";
}

export function setVariant(next: Variant): void {
  // Through searchParams.set, never a rebuilt query: the web client's ?token= must survive.
  const url = new URL(window.location.href);
  url.searchParams.set("variant", next);
  window.history.replaceState(null, "", url);
  for (const listener of variantListeners) listener();
}

export function cycleVariant(delta: 1 | -1): void {
  const current = readVariant() ?? "A";
  const index = VARIANTS.indexOf(current);
  setVariant(VARIANTS[(index + delta + VARIANTS.length) % VARIANTS.length]);
}

export function usePrototypeVariant(): Variant | null {
  return useSyncExternalStore(subscribeVariant, readVariant);
}

/* ------------------------------------------------------------- pane store */

export interface BrowserPaneState {
  open: boolean;
  /** null = nothing loaded yet (empty state). */
  url: string | null;
  history: string[];
  /** -1 while history is empty. */
  index: number;
  loading: boolean;
  /** performance.now() at the last navigate/reload. */
  loadingSince: number;
  /** Cleared 3 s after a navigation. */
  lastNav: "user" | "agent" | null;
  simulateAgent: boolean;
  agentConnected: boolean;
  /** 0..1 fractions of the frame. */
  agentCursor: { x: number; y: number } | null;
  /** Variant A only. */
  splitWidth: number;
  /** Variant A only (verdict follow-up): the split expanded into the full-column view. */
  fullscreen: boolean;
}

export const SPLIT_DEFAULT_WIDTH = 560;
export const SPLIT_MIN_WIDTH = 360;

const EMPTY: BrowserPaneState = {
  open: false,
  url: null,
  history: [],
  index: -1,
  loading: false,
  loadingSince: 0,
  lastNav: null,
  simulateAgent: false,
  agentConnected: false,
  agentCursor: null,
  splitWidth: SPLIT_DEFAULT_WIDTH,
  fullscreen: false,
};

const panes = new Map<string, BrowserPaneState>();
const paneListeners = new Set<() => void>();

interface PaneTimers {
  loading?: number;
  lastNav?: number;
  agentInterval?: number;
  agentTicks: number[];
}
const timers = new Map<string, PaneTimers>();

function timersFor(tabId: string): PaneTimers {
  let t = timers.get(tabId);
  if (t === undefined) {
    t = { agentTicks: [] };
    timers.set(tabId, t);
  }
  return t;
}

function subscribePane(listener: () => void): () => void {
  paneListeners.add(listener);
  return () => {
    paneListeners.delete(listener);
  };
}

/** Stable EMPTY object for unknown tabs — snapshots compare by identity. */
export function getPane(tabId: string): BrowserPaneState {
  return panes.get(tabId) ?? EMPTY;
}

function update(tabId: string, patch: Partial<BrowserPaneState>): void {
  panes.set(tabId, { ...getPane(tabId), ...patch });
  for (const listener of paneListeners) listener();
}

export function useBrowserPane(tabId: string): BrowserPaneState {
  return useSyncExternalStore(subscribePane, () => getPane(tabId));
}

export function setPaneOpen(tabId: string, open: boolean): void {
  // Closing leaves url/history intact — reopening restores the page.
  if (getPane(tabId).open !== open) update(tabId, { open });
}

export function toggleBrowserPane(tabId: string): void {
  update(tabId, { open: !getPane(tabId).open });
}

export function normalizeUrl(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    return new URL(withScheme).toString();
  } catch {
    return null;
  }
}

export function setFullscreen(tabId: string, on: boolean): void {
  if (getPane(tabId).fullscreen !== on) update(tabId, { fullscreen: on });
}

/** The 900 ms loading sweep plus the 3 s source chip; replaces both pending timers. */
function sweep(tabId: string, source: "user" | "agent"): Pick<BrowserPaneState, "loading" | "loadingSince" | "lastNav"> {
  const t = timersFor(tabId);
  window.clearTimeout(t.loading);
  window.clearTimeout(t.lastNav);
  t.loading = window.setTimeout(() => update(tabId, { loading: false }), 900);
  t.lastNav = window.setTimeout(() => update(tabId, { lastNav: null }), 3000);
  return { loading: true, loadingSince: performance.now(), lastNav: source };
}

export function navigate(tabId: string, url: string, source: "user" | "agent"): void {
  const state = getPane(tabId);
  const history = [...state.history.slice(0, state.index + 1), url];
  update(tabId, { history, index: history.length - 1, url, ...sweep(tabId, source) });
}

export function goBack(tabId: string): void {
  const state = getPane(tabId);
  if (state.index <= 0) return;
  const index = state.index - 1;
  update(tabId, { index, url: state.history[index], ...sweep(tabId, "user") });
}

export function goForward(tabId: string): void {
  const state = getPane(tabId);
  if (state.index >= state.history.length - 1) return;
  const index = state.index + 1;
  update(tabId, { index, url: state.history[index], ...sweep(tabId, "user") });
}

export function reload(tabId: string): void {
  if (getPane(tabId).url === null) return;
  update(tabId, sweep(tabId, "user"));
}

export function setSplitWidth(tabId: string, width: number): void {
  update(tabId, { splitWidth: width });
}

/* ------------------------------------------------------------ fake agent */

const AGENT_PATHS = ["/docs/getting-started", "/pricing", "/blog/launch-notes", "/about", "/docs/api"];

export function nextAgentUrl(current: string | null): string {
  if (current === null) return "https://example.com/";
  const url = new URL(current);
  // Unknown path → indexOf is -1 → index 0.
  url.pathname = AGENT_PATHS[(AGENT_PATHS.indexOf(url.pathname) + 1) % AGENT_PATHS.length];
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function setSimulateAgent(tabId: string, on: boolean): void {
  const t = timersFor(tabId);
  if (on) {
    if (t.agentInterval !== undefined) return;
    const tick = () => {
      update(tabId, { agentCursor: { x: 0.15 + 0.7 * Math.random(), y: 0.25 + 0.5 * Math.random() } });
      t.agentTicks.push(
        window.setTimeout(() => navigate(tabId, nextAgentUrl(getPane(tabId).url), "agent"), 600),
        window.setTimeout(() => update(tabId, { agentCursor: null }), 1400),
      );
    };
    t.agentInterval = window.setInterval(tick, 5000);
    update(tabId, { simulateAgent: true, agentConnected: true });
    return;
  }
  window.clearInterval(t.agentInterval);
  t.agentInterval = undefined;
  for (const id of t.agentTicks) window.clearTimeout(id);
  t.agentTicks = [];
  update(tabId, { simulateAgent: false, agentConnected: false, agentCursor: null });
}

/**
 * Latest encoded frame per tab — NOT in the reactive store (8 fps writes would
 * re-render every subscriber). Read by attachToPrompt and the switcher's readout.
 */
export const latestFrame = new Map<string, FakeFrame>();
