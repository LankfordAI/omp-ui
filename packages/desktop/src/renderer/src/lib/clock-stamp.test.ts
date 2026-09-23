import { describe, expect, it } from "vitest";
import { CLOCK_STAMP_MARGIN, layoutClockStamp } from "./clock-stamp";

describe("layoutClockStamp", () => {
  it("places the badge in the top-right corner, margin from the edges, without resizing a roomy image", () => {
    const layout = layoutClockStamp(1280, 800, 150, 1);
    expect(layout.canvasWidth).toBe(1280);
    expect(layout.canvasHeight).toBe(800);
    expect(layout.imageY).toBe(0);
    expect(layout.box.x + layout.box.width).toBe(1280 - CLOCK_STAMP_MARGIN);
    expect(layout.box.y).toBe(CLOCK_STAMP_MARGIN);
  });

  it("doubles the badge at scale 2 so it reads the same size on a HiDPI capture", () => {
    const one = layoutClockStamp(1280, 800, 150, 1);
    const two = layoutClockStamp(2560, 1600, 300, 2);
    expect(two.box.width).toBe(2 * one.box.width);
    expect(two.box.height).toBe(2 * one.box.height);
    expect(two.box.y).toBe(2 * CLOCK_STAMP_MARGIN);
    expect(two.box.x + two.box.width).toBe(2560 - 2 * CLOCK_STAMP_MARGIN);
  });

  it("grows a strip on top of an image too narrow for the badge and keeps the badge inside the canvas", () => {
    const { box } = layoutClockStamp(1280, 800, 150, 1);
    const tooNarrow = box.width + 2 * CLOCK_STAMP_MARGIN - 1;
    const layout = layoutClockStamp(tooNarrow, 800, 150, 1);
    expect(layout.imageY).toBe(layout.box.height + 2 * CLOCK_STAMP_MARGIN);
    expect(layout.canvasHeight).toBe(800 + layout.imageY);
    expect(layout.canvasWidth).toBeGreaterThanOrEqual(layout.box.width + 2 * CLOCK_STAMP_MARGIN);
    expect(layout.box.x).toBeGreaterThanOrEqual(0);
    expect(layout.box.y).toBeGreaterThanOrEqual(0);
    expect(layout.box.x + layout.box.width).toBeLessThanOrEqual(layout.canvasWidth);
    expect(layout.box.y + layout.box.height).toBeLessThanOrEqual(layout.imageY);
  });
});
