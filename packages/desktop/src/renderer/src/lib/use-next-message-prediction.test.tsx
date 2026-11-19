// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backendState, rpcTabState } from "../test/fixtures";
import { emptySessionRuntime } from "./rpc-types";
import type { RpcTabState } from "../store/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(window, { ompBackend: {} });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { PREDICTION_REQUEST_GRACE_MS, useNextMessagePrediction } = await import(
  "./use-next-message-prediction"
);

vi.useFakeTimers();

const TAB = "t1";

interface Probe {
  shown: boolean;
  text: string | null;
  accept(): string | null;
  noteEdit(): void;
}

let root: Root | null = null;
let probe: Probe | null = null;
let requestCalls: Array<[string, string]> = [];

/** Mutable props for the stable Harness below: a component identity that
 *  changed per render would remount the hook and reset its state. */
let currentProps = { tabId: TAB, text: "", active: true };

function Harness(): null {
  probe = useNextMessagePrediction(currentProps);
  return null;
}

function patchTab(patch: Partial<RpcTabState>, tabId = TAB): void {
  const current = useStore.getState().rpc[tabId];
  if (current === undefined) throw new Error("no tab state");
  act(() => {
    useStore.setState({ rpc: { ...useStore.getState().rpc, [tabId]: { ...current, ...patch } } });
  });
}

function publish(snapshot: Record<string, unknown> | null): void {
  patchTab({ composerPredictions: snapshot as RpcTabState["composerPredictions"] });
}

/** A fresh root for a fresh hook mount. */
function harness(): void {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
}

/** Render the hook with the composer state under test. */
function render(text: string, active: boolean, tabId = TAB): void {
  currentProps = { tabId, text, active };
  act(() => root!.render(<Harness />));
}

/** running → ready: the settle edge that arms one request. */
function settle(text = "", active = true): void {
  patchTab({ status: "running" });
  render(text, active);
  patchTab({ status: "ready" });
  render(text, active);
}

/** Advance past the grace so the arm's timer fires with its store reads. */
function passGrace(): void {
  act(() => {
    vi.advanceTimersByTime(PREDICTION_REQUEST_GRACE_MS + 50);
  });
}

function available(): void {
  publish({ version: 1, processKey: "p", revision: 1, available: true, unavailable: null, result: null });
}

function okResult(requestId: string, choices: string[], revision: number): void {
  publish({
    version: 1,
    processKey: "p",
    revision,
    available: true,
    unavailable: null,
    result: { requestId, ok: true, choices },
  });
}

