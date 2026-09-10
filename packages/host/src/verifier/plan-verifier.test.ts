import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlanRenderResult } from "@omp-ui/core";
import { PLAN_VERIFY_TOTAL_DEADLINE_MS, PlanVerifier, type VerifierPage } from "./plan-verifier";

const PASSED: PlanRenderResult = { status: "passed", diagnostics: [] };

/** A page whose every step is a promise the test settles by hand. */
type FakePage = VerifierPage & { disposed: number };

function fakePage(overrides: Partial<VerifierPage> = {}): FakePage {
  const page = {
    disposed: 0,
    ready: () => Promise.resolve(),
    invoke: () => Promise.resolve<unknown>(PASSED),
    dispose() {
      page.disposed += 1;
    },
    ...overrides,
  };
  return page;
}

const never = <T>(): Promise<T> => new Promise<T>(() => undefined);
const codeOf = (r: PlanRenderResult): [string | undefined, string | undefined] => [
  r.diagnostics[0]?.code,
  r.diagnostics[0]?.detail,
];

describe("PlanVerifier deadline phases", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("names the launch phase when the page never comes up", async () => {
    const verifier = new PlanVerifier({ page: () => never<VerifierPage>() });
    const result = verifier.verify("<p>x</p>", "dark", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(PLAN_VERIFY_TOTAL_DEADLINE_MS);
    expect(codeOf(await result)).toEqual(["VERIFIER_TIMEOUT", "deadline(phase=launch)"]);
  });

  it("names the page-ready phase when ready() hangs", async () => {
    const verifier = new PlanVerifier({ page: () => fakePage({ ready: () => never<void>() }) });
    const result = verifier.verify("<p>x</p>", "dark", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(PLAN_VERIFY_TOTAL_DEADLINE_MS);
    expect(codeOf(await result)).toEqual(["VERIFIER_TIMEOUT", "deadline(phase=page-ready)"]);
  });

  it("names the invoke phase and discards the hung page so the next job gets a fresh one", async () => {
    const pages: FakePage[] = [];
    let hang = true;
    const verifier = new PlanVerifier({
      page: () => {
        const page = fakePage({ invoke: () => (hang ? never<unknown>() : Promise.resolve(PASSED)) });
        pages.push(page);
        return page;
      },
    });
    const first = verifier.verify("<p>x</p>", "dark", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(PLAN_VERIFY_TOTAL_DEADLINE_MS);
    expect(codeOf(await first)).toEqual(["VERIFIER_TIMEOUT", "deadline(phase=invoke)"]);
    expect(pages[0]!.disposed).toBe(1);

    hang = false;
    const second = await verifier.verify("<p>x</p>", "dark", new AbortController().signal);
    expect(second.status).toBe("passed");
    expect(pages).toHaveLength(2);
  });

  it("charges queue wait against the deadline", async () => {
    const verifier = new PlanVerifier({ page: () => fakePage({ invoke: () => never<unknown>() }) });
    const first = verifier.verify("<p>a</p>", "dark", new AbortController().signal);
    const second = verifier.verify("<p>b</p>", "dark", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(PLAN_VERIFY_TOTAL_DEADLINE_MS);
    expect(codeOf(await first)).toEqual(["VERIFIER_TIMEOUT", "deadline(phase=invoke)"]);
    // The second job's clock started at enqueue: it is over budget before it runs.
    expect(codeOf(await second)).toEqual(["VERIFIER_TIMEOUT", "deadline(phase=queued)"]);
  });
});

describe("PlanVerifier degraded construction", () => {
  it("answers every verify unavailable with the payload reason and never touches the page", async () => {
    const page = vi.fn(() => {
      throw new Error("must not be called");
    });
    const verifier = new PlanVerifier({
      page,
      degraded: { available: false, reason: "verifier browser manifest unreadable" },
    });
    const result = await verifier.verify("<p>x</p>", "dark", new AbortController().signal);
    expect(codeOf(result)).toEqual(["VERIFIER_UNAVAILABLE", "verifier browser manifest unreadable"]);
    expect(page).not.toHaveBeenCalled();
    expect(verifier.health()).toMatchObject({
      state: "degraded",
      reason: "verifier browser manifest unreadable",
    });
  });
});

describe("PlanVerifier health", () => {
  it("defaults to ready without a health source", () => {
    const verifier = new PlanVerifier({ page: () => fakePage() });
    expect(verifier.health()).toMatchObject({ pin: null, sha256: null, state: "ready", reason: null });
  });

  it("reads through to the injected health source", () => {
    const verifier = new PlanVerifier({
      page: () => fakePage(),
      health: () => ({ pin: "153.0.8010.36", sha256: "abc", state: "degraded", reason: "crashed", atMs: 7 }),
    });
    expect(verifier.health()).toEqual({
      pin: "153.0.8010.36",
      sha256: "abc",
      state: "degraded",
      reason: "crashed",
      atMs: 7,
    });
  });
});

describe("PlanVerifier page failures", () => {
  it("maps a launch rejection to unavailable with its message", async () => {
    const verifier = new PlanVerifier({ page: () => Promise.reject(new Error("No usable sandbox")) });
    const result = await verifier.verify("<p>x</p>", "dark", new AbortController().signal);
    expect(codeOf(result)).toEqual(["VERIFIER_UNAVAILABLE", "No usable sandbox"]);
  });

  it("passes the job's signal to the page", async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const verifier = new PlanVerifier({
      page: () =>
        fakePage({
          invoke: (_args, signal) => {
            seen.push(signal);
            return Promise.resolve(PASSED);
          },
        }),
    });
    const controller = new AbortController();
    await verifier.verify("<p>x</p>", "dark", controller.signal);
    expect(seen).toEqual([controller.signal]);
  });
});
