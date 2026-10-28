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

describe("sidebar snooze routing (issue #935)", () => {
  it("tab-routes session snooze to the owning instance", () => {
    expect(TAB_ROUTED_REQUESTS.has("session:setSnoozed")).toBe(true);
    expect(REMOTE_PROXY_CHANNELS.has("session:setSnoozed")).toBe(true);
  });

  it("never proxies the snooze-section setting to a joined instance", () => {
    // Settings stay app-local, like every other settings:* channel.
    expect(REMOTE_PROXY_CHANNELS.has("settings:setSnoozedSectionEnabled")).toBe(false);
  });
});

describe("knowledge vault channels (issue #764)", () => {
  // The registry and Obsidian's vault list are host-local: no vault:* channel
  // but the names-only list is proxied to a joined instance.
  it("never proxies a vault channel to a joined instance", () => {
    expect(REMOTE_PROXY_CHANNELS.has("vault:open")).toBe(false);
    expect(REMOTE_PROXY_CHANNELS.has("vault:add")).toBe(false);
    for (const channel of [
      "vault:detect",
      "vault:add",
      "vault:import",
      "vault:remove",
      "vault:setDefault",
      "vault:setHomeFolder",
      "vault:setWritesOutsideHome",
      "vault:open",
    ]) {
      expect(REMOTE_PROXY_CHANNELS.has(channel), channel).toBe(false);
    }
  });

  it("proxies the Knowledge home write and the vault names list (issue #766)", () => {
    expect(REMOTE_PROXY_CHANNELS.has("project:setKnowledgeHome")).toBe(true);
    expect(REMOTE_PROXY_CHANNELS.has("vault:names")).toBe(true);
  });
});

describe("fleet channels (issue #899)", () => {
  it("proxies only the host report and the tab-routed session summary", () => {
    expect(REMOTE_PROXY_CHANNELS.has("fleet:hostReport")).toBe(true);
    expect(REMOTE_PROXY_CHANNELS.has("fleet:sessionSummary")).toBe(true);
    expect(TAB_ROUTED_REQUESTS.has("fleet:sessionSummary")).toBe(true);
  });

  it("never proxies fleet orchestration to a joined instance", () => {
    for (const channel of ["fleet:dispatch", "fleet:machines", "fleet:dismissPending"]) {
      expect(REMOTE_PROXY_CHANNELS.has(channel), channel).toBe(false);
    }
  });

  it("proxies the ladder's owner-enforced channels (issue #901)", () => {
    for (const channel of ["fleet:exec", "fleet:projectManage", "fleet:grantRung", "fleet:grantRaise"]) {
      expect(REMOTE_PROXY_CHANNELS.has(channel), channel).toBe(true);
    }
  });

  it("never proxies grant edits, the audit, the manager ceremony, or ladder settings (issue #901)", () => {
    // A joined manager reaching these would set its own grant without the ceremony.
    for (const channel of [
      "fleet:grantSet",
      "fleet:grantRequest",
      "fleet:audit",
      "settings:setFleetExecEnabled",
      "settings:setFleetExecCeiling",
      "settings:setFleetProjectRoots",
    ]) {
      expect(REMOTE_PROXY_CHANNELS.has(channel), channel).toBe(false);
    }
  });

  it("proxies detached exec and the member's Provider key leg, never the local rollout (issue #905)", () => {
    for (const channel of ["fleet:execDetach", "fleet:execPoll", "fleet:providerKeys"]) {
      expect(REMOTE_PROXY_CHANNELS.has(channel), channel).toBe(true);
    }
    expect(REMOTE_PROXY_CHANNELS.has("fleet:rolloutProviderKeys")).toBe(false);
  });

  it("proxies the member update and poll legs, never the local orchestration", () => {
    for (const channel of ["fleet:updateMember", "fleet:updatePoll"]) {
      expect(REMOTE_PROXY_CHANNELS.has(channel), channel).toBe(true);
    }
    expect(REMOTE_PROXY_CHANNELS.has("fleet:updateMachine")).toBe(false);
  });

  it("proxies fleet send to the owner (#959)", () => {
    expect(REMOTE_PROXY_CHANNELS.has("fleet:send")).toBe(true);
  });
});
