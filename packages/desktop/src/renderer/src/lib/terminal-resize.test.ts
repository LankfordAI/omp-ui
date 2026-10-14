// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPtyResizePusher, PTY_RESIZE_QUIET_MS } from "./terminal";

vi.mock("@xterm/addon-webgl", () => ({ WebglAddon: class {} }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class {} }));

describe("createPtyResizePusher (issue #858)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pushes the first change at once, nothing for unchanged grids, and one trailing push per quiet period", () => {
    vi.useFakeTimers();
    const term = { cols: 80, rows: 24 };
    const send = vi.fn();
    const push = createPtyResizePusher(term as never, send);

    push();
    expect(send).toHaveBeenCalledWith(80, 24);

    // A grid that already matches the last push is silent, however many
    // observer ticks arrive (the per-frame callback of a width transition).
    for (let i = 0; i < 10; i++) push();
    expect(send).toHaveBeenCalledTimes(1);

    // A mid-transition change waits for the trailing edge of the quiet period.
    term.cols = 100;
    push();
    expect(send).toHaveBeenCalledTimes(1);
    term.cols = 120;
    push();
    vi.advanceTimersByTime(PTY_RESIZE_QUIET_MS);
    expect(send).toHaveBeenLastCalledWith(120, 24);
    expect(send).toHaveBeenCalledTimes(2);

    // After the trailing edge settles, the next real change is leading again.
    term.rows = 40;
    push();
    expect(send).toHaveBeenCalledTimes(3);
    expect(send).toHaveBeenLastCalledWith(120, 40);
  });
});
