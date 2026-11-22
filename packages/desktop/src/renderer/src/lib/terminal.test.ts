// The GPU-era WebGL renderer lifecycle (performance plan Phase 4): a context
// loss reloads the addon on a bounded timer ladder instead of stranding the
// terminal on xterm's DOM renderer for the whole run.
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** One constructed addon with the knob each test drives. */
interface FakeWebgl {
  fireLoss: () => void;
  disposed: boolean;
}

const webgl = vi.hoisted(() => ({
  /** true while construction throws (GPU dead). */
  throwOnConstruct: false,
  constructed: [] as FakeWebgl[],
  failNextConstructions: 0,
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: class TerminalMock {
    options: Record<string, unknown> = {};
    open() {}
    loadAddon() {}
    dispose() {}
    refresh() {}
    focus() {}
    onData() {
      return { dispose() {} };
    }
    write() {}
    attachCustomKeyEventHandler() {}
    cols = 80;
    rows = 24;
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class FitAddonMock { fit() {} } }));
vi.mock("@xterm/addon-web-links", () => ({ WebLinksAddon: class WebLinksAddonMock {} }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class WebglAddonMock {
    private loss: (() => void) | null = null;
    disposed = false;
    private entry: FakeWebgl | null = null;
    constructor() {
      if (webgl.throwOnConstruct || webgl.failNextConstructions > 0) {
        if (webgl.failNextConstructions > 0) webgl.failNextConstructions -= 1;
        throw new Error("no gpu");
      }
      const self = this;
      this.entry = {
        get disposed() {
          return self.disposed;
        },
        fireLoss: () => self.loss?.(),
      };
      webgl.constructed.push(this.entry);
    }
    onContextLoss(cb: () => void) {
      this.loss = cb;
    }
    dispose() {
      this.disposed = true;
    }
  },
}));

import { createTerminal, WEBGL_RETRY_DELAYS_MS, type CreatedTerminal } from "./terminal";

const theme = { term: {} } as never;
const font = { mono: "mono" } as never;

function make(): CreatedTerminal {
  return createTerminal({} as HTMLElement, theme, font);
}

beforeEach(() => {
  vi.useFakeTimers();
  webgl.throwOnConstruct = false;
  webgl.failNextConstructions = 0;
  webgl.constructed.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createTerminal WebGL retry ladder", () => {
  it("loads the addon once when nothing fails", () => {
    make();
    expect(webgl.constructed).toHaveLength(1);
  });

  it("retries twice after a context loss, at 500ms then +2000ms", () => {
    make();
    webgl.constructed[0]!.fireLoss();
    // Nothing before the first delay.
    vi.advanceTimersByTime(WEBGL_RETRY_DELAYS_MS[0]! - 1);
    expect(webgl.constructed).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(webgl.constructed).toHaveLength(2);
    // The reload succeeded, so a new loss starts the ladder fresh: 500ms.
    webgl.constructed[1]!.fireLoss();
    vi.advanceTimersByTime(WEBGL_RETRY_DELAYS_MS[0]! - 1);
    expect(webgl.constructed).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(webgl.constructed).toHaveLength(3);
    // The second loss re-arms once more (only consecutive *failed* attempts
    // strand the terminal on the DOM renderer — next test).
    webgl.constructed[2]!.fireLoss();
    vi.advanceTimersByTime(WEBGL_RETRY_DELAYS_MS[0]!);
    expect(webgl.constructed).toHaveLength(4);
  });

  it("keeps the DOM renderer after two consecutive attempts fail", () => {
    make();
    // One loss arms the ladder; both timer steps then throw at construction.
    webgl.constructed[0]!.fireLoss();
    webgl.throwOnConstruct = true;
    vi.advanceTimersByTime(WEBGL_RETRY_DELAYS_MS[0]!); // attempt 1 throws
    expect(webgl.constructed).toHaveLength(1);
    vi.advanceTimersByTime(WEBGL_RETRY_DELAYS_MS[1]!); // attempt 2 throws
    expect(webgl.constructed).toHaveLength(1);
    vi.advanceTimersByTime(60_000);
    expect(webgl.constructed).toHaveLength(1);
  });

  it("successful reload re-arms a fresh ladder after a later loss", () => {
    make();
    webgl.failNextConstructions = 1; // first reload throws, second succeeds
    webgl.constructed[0]!.fireLoss();
    vi.advanceTimersByTime(WEBGL_RETRY_DELAYS_MS[0]!);
    expect(webgl.constructed).toHaveLength(1); // the throw consumed attempt 1
    vi.advanceTimersByTime(WEBGL_RETRY_DELAYS_MS[1]!);
    expect(webgl.constructed).toHaveLength(2); // success — attempt counter reset
    // A much later loss now gets a fresh full ladder.
    webgl.constructed[1]!.fireLoss();
    vi.advanceTimersByTime(WEBGL_RETRY_DELAYS_MS[0]!);
    expect(webgl.constructed).toHaveLength(3);
  });

  it("dispose mid-backoff cancels the pending attempt and never reloads", () => {
    const created = make();
    webgl.constructed[0]!.fireLoss(); // retry armed at 500ms
    created.dispose();
    vi.advanceTimersByTime(60_000);
    expect(webgl.constructed).toHaveLength(1);
  });

  it("dispose disposes the live addon", () => {
    const created = make();
    const entry = webgl.constructed[0]!;
    created.dispose();
    expect(entry.disposed).toBe(true);
  });
});
