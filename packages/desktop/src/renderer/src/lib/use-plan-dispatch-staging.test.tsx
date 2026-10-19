// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { OwnedSessionRecord } from "@omp-ui/core/types";
import type { ModelInfo } from "./rpc-types";
import {
  usePlanDispatchStaging,
  type PlanDispatchStaging,
} from "./use-plan-dispatch-staging";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;

const modelA: ModelInfo = { id: "a", name: "A", provider: "p" };
const modelB: ModelInfo = { id: "b", name: "B", provider: "p" };

interface ProbeProps {
  review: unknown;
  sessionRecord?: OwnedSessionRecord;
  model: ModelInfo | null;
  thinkingLevel: string | null;
}

/** Re-renders the hook with fresh props and captures its return value. */
let captured!: PlanDispatchStaging;

function Probe(p: ProbeProps): null {
  captured = usePlanDispatchStaging(
    p.review,
    p.sessionRecord,
    p.model,
    p.thinkingLevel,
  );
  return null;
}

function mount(p: ProbeProps): (next: Partial<ProbeProps>) => void {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Probe {...p} />));
  return (next) => act(() => root!.render(<Probe {...p} {...next} />));
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("usePlanDispatchStaging seeds", () => {
  it("captures the opening model and thinking as seeds on first render", () => {
    mount({ review: { id: 1 }, model: modelA, thinkingLevel: "high" });
    expect(captured.seededModel).toBe(modelA);
    expect(captured.seededThinking).toBe("high");
    // Seeds start equal to the staged values; both name the session's opening pair.
    expect(captured.stagedModel).toBe(modelA);
    expect(captured.stagedThinking).toBe("high");
  });

  it("keeps the seeds when the model prop drifts within the same review", () => {
    const rerender = mount({ review: { id: 1 }, model: modelA, thinkingLevel: "high" });
    rerender({ model: modelB, thinkingLevel: "low" });
    // The seed is what this review opened with, not a live mirror.
    expect(captured.seededModel).toBe(modelA);
    expect(captured.seededThinking).toBe("high");
  });

  it("replaces the seeds when a new review opens, never keeping stale ones", () => {
    const rerender = mount({ review: { id: 1 }, model: modelA, thinkingLevel: "high" });
    // Stage something else entirely before the next review arrives.
    act(() => captured.setStagedModel(modelB));
    act(() => captured.setStagedThinking("off"));
    expect(captured.seededModel).toBe(modelA);

    rerender({ review: { id: 2 }, model: modelB, thinkingLevel: "off" });
    // Seeds follow the NEW review's opening values, not review 1's.
    expect(captured.seededModel).toBe(modelB);
    expect(captured.seededThinking).toBe("off");
    // Staged values reseed to the new review too.
    expect(captured.stagedModel).toBe(modelB);
    expect(captured.stagedThinking).toBe("off");
  });

  it("reseeds on review identity change even when model and thinking are unchanged", () => {
    const rerender = mount({ review: { id: 1 }, model: modelA, thinkingLevel: "high" });
    act(() => captured.setStagedModel(null));
    act(() => captured.setStagedThinking(null));
    rerender({ review: { id: 2 } });
    // Clear-tier restoration needs the new review's own capture; a nulls-stage
    // from the old review must not survive as the seed baseline.
    expect(captured.seededModel).toBe(modelA);
    expect(captured.seededThinking).toBe("high");
    expect(captured.stagedModel).toBe(modelA);
    expect(captured.stagedThinking).toBe("high");
  });
});
