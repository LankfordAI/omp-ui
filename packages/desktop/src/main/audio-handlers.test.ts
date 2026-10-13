import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CH, Registry } from "@omp-ui/core";
import { registerAudioHandlers } from "./audio-handlers";
import type { AudioDeviceRunner } from "./audio-devices";

let base: string;
let registry: Registry;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-audio-"));
  registry = Registry.load(path.join(base, "registry.json"));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const SOURCES = JSON.stringify([
  { name: "alsa_input.usb-at2020.analog-stereo", properties: { "device.description": "AT2020 USB" } },
]);

function pactl(run: (args: string[]) => string): AudioDeviceRunner {
  return { run: async (_cmd, args) => run(args) };
}

function handlers(run: (args: string[]) => string) {
  const broadcast = vi.fn(async () => {});
  return {
    broadcast,
    h: registerAudioHandlers({
      registry,
      broadcast,
      run: pactl(run),
      platform: "linux",
    }),
  };
}

describe("audio:setDevice handler", () => {
  it("commits the registry, broadcasts, then applies the OS default", async () => {
    const order: string[] = [];
    const h = registerAudioHandlers({
      registry,
      broadcast: async () => {
        order.push("broadcast");
      },
      run: pactl((args) => {
        if (args[0] === "set-default-source") order.push("apply");
        return args[0] === "--format=json" && args[2] === "sources" ? SOURCES : "[]";
      }),
      platform: "linux",
    });
    const set = registry.setSetting.bind(registry);
    registry.setSetting = ((key: "audioDevice", value: string | null) => {
      order.push("commit");
      return set(key, value);
    }) as typeof registry.setSetting;
    await h[CH.setAudioDevice]("AT2020 USB");
    expect(order).toEqual(["commit", "broadcast", "apply"]);
    expect(registry.getSetting("audioDevice")).toBe("AT2020 USB");
  });

  it("keeps the persisted choice when the apply fails", async () => {
    const { h } = handlers((args) => {
      if (args[0] === "set-default-source") throw new Error("refused");
      return args[0] === "--format=json" && args[2] === "sources" ? SOURCES : "[]";
    });
    await expect(h[CH.setAudioDevice]("AT2020 USB")).rejects.toThrow("refused");
    expect(registry.getSetting("audioDevice")).toBe("AT2020 USB");
  });

  it("null commits and applies nothing", async () => {
    const calls: string[][] = [];
    const { h } = handlers((args) => {
      calls.push(args);
      return "[]";
    });
    await h[CH.setAudioDevice](null);
    expect(registry.getSetting("audioDevice")).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe("audio:readDevices handler", () => {
  it("returns the enumerated devices with the stored current", async () => {
    registry.setSetting("audioDevice", "AT2020 USB");
    const { h } = handlers((args) =>
      args[0] === "--format=json" && args[2] === "sources"
        ? SOURCES
        : args[0] === "get-default-source"
          ? "alsa_input.usb-at2020.analog-stereo\n"
          : "[]",
    );
    expect(await h[CH.readAudioDevices]()).toEqual({
      devices: [{ id: "AT2020 USB", isDefault: true, hasInput: true, hasOutput: false }],
      current: "AT2020 USB",
      supported: true,
      error: null,
    });
  });

  it("maps a pactl failure to supported:false, never a rejection", async () => {
    const { h } = handlers(() => {
      throw new Error("spawn pactl ENOENT");
    });
    expect(await h[CH.readAudioDevices]()).toEqual({
      devices: [],
      current: null,
      supported: false,
      error: "spawn pactl ENOENT",
    });
  });

  it("a non-linux platform is the honest disabled state", async () => {
    const h = registerAudioHandlers({ registry, broadcast: async () => {}, platform: "darwin" });
    expect(await h[CH.readAudioDevices]()).toEqual({
      devices: [],
      current: null,
      supported: false,
      error: "device selection is not yet supported on this platform",
    });
  });
});