beforeEach(() => {
  requestCalls = [];
  probe = null;
  currentProps = { tabId: TAB, text: "", active: true };
  useStore.setState({
    state: backendState(),
    rpc: {
      ...useStore.getState().rpc,
      [TAB]: rpcTabState({ session: { ...emptySessionRuntime(), sessionId: "s1" } }),
    },
  });
  useStore.setState({
    requestComposerPrediction: async (tabId: string, requestId: string): Promise<void> => {
      requestCalls.push([tabId, requestId]);
    },
  });
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("useNextMessagePrediction (#1239)", () => {
  it("arms nothing on mount over an idle session", () => {
    available();
    harness();
    render("", true);
    passGrace();
    expect(requestCalls).toHaveLength(0);
  });

  it("arms exactly one request per settle edge while every gate holds", () => {
    available();
    harness();
    render("", true);
    settle();
    passGrace();
    expect(requestCalls).toHaveLength(1);
    // Re-renders and elapsed time never re-arm the spent slot.
    render("", true);
    passGrace();
    expect(requestCalls).toHaveLength(1);
  });

  it("never bills when the bridge says unavailable (the opt-out route)", () => {
    publish({
      version: 1,
      processKey: "p",
      revision: 1,
      available: false,
      unavailable: "settings-off",
      result: null,
    });
    harness();
    render("", true);
    settle();
    passGrace();
    expect(requestCalls).toHaveLength(0);
  });

  it("never bills with no snapshot yet (older harness or un-armed bridge)", () => {
    harness();
    render("", true);
    settle();
    passGrace();
    expect(requestCalls).toHaveLength(0);
  });

  it("does not arm for a non-empty draft", () => {
    available();
    harness();
    render("typed", true);
    settle("typed");
    passGrace();
    expect(requestCalls).toHaveLength(0);
  });

  it("does not arm while the composer is inactive", () => {
    available();
    harness();
    render("", false);
    settle("", false);
    passGrace();
    expect(requestCalls).toHaveLength(0);
  });

  it("paints the correlated ok result as the ghost and inserts it on accept", () => {
    available();
    harness();
    render("", true);
    settle();
    passGrace();
    const requestId = requestCalls[0]![1];
    okResult(requestId, ["Ship it", "Run tests first"], 2);
    render("", true);
    expect(probe!.shown).toBe(true);
    // Only the first choice renders here; the pick list is issue #1030's.
    expect(probe!.text).toBe("Ship it");

    let inserted: string | null = null;
    act(() => {
      inserted = probe!.accept();
    });
    expect(inserted).toBe("Ship it");
    render("Ship it", true);
    expect(probe!.shown).toBe(false);
    expect(probe!.text).toBeNull();
    // A second accept on the cleared state asks for nothing.
    expect(probe!.accept()).toBeNull();
  });

  it("hides while inactive without retiring: refocus shows the offer again", () => {
    available();
    harness();
    render("", true);
    settle();
    passGrace();
    const requestId = requestCalls[0]![1];
    okResult(requestId, ["Ship it"], 2);
    render("", false);
    expect(probe!.shown).toBe(false);
    render("", true);
    expect(probe!.shown).toBe(true);
    // A draft belongs to ordinary typing and the word ghost, never this one.
    render("S", true);
    expect(probe!.shown).toBe(false);
  });

  it("noteEdit retires the offer so Tab falls through afterwards", () => {
    available();
    harness();
    render("", true);
    settle();
    passGrace();
    const requestId = requestCalls[0]![1];
    okResult(requestId, ["Ship it"], 2);
    render("", true);
    act(() => {
      probe!.noteEdit();
    });
    render("", true);
    expect(probe!.shown).toBe(false);
    expect(probe!.accept()).toBeNull();
  });

  it("a failure result retires the slot; the next settle re-arms", () => {
    available();
    harness();
    render("", true);
    settle();
    passGrace();
    const requestId = requestCalls[0]![1];
    publish({
      version: 1,
      processKey: "p",
      revision: 2,
      available: true,
      unavailable: null,
      result: { requestId, ok: false, reason: "skipped" },
    });
    render("", true);
    expect(probe!.shown).toBe(false);
    settle();
    passGrace();
    expect(requestCalls).toHaveLength(2);
  });

  it("ignores a result correlated with another requestId", () => {
    available();
    harness();
    render("", true);
    settle();
    passGrace();
    okResult("someone-else", ["Not mine"], 2);
    render("", true);
    expect(probe!.shown).toBe(false);
    // Our own request slot is untouched; the correlated answer paints.
    const requestId = requestCalls[0]![1];
    okResult(requestId, ["Mine"], 3);
    render("", true);
    expect(probe!.text).toBe("Mine");
  });

  it("a new message mid-flight retires the pending request", () => {
    available();
    harness();
    render("", true);
    settle();
    passGrace();
    const requestId = requestCalls[0]![1];
    // The new message row moves the transcript: the pending ghost is discarded.
    patchTab({ transcriptRevision: (useStore.getState().rpc[TAB]?.transcriptRevision ?? 0) + 1 });
    render("", true);
    expect(probe!.shown).toBe(false);
    // The bridge's stale publish for the retired request can no longer paint.
    publish({
      version: 1,
      processKey: "p",
      revision: 2,
      available: true,
      unavailable: null,
      result: { requestId, ok: false, reason: "stale" },
    });
    render("", true);
    expect(probe!.shown).toBe(false);
  });

  it("a session change under the tab discards a painted ghost", () => {
    available();
    harness();
    render("", true);
    settle();
    passGrace();
    const requestId = requestCalls[0]![1];
    okResult(requestId, ["Ship it"], 2);
    render("", true);
    expect(probe!.text).toBe("Ship it");
    patchTab({ session: { ...useStore.getState().rpc[TAB]!.session, sessionId: "s2" } });
    render("", true);
    expect(probe!.text).toBeNull();
    expect(probe!.shown).toBe(false);
  });

  it("late end-of-turn rows after accept discard nothing and re-arm nothing", () => {
    available();
    harness();
    render("", true);
    settle();
    passGrace();
    const requestId = requestCalls[0]![1];
    okResult(requestId, ["Ship it"], 2);
    render("", true);
    act(() => {
      expect(probe!.accept()).toBe("Ship it");
    });
    // Late usage/queue rows move the revision with nothing outstanding.
    patchTab({ transcriptRevision: (useStore.getState().rpc[TAB]?.transcriptRevision ?? 0) + 1 });
    render("", true);
    passGrace();
    expect(requestCalls).toHaveLength(1);
  });

  it("a prior tab's correlated result can never paint on a fresh mount", () => {
    available();
    harness();
    render("", true);
    settle();
    passGrace();
    const requestId = requestCalls[0]![1];

    const other = "t2";
    const base = useStore.getState().rpc[TAB]!;
    useStore.setState({ rpc: { ...useStore.getState().rpc, [other]: { ...base } } });
    harness();
    render("", true, other);
    // No settle edge on the new tab: nothing armed.
    passGrace();
    expect(requestCalls).toHaveLength(1);
    patchTab(
      {
        composerPredictions: {
          version: 1,
          processKey: "p",
          revision: 2,
          available: true,
          unavailable: null,
          result: { requestId, ok: true, choices: ["Old tab"] },
        } as RpcTabState["composerPredictions"],
      },
      other,
    );
    render("", true, other);
    expect(probe!.text).toBeNull();
  });

  it("a turn restart during the grace delays the arm to the new settle", () => {
    available();
    harness();
    render("", true);
    patchTab({ status: "running" });
    render("", true);
    patchTab({ status: "ready" });
    render("", true);
    // Half the grace passes, then a new turn starts and clears the timer.
    act(() => {
      vi.advanceTimersByTime(PREDICTION_REQUEST_GRACE_MS / 2);
    });
    patchTab({ status: "running" });
    render("", true);
    passGrace();
    expect(requestCalls).toHaveLength(0);
    // The new turn settles: exactly one request for it.
    patchTab({ status: "ready" });
    render("", true);
    passGrace();
    expect(requestCalls).toHaveLength(1);
  });
});
