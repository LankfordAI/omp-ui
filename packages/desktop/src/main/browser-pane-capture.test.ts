import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaneDebugger } from "./browser-pane-contents";
import { createBrowserPaneCapture, jpegDimensions, trimJpegToWidthHeight, type CapturedPaneFrame } from "./browser-pane-capture";

function jpeg(width = 1280, height = 800, marker = 0xc0): Buffer {
  const bytes = Buffer.from([0xff, 0xd8, 0xff, marker, 0, 11, 8, 0, 0, 0, 0, 1, 1, 0x11, 0, 0xff, 0xd9]);
  bytes.writeUInt16BE(height, 7);
  bytes.writeUInt16BE(width, 9);
  return bytes;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 30; i += 1) await Promise.resolve();
};

function harness(onFrame?: (frame: CapturedPaneFrame) => void) {
  const events = new EventEmitter();
  let nextSession = 0;
  const sendCommand = vi.fn<PaneDebugger["sendCommand"]>(async (method) => {
    if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "page", type: "page" } };
    if (method === "Target.attachToTarget") return { sessionId: `capture-${++nextSession}` };
    return {};
  });
  const debugger_: PaneDebugger = {
    attach() {}, detach() {}, isAttached: () => true, sendCommand,
    on: (event, callback) => { events.on(event, callback); },
    off: (event, callback) => { events.off(event, callback); },
  };
  const frames: CapturedPaneFrame[] = [];
  const errors: Error[] = [];
  const capture = createBrowserPaneCapture(debugger_, {
    fps: 30, quality: 70,
    onFrame: (frame) => {
      onFrame?.(frame);
      frames.push(frame);
    },
    onError: (error) => errors.push(error),
  });
  return {
    capture, frames, errors, events, sendCommand,
    frame: (data = jpeg(), session = `capture-${nextSession}`, token = 1) => {
      events.emit("message", {}, "Page.screencastFrame", { data: data.toString("base64"), sessionId: token }, session);
    },
  };
}

afterEach(() => vi.useRealTimers());

describe("JPEG dimensions", () => {
  it.each([0xc0, 0xc1, 0xc2])("reads SOF %i including the u16 dimension boundary", (marker) => {
    expect(jpegDimensions(jpeg(65535, 1, marker))).toEqual({ width: 65535, height: 1 });
  });

  it("skips length-delimited segments and fill bytes", () => {
    const source = jpeg();
    expect(jpegDimensions(Buffer.concat([
      source.subarray(0, 2), Buffer.from([0xff, 0xff, 0xe0, 0, 4, 9, 9]), source.subarray(2),
    ]))).toEqual({ width: 1280, height: 800 });
  });

  it("rejects missing SOI, truncation, zero dimensions, invalid segments and headers beyond the bound", () => {
    for (const invalid of [
      Buffer.alloc(0), jpeg().subarray(2), jpeg().subarray(0, 13), jpeg(0, 800), jpeg(1280, 0),
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 1]),
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xff, 0xff]), Buffer.alloc(65533), jpeg().subarray(2)]),
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xda]), jpeg().subarray(2)]),
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xd9]), jpeg().subarray(2)]),
    ]) expect(jpegDimensions(invalid)).toBeNull();
  });
});

