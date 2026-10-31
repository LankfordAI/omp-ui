// Device pane slice tests (issue #1006): one split slot, two panes.
import { describe, expect, it } from "vitest";
import type { DevicePaneState } from "@omp-ui/core/device-pane";
import { rpcTabState } from "../../test/fixtures";
import { h } from "../../test/store-harness";

const tab = () => h.useStore.getState().rpc[h.TAB]!;

function deviceState(patch: Partial<DevicePaneState> = {}): DevicePaneState {
  return {
    serial: "emulator-5554",
    avd: "Pixel_8",
    phase: "streaming",
    agent: "detached",
    error: null,
    open: false,
    display: { width: 1080, height: 2400 },
    ...patch,
  };
}

describe("device pane mutual exclusion", () => {
  it("opening the device pane closes the browser pane", () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({ browserPane: { ...rpcTabState().browserPane, open: true } }),
      },
    });
    h.useStore.getState().openDevicePane(h.TAB);
    expect(tab().devicePane.open).toBe(true);
    expect(tab().browserPane.open).toBe(false);
  });

  it("opening the browser pane closes the device pane", () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    h.useStore.getState().openDevicePane(h.TAB);
    h.useStore.getState().openBrowserPane(h.TAB);
    expect(tab().browserPane.open).toBe(true);
    expect(tab().devicePane.open).toBe(false);
  });

  it("an agent-driven open state push closes the browser pane", () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({ browserPane: { ...rpcTabState().browserPane, open: true } }),
      },
    });
    h.useStore.getState().handleDevicePaneState(h.TAB, deviceState({ open: true, agent: "acting" }));
    expect(tab().devicePane.open).toBe(true);
    expect(tab().devicePane.state?.agent).toBe("acting");
    expect(tab().browserPane.open).toBe(false);
  });
});
