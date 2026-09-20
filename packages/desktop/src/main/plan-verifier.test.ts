import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  session: { fromPartition: vi.fn() },
}));

import {
  PLAN_VERIFY_TOTAL_DEADLINE_MS,
  PlanVerifier,
  type VerifierPage,
} from "./plan-verifier";

const hungPage = (): Promise<VerifierPage> => new Promise(() => undefined);

describe("PlanVerifier queue budget", () => {
  afterEach(() => vi.useRealTimers());

  it("applies the total deadline while page creation is still pending", async () => {
    vi.useFakeTimers();
    const verifier = new PlanVerifier({ createPage: hungPage });
    const result = verifier.verify("<p>plan</p>", "default", new AbortController().signal);

    await vi.advanceTimersByTimeAsync(PLAN_VERIFY_TOTAL_DEADLINE_MS);

    await expect(result).resolves.toMatchObject({
      status: "unavailable",
      diagnostics: [{ code: "VERIFIER_TIMEOUT" }],
    });
  });

  it("settles active and queued jobs when disposed", async () => {
    vi.useFakeTimers();
    const verifier = new PlanVerifier({ createPage: hungPage });
    const first = verifier.verify("<p>one</p>", "default", new AbortController().signal);
    const second = verifier.verify("<p>two</p>", "default", new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);

    verifier.dispose();

    await expect(first).resolves.toMatchObject({ status: "unavailable" });
    await expect(second).resolves.toMatchObject({ status: "unavailable" });
  });
});
