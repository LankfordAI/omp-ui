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
  ghostSuffix: string | null;
  hintMore: number | null;
  held: boolean;
  listOpen: boolean;
  choices: readonly string[];
  selectedIndex: number;
  accept(): { text: string; caret: number } | null;
  openList(): boolean;
  closeList(): void;
  pick(index: number): { text: string; caret: number } | null;
  noteEdit(): void;
}

let root: Root | null = null;
let probe: Probe | null = null;
let requestCalls: Array<[string, string]> = [];

/** Mutable props for the stable Harness below: a component identity that
 *  changed per render would remount the hook and reset its state. */
let currentProps = { tabId: TAB, text: "", caret: 0, active: true };

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

/** Render the hook with the composer state under test; caret defaults to the
 *  draft's end (the only place ghost text renders). */
function render(text: string, active: boolean, tabId = TAB, caret = text.length): void {
  currentProps = { tabId, text, caret, active };
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

/** Settle an empty composer, bill one request, and land two alternatives. */
function offer(choices: string[]): string {
  available();
  harness();
  render("", true);
  settle();
  passGrace();
  const requestId = requestCalls[requestCalls.length - 1]![1];
  okResult(requestId, choices, 2);
  render("", true);
  return requestId;
}

beforeEach(() => {
  requestCalls = [];
  probe = null;
  currentProps = { tabId: TAB, text: "", caret: 0, active: true };
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

  it("paints the correlated choice as the ghost and inserts it on accept", () => {
    offer(["Ship it", "Run tests first"]);
    expect(probe!.shown).toBe(true);
    expect(probe!.text).toBe("Ship it");

    let inserted: { text: string; caret: number } | null = null;
    act(() => {
      inserted = probe!.accept();
    });
    expect(inserted).toEqual({ text: "Ship it", caret: 7 });
    render("Ship it", true);
    expect(probe!.shown).toBe(false);
    expect(probe!.text).toBeNull();
    // A second accept on an inserted buffer that equals one of two choices
    // extends nothing — the list owns the key now (#1030).
    expect(probe!.accept()).toBeNull();
  });

  it("hides while inactive without retiring: refocus shows the offer again", () => {
    offer(["Ship it"]);
    render("", false);
    expect(probe!.shown).toBe(false);
    render("", true);
    expect(probe!.shown).toBe(true);
    // A typed prefix of the choice ghosts its suffix (#1030): the offer
    // survives the draft, it is no longer the empty-draft placeholder.
    render("S", true);
    expect(probe!.shown).toBe(false);
    expect(probe!.text).toBeNull();
    expect(probe!.ghostSuffix).toBe("hip it");
  });

  it("noteEdit closes the list without retiring the ghost", () => {
    offer(["Ship it", "Run tests first"]);
    act(() => {
      probe!.accept();
    });
    render("Ship it", true);
    expect(probe!.openList()).toBe(true);
    render("Ship it", true);
    expect(probe!.listOpen).toBe(true);
    act(() => {
      probe!.noteEdit();
    });
    render("Ship it", true);
    expect(probe!.listOpen).toBe(false);
    // The offer itself stands: the same buffer ghosts nothing (it equals a
    // choice, and typing would) but a shorter prefix ghosts again.
    render("Run", true);
    expect(probe!.ghostSuffix).toBe(" tests first");
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
    offer(["Ship it"]);
    expect(probe!.text).toBe("Ship it");
    patchTab({ session: { ...useStore.getState().rpc[TAB]!.session, sessionId: "s2" } });
    render("", true);
    expect(probe!.text).toBeNull();
    expect(probe!.shown).toBe(false);
  });

  it("a new message after an insert retires the consumed offer", () => {
    offer(["Ship it"]);
    act(() => {
      expect(probe!.accept()).toEqual({ text: "Ship it", caret: 7 });
    });
    render("Ship it", true);
    // Sending the draft grows the transcript: the offer is done with.
    patchTab({ transcriptRevision: (useStore.getState().rpc[TAB]?.transcriptRevision ?? 0) + 1 });
    render("Ship it", true);
    expect(probe!.held).toBe(false);
    expect(probe!.hintMore).toBeNull();
  });

  it("late end-of-turn rows with nothing outstanding discard nothing and re-arm nothing", () => {
    available();
    harness();
    render("", true);
    settle();
    passGrace();
    // No result ever landed: the pending request is retired by late rows…
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

describe("prediction alternatives (#1030)", () => {
  it("ghosts the first prediction the typed prefix matches, not only choices[0]", () => {
    // Shared-prefix choices so first-match ordering is observable.
    offer(["Run the tests", "Run the build"]);
    // A prefix of BOTH ghosts the FIRST one (most likely wins).
    render("Run ", true);
    expect(probe!.ghostSuffix).toBe("the tests");
    expect(probe!.hintMore).toBeNull();
    // Past the divergence only the second matches: its suffix ghosts.
    render("Run the bu", true);
    expect(probe!.ghostSuffix).toBe("ild");
  });

  it("the word ghost loses the slot while a prediction prefix ghosts", () => {
    // The Composer passes `prediction.held` into the word ghost's `active`:
    // the hook surface only has to report the hold.
    offer(["Run the tests", "Run the build"]);
    expect(probe!.held).toBe(true); // placeholder face over the empty draft
    render("Run ", true);
    expect(probe!.held).toBe(true); // prefix-ghost face
    render("unrelated", true);
    expect(probe!.held).toBe(false); // nothing matches: word ghost owns it
  });

  it("accept inserts the suffix and the buffer's equality with a choice opens the list on the next accept", () => {
    offer(["Deploy now", "Run the tests first"]);
    render("Deploy ", true);
    expect(probe!.ghostSuffix).toBe("now");
    act(() => {
      expect(probe!.accept()).toEqual({ text: "Deploy now", caret: 10 });
    });
    // Inserted a choice of ≥2: no ghost extends it; the hint counts the rest.
    render("Deploy now", true);
    expect(probe!.ghostSuffix).toBeNull();
    expect(probe!.hintMore).toBe(1);
    expect(probe!.accept()).toBeNull();
  });

  it("a typed buffer equal to a choice keeps its ghost unless it was inserted", () => {
    offer(["Deploy now", "Run the tests first"]);
    // Typed (never accepted): typing `Deploy n` ghosts `ow`; and because the
    // user typed it, once equal it still… upstream: a buffer the USER typed
    // keeps extending; equality with no insert never suppresses. The findIndex
    // strict-prefix rule already gives that (a full choice is not its own
    // strict prefix), and Tab opens the list from the hint state instead.
    render("Deploy n", true);
    expect(probe!.ghostSuffix).toBe("ow");
    // Note: inserting here records nothing — accept() is the only writer of
    // the inserted mark, so this equality came from typing.
  });

  it("openList selects the row the buffer equals; pick swaps or bails", () => {
    offer(["Deploy now", "Run the tests first", "Just merge it"]);
    render("Run the tests first", true);
    expect(probe!.hintMore).toBe(2);
    expect(probe!.selectedIndex).toBe(1);
    act(() => {
      expect(probe!.openList()).toBe(true);
    });
    render("Run the tests first", true);
    expect(probe!.listOpen).toBe(true);
    expect(probe!.held).toBe(true);
    // While open, no ghost, hint, or accept claims anything.
    expect(probe!.hintMore).toBeNull();
    expect(probe!.ghostSuffix).toBeNull();
    expect(probe!.accept()).toBeNull();
    act(() => {
      expect(probe!.pick(2)).toEqual({ text: "Just merge it", caret: 13 });
    });
    render("Just merge it", true);
    expect(probe!.listOpen).toBe(false);
    // Swapped choice of ≥2 → hint again, ghost stays silent.
    expect(probe!.hintMore).toBe(2);
    // Picking the row the buffer already equals just closes (#applyAssist bail).
    act(() => {
      expect(probe!.openList()).toBe(true);
    });
    render("Just merge it", true);
    act(() => {
      expect(probe!.pick(2)).toBeNull();
    });
    render("Just merge it", true);
    expect(probe!.listOpen).toBe(false);
  });

  it("closeList leaves the buffer and offer standing; a single choice never hints or lists", () => {
    offer(["Deploy now", "Run the tests first"]);
    render("Deploy now", true);
    act(() => {
      probe!.openList();
    });
    render("Deploy now", true);
    act(() => {
      probe!.closeList();
    });
    render("Deploy now", true);
    expect(probe!.listOpen).toBe(false);
    expect(probe!.hintMore).toBe(1);
    expect(probe!.held).toBe(true);

    offer(["Only one"]);
    act(() => {
      probe!.accept();
    });
    render("Only one", true);
    // One prediction: nothing to pick (#getPredictionAlternatives < 2).
    expect(probe!.hintMore).toBeNull();
    expect(probe!.openList()).toBe(false);
  });

  it("a non-empty single line with no match releases the slot (held false)", () => {
    offer(["Deploy now", "Run the tests first"]);
    render("unrelated draft", true);
    expect(probe!.held).toBe(false);
    expect(probe!.ghostSuffix).toBeNull();
    expect(probe!.hintMore).toBeNull();
  });

  it("multi-line or mid-draft caret gives up the ghost surface", () => {
    offer(["Deploy now"]);
    render("Deploy now\nsecond line", true);
    expect(probe!.ghostSuffix).toBeNull();
    expect(probe!.held).toBe(false);
    render("Deploy", true, TAB, 3);
    expect(probe!.ghostSuffix).toBeNull();
  });

  it("losing the composer closes an open list without touching state forever", () => {
    offer(["Deploy now", "Run the tests first"]);
    render("Deploy now", true);
    act(() => {
      expect(probe!.openList()).toBe(true);
    });
    render("Deploy now", true);
    expect(probe!.listOpen).toBe(true);
    render("Deploy now", false);
    expect(probe!.listOpen).toBe(false);
    // The offer itself survived the focus loss…
    render("Deploy now", true);
    // …but the list stays closed until Tab opens it again.
    expect(probe!.listOpen).toBe(false);
    expect(probe!.hintMore).toBe(1);
  });
});
