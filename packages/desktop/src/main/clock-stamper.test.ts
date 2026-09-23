import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserClockStampRequest } from "@omp-ui/core";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  session: { fromPartition: vi.fn() },
}));

import { CLOCK_STAMP_DEADLINE_MS, ClockStamper, type StamperPage } from "./clock-stamper";

const REQ: BrowserClockStampRequest = {
  data: "aGVsbG8=",
  mimeType: "image/png",
  quality: null,
  text: "2026-09-23 10:00:00",
  cssWidth: 1280,
};

interface FakePage extends StamperPage {
  disposed: number;
}

function fakePage(invoke: StamperPage["invoke"]): FakePage {
  const page: FakePage = {
    disposed: 0,
    invoke,
    dispose: () => {
      page.disposed += 1;
    },
  };
  return page;
}

describe("ClockStamper", () => {
  afterEach(() => vi.useRealTimers());

  it("times out a hung page, disposes it, and builds a fresh page for the next stamp", async () => {
    vi.useFakeTimers();
    const hung = fakePage(() => new Promise(() => undefined));
    const healthy = fakePage(async () => "c3RhbXBlZA==");
    const pages = [hung, healthy];
    const createPage = vi.fn(async () => pages.shift()!);
    const stamper = new ClockStamper({ createPage });

    const first = stamper.stamp(REQ);
    const settled = expect(first).rejects.toThrow("the clock stamper timed out");
    await vi.advanceTimersByTimeAsync(CLOCK_STAMP_DEADLINE_MS - 1);
    expect(hung.disposed).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    await settled;
    expect(hung.disposed).toBe(1);

    await expect(stamper.stamp(REQ)).resolves.toBe("c3RhbXBlZA==");
    expect(createPage).toHaveBeenCalledTimes(2);
  });

  it("rejects a non-string reply as no image", async () => {
    const stamper = new ClockStamper({ createPage: async () => fakePage(async () => ({ data: "x" })) });

    await expect(stamper.stamp(REQ)).rejects.toThrow("the clock stamper returned no image");
  });
});
