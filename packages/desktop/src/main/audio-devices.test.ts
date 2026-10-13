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
      { id: "AT2020 USB", isDefaultInput: true, isDefaultOutput: false, hasInput: true, hasOutput: false },
      { id: "USB DAC", isDefaultInput: false, isDefaultOutput: true, hasInput: false, hasOutput: true },
    ]);
  });

  it("marks the output default through sink nodes without touching the input flag", async () => {
    // The sink query names the DAC's sink; the source query still names the
    // mic. Each role's chip tracks only its own default.
    const { runner } = fixtureRunner({
      ...STANDARD,
      "get-default-sink": "alsa_output.usb-dac.analog-stereo\n",
    });
    const devices = await readAudioDevices(runner);
    expect(devices.find((d) => d.id === "USB DAC")!.isDefaultOutput).toBe(true);
    expect(devices.find((d) => d.id === "USB DAC")!.isDefaultInput).toBe(false);
    expect(devices.find((d) => d.id === "AT2020 USB")!.isDefaultInput).toBe(true);
  });

  it("marks nothing when both defaults resolve to no known label", async () => {
    const { runner } = fixtureRunner({
      ...STANDARD,
      "get-default-source": "N/A\n",
      "get-default-sink": "\n",
    });
    const devices = await readAudioDevices(runner);
    expect(devices.every((d) => !d.isDefaultInput && !d.isDefaultOutput)).toBe(true);
  });

  it("sorts entries by id and survives a get-default failure", async () => {
    const { runner, calls } = fixtureRunner(STANDARD, {
      fail: (args) => (args[0] === "get-default-source" ? "boom" : undefined),
    });
    const devices = await readAudioDevices(runner);
    expect(devices.map((d) => d.id)).toEqual(["AT2020 USB", "USB DAC"]);
    expect(devices.find((d) => d.id === "USB DAC")!.isDefaultOutput).toBe(true);
    expect(devices.find((d) => d.id === "AT2020 USB")!.isDefaultInput).toBe(false);
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
  it("the output role sets only sinks for every node carrying the label", async () => {
    const { runner, calls } = fixtureRunner(STANDARD);
    await applyAudioDevice(runner, "USB DAC", "output");
    expect(calls).toEqual([
      ["--format=json", "list", "sources"],
      ["--format=json", "list", "sinks"],
      ["set-default-sink", "alsa_output.usb-dac.analog-stereo"],
    ]);
    expect(calls.some((args) => args[0] === "set-default-source")).toBe(false);
  });

  it("the input role sets only sources and never issues set-default-sink", async () => {
    const { runner, calls } = fixtureRunner(STANDARD);
    await applyAudioDevice(runner, "AT2020 USB", "input");
    expect(calls.filter((args) => args[0] === "set-default-source")).toEqual([
      ["set-default-source", "alsa_input.usb-at2020.analog-stereo"],
    ]);
    expect(calls.some((args) => args[0] === "set-default-sink")).toBe(false);
  });

  it("the input role against an output-only label warns and sets nothing", async () => {
    // The legacy cross-role seed case: a stored mic value naming the DAC
    // must never touch the sink.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runner, calls } = fixtureRunner(STANDARD);
    await applyAudioDevice(runner, "USB DAC", "input");
    expect(calls.filter((args) => args[0].startsWith("set-default"))).toEqual([]);
    expect(warn.mock.calls.length).toBe(1);
    warn.mockRestore();
  });

  it("null means the system default: no commands at all", async () => {
    const { runner, calls } = fixtureRunner(STANDARD);
    await applyAudioDevice(runner, null, "input");
    await applyAudioDevice(runner, null, "output");
    expect(calls).toEqual([]);
  });

  it("an unknown id changes nothing", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { runner, calls } = fixtureRunner(STANDARD);
    await applyAudioDevice(runner, "Plugged-Out Mic", "input");
    expect(calls.filter((args) => args[0].startsWith("set-default"))).toEqual([]);
    expect(warn.mock.calls.length).toBe(1);
    warn.mockRestore();
  });

  it("throws when every set fails — the picker must not lie", async () => {
    const { runner } = fixtureRunner(STANDARD, {
      fail: (args) => (args[0].startsWith("set-default") ? "refused" : undefined),
    });
    await expect(applyAudioDevice(runner, "USB DAC", "output")).rejects.toThrow(/USB DAC/);
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
    await expect(applyAudioDevice(runner, "Both", "input")).resolves.toBeUndefined();
    expect(warn.mock.calls.length).toBeGreaterThan(0);
    warn.mockRestore();
  });

  it("two same-role nodes sharing a label both get set", async () => {
    const { runner, calls } = fixtureRunner({
      "--format=json list sources": JSON.stringify([
        node("alsa_input.a", "Twin"),
        node("alsa_input.b", "Twin"),
      ]),
      "--format=json list sinks": JSON.stringify([node("alsa_output.c", "Twin")]),
      "get-default-source": "\n",
      "get-default-sink": "\n",
    });
    await applyAudioDevice(runner, "Twin", "input");
    expect(calls.filter((args) => args[0].startsWith("set-default"))).toEqual([
      ["set-default-source", "alsa_input.a"],
      ["set-default-source", "alsa_input.b"],
    ]);
  });
});
