import { describe, expect, it, vi } from "vitest";
import { applyAudioDevice, readAudioDevices, type AudioDeviceRunner } from "./audio-devices";

/** A pactl seam fed from fixture text; every invocation is recorded. The
/** set-default verbs succeed unless a fixture maps them, since they echo nothing. */
function fixtureRunner(
  fixtures: Record<string, string>,
  opts: { fail?: (args: string[]) => string | undefined } = {},
): { runner: AudioDeviceRunner; calls: string[][] } {
  const calls: string[][] = [];
  const runner: AudioDeviceRunner = {
    run: async (_cmd, args) => {
      calls.push(args);
      if (opts.fail?.(args) !== undefined) throw new Error(opts.fail!(args)!);
      const key = args.join(" ");
      const out = fixtures[key];
      if (out !== undefined) return out;
      if (args[0]?.startsWith("set-default")) return "";
      throw new Error(`fixture missing for: pactl ${key}`);
    },
  };
  return { runner, calls };
}

const node = (name: string, description: string, extra: Record<string, unknown> = {}) => ({
  name,
  properties: { "device.description": description, ...extra },
});

const SOURCES = JSON.stringify([
  { name: "alsa_output.usb-dac.analog-stereo.monitor", properties: { "device.description": "USB DAC" } },
  { name: "alsa_input.usb-at2020.analog-stereo", properties: { "device.description": "AT2020 USB " } },
  { name: "loopback.source", properties: { "device.description": "Echo Cancel Source", "device.api": "loopback" } },
]);

const SINKS = JSON.stringify([
  { name: "alsa_output.usb-dac.analog-stereo", properties: { "device.description": "USB DAC" } },
]);

const STANDARD = {
  "--format=json list sources": SOURCES,
  "--format=json list sinks": SINKS,
  "get-default-source": "alsa_input.usb-at2020.analog-stereo\n",
  "get-default-sink": "alsa_output.usb-dac.analog-stereo\n",
};

describe("readAudioDevices", () => {
  it("groups nodes by device.description and drops monitors and loopback", async () => {
    const { runner } = fixtureRunner(STANDARD);
    expect(await readAudioDevices(runner)).toEqual([
      { id: "AT2020 USB", isDefault: true, hasInput: true, hasOutput: false },
      { id: "USB DAC", isDefault: true, hasInput: false, hasOutput: true },
    ]);
  });

  it("resolves the default marker through sink nodes too", async () => {
    // The source query naming a sink node (a half-moved default) still marks
    // the owning card; the card the stored source used is no longer default.
    const { runner } = fixtureRunner({
      ...STANDARD,
      "get-default-source": "alsa_output.usb-dac.analog-stereo\n",
    });
    const devices = await readAudioDevices(runner);
    expect(devices.find((d) => d.id === "USB DAC")!.isDefault).toBe(true);
    expect(devices.find((d) => d.id === "AT2020 USB")!.isDefault).toBe(false);
  });

  it("marks nothing when the default resolves to no known label", async () => {
    const { runner } = fixtureRunner({
      ...STANDARD,
      "get-default-source": "N/A\n",
      "get-default-sink": "\n",
    });
    expect((await readAudioDevices(runner)).every((d) => !d.isDefault)).toBe(true);
  });

  it("sorts entries by id and survives a get-default failure", async () => {
    const { runner, calls } = fixtureRunner(STANDARD, {
      fail: (args) => (args[0] === "get-default-source" ? "boom" : undefined),
    });
    const devices = await readAudioDevices(runner);
    expect(devices.map((d) => d.id)).toEqual(["AT2020 USB", "USB DAC"]);
    expect(devices.find((d) => d.id === "USB DAC")!.isDefault).toBe(true);
    expect(calls.some((args) => args[0] === "get-default-source")).toBe(true);
  });

  it("drops a device list that groups to nothing usable", async () => {
    const { runner } = fixtureRunner({
      ...STANDARD,
      "--format=json list sources": JSON.stringify([node("x.monitor", "Mon", {})]),
      "--format=json list sinks": "[]",
    });
    expect(await readAudioDevices(runner)).toEqual([]);
  });

  it("rejects when pactl fails, leaving the supported:false mapping to the handler", async () => {
    const runner: AudioDeviceRunner = {
      run: async () => {
        throw Object.assign(new Error("spawn pactl ENOENT"), { code: "ENOENT" });
      },
    };
    await expect(readAudioDevices(runner)).rejects.toThrow("ENOENT");
  });
});

describe("applyAudioDevice", () => {
  it("sets the default source and sink for every node carrying the label", async () => {
    const { runner, calls } = fixtureRunner(STANDARD);
    await applyAudioDevice(runner, "USB DAC");
    expect(calls).toEqual([
      ["--format=json", "list", "sources"],
      ["--format=json", "list", "sinks"],
      ["set-default-sink", "alsa_output.usb-dac.analog-stereo"],
    ]);
  });

  it("flips only the source for an input-only device", async () => {
    const { runner, calls } = fixtureRunner(STANDARD);
    await applyAudioDevice(runner, "AT2020 USB");
    expect(calls.filter((args) => args[0] === "set-default-source")).toEqual([
      ["set-default-source", "alsa_input.usb-at2020.analog-stereo"],
    ]);
    expect(calls.some((args) => args[0] === "set-default-sink")).toBe(false);
  });

  it("null means the system default: no commands at all", async () => {
    const { runner, calls } = fixtureRunner(STANDARD);
    await applyAudioDevice(runner, null);
    expect(calls).toEqual([]);
  });

  it("an unknown id changes nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runner, calls } = fixtureRunner(STANDARD);
    await applyAudioDevice(runner, "Plugged-Out Mic");
    expect(calls.filter((args) => args[0].startsWith("set-default"))).toEqual([]);
    expect(warn.mock.calls.length).toBe(1);
    warn.mockRestore();
  });

  it("throws when every set fails — the picker must not lie", async () => {
    const { runner } = fixtureRunner(STANDARD, {
      fail: (args) => (args[0].startsWith("set-default") ? "refused" : undefined),
    });
    await expect(applyAudioDevice(runner, "USB DAC")).rejects.toThrow(/USB DAC/);
  });

  it("a partial failure warns and resolves — the default moved", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runner } = fixtureRunner(
      {
        "--format=json list sources": JSON.stringify([
          node("alsa_input.a", "Both"),
          node("alsa_input.b", "Both"),
        ]),
        "--format=json list sinks": "[]",
        "get-default-source": "",
        "get-default-sink": "",
      },
      { fail: (args) => (args[1] === "alsa_input.b" ? "refused" : undefined) },
    );
    await expect(applyAudioDevice(runner, "Both")).resolves.toBeUndefined();
    expect(warn.mock.calls.length).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it("two nodes sharing a label both get set, sources before sinks", async () => {
    const { runner, calls } = fixtureRunner({
      "--format=json list sources": JSON.stringify([node("alsa_input.a", "Twin")]),
      "--format=json list sinks": JSON.stringify([node("alsa_output.b", "Twin")]),
      "get-default-source": "\n",
      "get-default-sink": "\n",
    });
    await applyAudioDevice(runner, "Twin");
    expect(calls.filter((args) => args[0].startsWith("set-default"))).toEqual([
      ["set-default-source", "alsa_input.a"],
      ["set-default-sink", "alsa_output.b"],
    ]);
  });
});