// Real 18×18 RGB JPEGs, encoded at quality 70 with baseline/progressive scans.
const trimFixtures = [
  { progressive: false, sampling: "4:4:4", data: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAASABIDAREAAhEBAxEB/8QAFwABAAMAAAAAAAAAAAAAAAAABQIEB//EABwQAAEFAQEBAAAAAAAAAAAAAAEABAUhIjECEf/EABoBAAEFAQAAAAAAAAAAAAAAAAUAAwQGBwH/xAAZEQADAQEBAAAAAAAAAAAAAAAAAQQCESH/2gAMAwEAAhEDEQA/AM9ZxPMruWKWoeZxPMqTllmlqFRE0Mp3oZVXhNnE8yhmWYzLUPM4nmVJyyzS1CgiaGU70NKrwos/Iqgh2TJZWx9n5FUFIyWaVsUHkfBQToaTfD//2Q==" },
  { progressive: false, sampling: "4:2:0", data: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAASABIDASIAAhEBAxEB/8QAGAABAQEBAQAAAAAAAAAAAAAAAAUGBAf/xAAcEAACAgMBAQAAAAAAAAAAAAAAAQQhBSIxAhH/xAAZAQACAwEAAAAAAAAAAAAAAAAEBgACBQf/xAAdEQEAAgAHAAAAAAAAAAAAAAAAAwUCEhUhMUFh/9oADAMBAAIRAxEAPwDz2Hieal6HiealiHieal6Hieal48aVdpxuzyxNLUG1WJpagKzm3VPXDD8qqRfh+VVIAz43JqvpUXlfFSAAUbX/2Q==" },
  { progressive: true, sampling: "4:4:4", data: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wgARCAASABIDAREAAhEBAxEB/8QAFwABAAMAAAAAAAAAAAAAAAAABAIDBv/EABkBAAIDAQAAAAAAAAAAAAAAAAIEAAMFBv/aAAwDAQACEAMQAAABz0j7dNROSW4x9mmo3aFuSfZpqN3/xAAYEAADAQEAAAAAAAAAAAAAAAAAAgMTEP/aAAgBAQABBQJJCSMhJCSMhBOf/8QAFxEBAQEBAAAAAAAAAAAAAAAAAwATEP/aAAgBAwEBPwEliW1iWJbWKLn/xAAWEQEBAQAAAAAAAAAAAAAAAAABABD/2gAIAQIBAT8BIwjCM//EABQQAQAAAAAAAAAAAAAAAAAAADD/2gAIAQEABj8CH//EABgQAQEBAQEAAAAAAAAAAAAAAABhAXER/9oACAEBAAE/IYouUUXLDDx//9oADAMBAAIAAwAAABBDll+//8QAGBEBAQEBAQAAAAAAAAAAAAAAAQAQIRH/2gAIAQMBAT8QwDjQOJMmF8v/xAAXEQEBAQEAAAAAAAAAAAAAAAAAAREg/9oACAECAQE/EKU1Sm8H/8QAGBAAAwEBAAAAAAAAAAAAAAAAAAEhMRH/2gAIAQEAAT8QwGAUIYDAKEESIRIhJxRH/9k=" },
  { progressive: true, sampling: "4:2:0", data: "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wgARCAASABIDASIAAhEBAxEB/8QAGAABAQEBAQAAAAAAAAAAAAAAAAQFAwb/xAAZAQACAwEAAAAAAAAAAAAAAAADBQABBAb/2gAMAwEAAhADEAAAAfPX2X3M5tituF5n5OoFbf/EABgQAAMBAQAAAAAAAAAAAAAAAAACAxMQ/9oACAEBAAEFAkkJIyEkJIyEE5//xAAXEQEBAQEAAAAAAAAAAAAAAAAEABAU/9oACAEDAQE/ASquqLn/xAAYEQACAwAAAAAAAAAAAAAAAAAAAgEQEf/aAAgBAgEBPwFZNFr/xAAUEAEAAAAAAAAAAAAAAAAAAAAw/9oACAEBAAY/Ah//xAAYEAEBAQEBAAAAAAAAAAAAAAAAYQFxEf/aAAgBAQABPyGKLlFFyww8f//aAAwDAQACAAMAAAAQCze//8QAGREAAQUAAAAAAAAAAAAAAAAAABAhMUFx/9oACAEDAQE/EIHNFE//xAAUEQEAAAAAAAAAAAAAAAAAAAAg/9oACAECAQE/EA3/xAAYEAADAQEAAAAAAAAAAAAAAAAAASExEf/aAAgBAQABPxDAYBQhgMAoQRIhEiEnFEf/2Q==" },
];

describe("JPEG odd surface padding", () => {
  it.each(trimFixtures)("trims $sampling progressive=$progressive without touching scan data", ({ data }) => {
    const original = Buffer.from(data, "base64");
    const trimmed = trimJpegToWidthHeight(Buffer.from(original), 17, 17)!;
    expect(jpegDimensions(trimmed)).toEqual({ width: 17, height: 17 });
    const changed = [...original.keys()].filter((index) => original[index] !== trimmed[index]);
    expect(changed).toHaveLength(2);
    expect(changed.map((index) => [original[index], trimmed[index]])).toEqual([[18, 17], [18, 17]]);
    expect(trimJpegToWidthHeight(Buffer.from(original), 17, 18)).not.toBeNull();
    expect(trimJpegToWidthHeight(Buffer.from(original), 18, 17)).not.toBeNull();
    expect(trimJpegToWidthHeight(Buffer.from(original), 18, 18)).toEqual(original);
  });

  it("rejects expansion, multi-pixel/even-boundary trims and invalid headers without mutation", () => {
    for (const [source, width, height] of [
      [jpeg(18, 18), 16, 18], [jpeg(17, 18), 16, 18], [jpeg(18, 17), 18, 16],
      [jpeg(18, 18), 19, 18], [jpeg(18, 18), 18, 15], [jpeg(18, 18), 0, 18],
      [jpeg(18, 18), 17.5, 18], [jpeg(18, 18), 17, NaN], [Buffer.from("invalid"), 17, 17],
      [jpeg(18, 18).subarray(0, 13), 17, 17],
    ] as const) {
      const original = Buffer.from(source);
      expect(trimJpegToWidthHeight(source, width, height)).toBeNull();
      expect(source).toEqual(original);
    }
    for (const sampling of [0, 0x01, 0x10, 0x31, 0x13]) {
      const source = jpeg(18, 18);
      source[13] = sampling;
      expect(trimJpegToWidthHeight(source, 17, 17)).toBeNull();
    }
  });
});

describe("private pane capture", () => {
  it("publishes the first JPEG immediately, ACKs repeated tokens and retains only the newest paced frame", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.capture.setEnabled(true);
    await flush();
    h.frame(jpeg(100, 100));
    h.frame(jpeg(200, 100));
    h.frame(jpeg(300, 100));
    expect(h.frames.map((frame) => frame.width)).toEqual([100]);
    expect(h.sendCommand.mock.calls.filter(([method]) => method === "Page.screencastFrameAck")).toEqual([
      ["Page.screencastFrameAck", { sessionId: 1 }, "capture-1"],
      ["Page.screencastFrameAck", { sessionId: 1 }, "capture-1"],
    ]);
    vi.advanceTimersByTime(33);
    expect(h.frames.map((frame) => frame.width)).toEqual([100]);
    vi.advanceTimersByTime(1);
    expect(h.frames.map((frame) => frame.width)).toEqual([100, 300]);
    expect(h.sendCommand.mock.calls.filter(([method]) => method === "Page.screencastFrameAck")).toHaveLength(3);
    vi.advanceTimersByTime(1000);
    h.frame(jpeg(400, 100));
    h.frame(jpeg(500, 100));
    expect(h.frames.map((frame) => frame.width)).toEqual([100, 300, 400]);
    h.capture.dispose();
    expect(h.sendCommand.mock.calls.filter(([method]) => method === "Page.screencastFrameAck")).toHaveLength(5);
    await flush();
  });

  it("ACKs invalid and stale frames but never unrelated sessions or events", async () => {
    const h = harness();
    h.capture.setEnabled(true);
    await flush();
    h.frame(Buffer.from("not jpeg"));
    expect(h.frames).toEqual([]);
    h.frame(jpeg(), "agent-session");
    h.events.emit("message", {}, "Runtime.consoleAPICalled", {}, "capture-1");
    h.capture.setEnabled(false);
    h.frame();
    await flush();
    expect(h.frames).toEqual([]);
    expect(h.sendCommand.mock.calls.filter(([method]) => method === "Page.screencastFrameAck")).toHaveLength(2);
    expect(h.events.listenerCount("message")).toBe(0);
    expect(h.events.listenerCount("detach")).toBe(0);
    h.capture.dispose();
    await flush();
    expect(h.events.listenerCount("message")).toBe(0);
  });

  it("serializes quality cutovers, drops pending frames and rejects obsolete generations", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.capture.setEnabled(true);
    await flush();
    h.frame(jpeg(100, 100));
    h.frame(jpeg(200, 100));
    h.capture.setQuality(85);
    h.frame(jpeg(300, 100), "capture-1");
    await flush();
    h.frame(jpeg(400, 100), "capture-2");
    vi.advanceTimersByTime(100);
    expect(h.frames.map((frame) => frame.width)).toEqual([100, 400]);
    const lifecycle = h.sendCommand.mock.calls.filter(([method]) => /startScreencast|stopScreencast|detachFromTarget/.test(method));
    expect(lifecycle).toEqual([
      ["Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 }, "capture-1"],
      ["Page.stopScreencast", {}, "capture-1"],
      ["Target.detachFromTarget", { sessionId: "capture-1" }],
      ["Page.startScreencast", { format: "jpeg", quality: 85, everyNthFrame: 1 }, "capture-2"],
    ]);
    h.capture.dispose();
    await flush();
  });

  it("detaches a late attachment without starting it after disposal", async () => {
    const h = harness();
    let resolveAttach!: (value: unknown) => void;
    h.sendCommand.mockImplementation(async (method) => {
      if (method === "Target.getTargetInfo") return { targetInfo: { targetId: "page", type: "page" } };
      if (method === "Target.attachToTarget") return new Promise((resolve) => { resolveAttach = resolve; });
      return {};
    });
    h.capture.setEnabled(true);
    await flush();
    h.capture.dispose();
    resolveAttach({ sessionId: "late" });
    await flush();
    expect(h.sendCommand).toHaveBeenCalledWith("Target.detachFromTarget", { sessionId: "late" });
    expect(h.sendCommand.mock.calls.some(([method]) => method === "Page.startScreencast")).toBe(false);
    expect(h.frames).toEqual([]);
    expect(h.events.listenerCount("message")).toBe(0);
  });

  it("stops on command failure without retry and recovers only on an explicit restart", async () => {
    const h = harness();
    h.sendCommand.mockRejectedValueOnce(new Error("unavailable"));
    h.capture.setEnabled(true);
    await flush();
    expect(h.errors).toHaveLength(1);
    h.capture.setEnabled(true);
    await flush();
    expect(h.sendCommand).toHaveBeenCalledTimes(1);
    h.capture.setEnabled(false);
    h.capture.setEnabled(true);
    await flush();
    h.frame();
    expect(h.frames[0]).toMatchObject({ width: 1280, height: 800, jpeg: jpeg() });
    h.capture.dispose();
    await flush();
  });

  it("refuses a non-page root without attaching", async () => {
    const h = harness();
    h.sendCommand.mockResolvedValueOnce({ targetInfo: { targetId: "tab", type: "tab" } });
    h.capture.setEnabled(true);
    await flush();
    expect(h.errors).toHaveLength(1);
    expect(h.sendCommand.mock.calls.map(([method]) => method)).toEqual(["Target.getTargetInfo"]);
    h.capture.dispose();
    await flush();
  });

  it("does not decode superseded pending events", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.capture.setEnabled(true);
    await flush();
    const first = jpeg(100, 100);
    const dropped = jpeg(200, 100);
    const newest = jpeg(300, 100);
    const decode = vi.spyOn(Buffer, "from");
    h.frame(first);
    h.frame(dropped);
    h.frame(newest);
    vi.advanceTimersByTime(34);
    const calls: unknown[][] = decode.mock.calls;
    const decoded = calls.filter((args) => args[1] === "base64").map((args) => args[0]);
    decode.mockRestore();
    expect(decoded).toEqual([first.toString("base64"), newest.toString("base64")]);
    h.capture.dispose();
    await flush();
  });

  it.each(["Page.startScreencast", "Page.screencastFrameAck"])("stops a failed %s generation and cleans its session", async (failed) => {
    const h = harness();
    const normal = h.sendCommand.getMockImplementation()!;
    h.sendCommand.mockImplementation(async (method, params, sessionId) => {
      if (method === failed) throw new Error("capture failed");
      return normal(method, params, sessionId);
    });
    h.capture.setEnabled(true);
    await flush();
    if (failed === "Page.screencastFrameAck") h.frame();
    await flush();
    const count = h.frames.length;
    h.frame(jpeg(200, 100));
    await flush();
    expect(h.frames).toHaveLength(count);
    expect(h.errors).toHaveLength(1);
    expect(h.sendCommand).toHaveBeenCalledWith("Target.detachFromTarget", { sessionId: "capture-1" });
    h.capture.dispose();
    await flush();
  });

  it("fences queued frames immediately when the debugger detaches", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.capture.setEnabled(true);
    await flush();
    h.frame(jpeg(100, 100));
    h.frame(jpeg(200, 100));
    h.events.emit("detach", {}, "target closed");
    vi.advanceTimersByTime(1000);
    await flush();
    expect(h.frames.map((frame) => frame.width)).toEqual([100]);
    expect(h.errors).toHaveLength(1);
    h.capture.dispose();
    await flush();
    expect(h.events.listenerCount("detach")).toBe(0);
  });

  it.each(["Page.stopScreencast", "Target.detachFromTarget"])("does not start a replacement when %s fails", async (failed) => {
    const h = harness();
    h.capture.setEnabled(true);
    await flush();
    const normal = h.sendCommand.getMockImplementation()!;
    h.sendCommand.mockImplementation(async (method, params, sessionId) => {
      if (method === failed) throw new Error("teardown failed");
      return normal(method, params, sessionId);
    });
    h.capture.setQuality(85);
    await flush();
    h.frame();
    expect(h.frames).toEqual([]);
    expect(h.errors).toHaveLength(1);
    expect(h.sendCommand.mock.calls.filter(([method]) => method === "Target.attachToTarget")).toHaveLength(1);
    expect(h.sendCommand).toHaveBeenCalledWith("Target.detachFromTarget", { sessionId: "capture-1" });
    h.capture.dispose();
    await flush();
  });

  it("ACKs malformed events and ACKs a frame in finally when publication throws", async () => {
    const h = harness(() => { throw "publication failed"; });
    h.capture.setEnabled(true);
    await flush();
    h.events.emit("message", {}, "Page.screencastFrame", { data: 4, sessionId: 9 }, "capture-1");
    expect(h.errors).toEqual([]);
    h.frame(jpeg(), "capture-1", 10);
    await flush();
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]).toBeInstanceOf(Error);
    expect(h.errors[0]?.message).toBe("publication failed");
    expect(h.sendCommand.mock.calls.filter(([method]) => method === "Page.screencastFrameAck")).toEqual([
      ["Page.screencastFrameAck", { sessionId: 9 }, "capture-1"],
      ["Page.screencastFrameAck", { sessionId: 10 }, "capture-1"],
    ]);
    expect(h.frames).toEqual([]);
    expect(h.events.listenerCount("message")).toBe(0);
    h.capture.dispose();
    await flush();
  });

  it("ACKs fenced pending events once and releases detached session ownership", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.capture.setEnabled(true);
    await flush();
    h.frame(jpeg(100, 100), "capture-1", 1);
    h.frame(jpeg(200, 100), "capture-1", 2);
    expect(h.sendCommand.mock.calls.filter(([method]) => method === "Page.screencastFrameAck")).toHaveLength(1);
    h.capture.setQuality(85);
    expect(h.sendCommand.mock.calls.filter(([method]) => method === "Page.screencastFrameAck")).toHaveLength(2);
    h.frame(jpeg(300, 100), "capture-1", 3);
    await flush();
    h.frame(jpeg(400, 100), "capture-1", 4);
    expect(h.sendCommand.mock.calls.filter(([method]) => method === "Page.screencastFrameAck").map(([, params]) => params)).toEqual([
      { sessionId: 1 }, { sessionId: 2 }, { sessionId: 3 },
    ]);
    h.frame(jpeg(500, 100), "capture-2", 5);
    h.capture.setEnabled(false);
    await flush();
    vi.advanceTimersByTime(100);
    expect(h.frames.map((frame) => frame.width)).toEqual([100]);
    expect(h.sendCommand.mock.calls.filter(([method]) => method === "Page.screencastFrameAck").map(([, params]) => params)).toEqual([
      { sessionId: 1 }, { sessionId: 2 }, { sessionId: 3 }, { sessionId: 5 },
    ]);
    expect(h.events.listenerCount("message")).toBe(0);
    h.capture.dispose();
    await flush();
  });

  it("disposes immediately despite cleanup rejection and releases its listeners", async () => {
    vi.useFakeTimers();
    const h = harness();
    h.capture.setEnabled(true);
    await flush();
    h.frame(jpeg(100, 100));
    h.frame(jpeg(200, 100));
    h.sendCommand.mockRejectedValue(new Error("target gone"));
    h.capture.dispose();
    vi.advanceTimersByTime(100);
    await flush();
    expect(h.frames.map((frame) => frame.width)).toEqual([100]);
    expect(h.errors).toEqual([]);
    expect(h.events.listenerCount("message")).toBe(0);
    expect(h.events.listenerCount("detach")).toBe(0);
  });
});
