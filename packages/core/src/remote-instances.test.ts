import { describe, expect, expectTypeOf, it } from "vitest";
import type { BrowserPaneEnsureResult } from "./browser-pane";
import {
  REMOTE_PROXY_CHANNELS,
  REMOTE_TAB_EVENTS,
  TAB_ROUTED_NOTIFIES,
  TAB_ROUTED_REQUESTS,
} from "./remote-instances";

// The browser pane rides the remote-instance relay (#532, ADR-0028): every
// renderer-to-main pane channel is tab-routed and proxied, and both pane events
// are mirrored, so a joined instance's pane streams with one relay hop.

const PANE_NOTIFIES = [
  "browser-pane:subscribe",
  "browser-pane:resize",
  "browser-pane:input",
  "browser-pane:navigate",
  // The session-level visibility publish (#556).
  "browser-pane:set-open",
];

describe("browser pane routing sets", () => {
  it("routes the ensure and pick requests and the five notifies by their owning tab", () => {
    expect(TAB_ROUTED_REQUESTS.has("browser-pane:ensure")).toBe(true);
    expect(TAB_ROUTED_REQUESTS.has("browser-pane:pick")).toBe(true);
    for (const channel of PANE_NOTIFIES) expect(TAB_ROUTED_NOTIFIES.has(channel)).toBe(true);
  });

  it("proxies all seven routed pane channels to a joined instance", () => {
    for (const channel of ["browser-pane:ensure", "browser-pane:pick", ...PANE_NOTIFIES]) {
      expect(REMOTE_PROXY_CHANNELS.has(channel)).toBe(true);
    }
  });

  it("mirrors frames and state from a joined instance unchanged", () => {
    expect(REMOTE_TAB_EVENTS.has("browser-pane:frame")).toBe(true);
    expect(REMOTE_TAB_EVENTS.has("browser-pane:state")).toBe(true);
  });

  it("never carries the endpoint across the relay", () => {
    // Distributes over the union so a key on any one arm is caught.
    type KeysOfArms<T> = T extends unknown ? keyof T : never;
    expectTypeOf<Extract<KeysOfArms<BrowserPaneEnsureResult>, "cdpUrl">>().toBeNever();
    expectTypeOf<Extract<BrowserPaneEnsureResult, { cdpUrl: unknown }>>().toBeNever();
  });
});

describe("autoresearch proxy channels (issue #559)", () => {
  it("proxies the three Lab reads to a joined instance", () => {
    for (const channel of ["autoresearch:overview", "autoresearch:experiment", "autoresearch:runLog"]) {
      expect(REMOTE_PROXY_CHANNELS.has(channel)).toBe(true);
    }
  });
});
