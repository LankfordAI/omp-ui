import { describe, expect, it } from "vitest";
import { decodeBinaryEvent, decodeFrameDelivery, encodeBinaryEvent, encodeFrameDelivery, makeFrameAck, makeServerEventFrame, makeServerFrameStream, makeServerResponseErr, makeServerResponseOk, parseClientFrame, parseFrameAck, parseServerFrame } from "./protocol";

describe("parseClientFrame", () => {
  it("normalizes a well-formed req with and without args", () => {
    expect(parseClientFrame({ t: "req", id: 1, ch: "state:get", args: [] })).toEqual({
      t: "req",
      id: 1,
      ch: "state:get",
      args: [],
    });
    expect(parseClientFrame({ t: "req", id: 2, ch: "state:get" })).toEqual({
      t: "req",
      id: 2,
      ch: "state:get",
      args: [],
    });
  });

  it("accepts a notify frame", () => {
    expect(parseClientFrame({ t: "notify", ch: "pty:write", args: ["tab", "x"] })).toEqual({
      t: "notify",
      ch: "pty:write",
      args: ["tab", "x"],
    });
  });

  it("drops everything else", () => {
    const bad: unknown[] = [
      null,
      42,
      "str",
      [1, 2, 3],
      {},
      { t: "req" }, // no ch
      { t: "req", id: 1, ch: 7 }, // ch not a string
      { t: "req", id: "1", ch: "state:get" }, // id not a number
      { t: "ev", ch: "state:get" }, // unknown t
      { t: "req", id: 1, ch: "state:get", args: "no" }, // args present but not an array
    ];
    for (const frame of bad) {
      expect(parseClientFrame(frame), JSON.stringify(frame)).toBeNull();
    }
  });
});

describe("parseServerFrame", () => {
  it("normalizes well-formed res frames both ways", () => {
    expect(parseServerFrame({ t: "res", id: 1, ok: true, value: { a: 1 } })).toEqual({
      t: "res",
      id: 1,
      ok: true,
      value: { a: 1 },
    });
    expect(parseServerFrame({ t: "res", id: 2, ok: false, message: "boom" })).toEqual({
      t: "res",
      id: 2,
      ok: false,
      message: "boom",
    });
    // A present-but-wrong `ok` is the error arm; a missing message still
    // serializes as an error the client can surface.
    expect(parseServerFrame({ t: "res", id: 3, ok: "yes" })).toEqual({
      t: "res",
      id: 3,
      ok: false,
      message: "remote call failed",
    });
  });

  it("normalizes an event with args absent or malformed to an empty tuple", () => {
    expect(parseServerFrame({ t: "ev", ch: "pty:data", args: ["t", 1] })).toEqual({
      t: "ev",
      ch: "pty:data",
      args: ["t", 1],
    });
    expect(parseServerFrame({ t: "ev", ch: "onX" })).toEqual({ t: "ev", ch: "onX", args: [] });
    expect(parseServerFrame({ t: "ev", ch: "onX", args: "no" })).toEqual({
      t: "ev",
      ch: "onX",
      args: [],
    });
  });

  it("drops everything else, never throws", () => {
    const bad: unknown[] = [
      null,
      42,
      "str",
      [1, 2],
      {},
      { t: "res" }, // no id
      { t: "res", id: "1", ok: true }, // id not a number
      { t: "ev" }, // ch not a string
      { t: "other", id: 1 },
    ];
    for (const frame of bad) {
      expect(parseServerFrame(frame), JSON.stringify(frame)).toBeNull();
    }
  });

  it("builders round-trip through the parser", () => {
    expect(parseServerFrame(makeServerResponseOk(1, undefined))).toEqual({
      t: "res",
      id: 1,
      ok: true,
      value: null,
    });
    expect(parseServerFrame(makeServerResponseErr(2, "x"))).toEqual({
      t: "res",
      id: 2,
      ok: false,
      message: "x",
    });
    expect(parseServerFrame(makeServerEventFrame("onX", []))).toEqual({
      t: "ev",
      ch: "onX",
      args: [],
    });
  });
});

describe("paired frame transport (#546)", () => {
  it("accepts only a full opaque pairing key in the server handshake", () => {
    const key = "0123456789abcdef".repeat(4);
    expect(parseServerFrame(makeServerFrameStream(key))).toEqual({ t: "frames", key });
    for (const bad of [undefined, 1, "", key.slice(1), key + "0", "g".repeat(64)]) {
      expect(parseServerFrame({ t: "frames", key: bad })).toBeNull();
    }
  });

  it("separates sequenced deliveries from reliable binary events without changing payload bytes", () => {
    const payload = new Uint8Array([0x05, 0x00, 0x03, 0x20, 0, 100, 0, 0, 0xff, 0xd8]);
    const delivery = encodeFrameDelivery(0x01020304, "browser-pane:frame", "한", payload);
    expect(Array.from(delivery.subarray(0, 9))).toEqual([2, 1, 2, 3, 4, 0, 18, 0, 3]);
    expect(decodeFrameDelivery(delivery)).toEqual({
      id: 0x01020304, channel: "browser-pane:frame", tabId: "한", payload,
    });
    expect(decodeBinaryEvent(delivery)).toBeNull();
    const reliable = encodeBinaryEvent("pty:data", "한", payload);
    expect(decodeFrameDelivery(reliable)).toBeNull();
    expect(decodeBinaryEvent(reliable)).toEqual({ channel: "pty:data", tabId: "한", payload });
  });

  it("rejects incomplete envelopes and invalid delivery IDs without granting ACK credit", () => {
    const delivery = encodeFrameDelivery(1, "browser-pane:frame", "t", new Uint8Array([1]));
    expect(decodeFrameDelivery(delivery.subarray(0, 8))).toBeNull();
    expect(decodeFrameDelivery(delivery.subarray(0, 10))).toBeNull();
    delivery.fill(0, 1, 5);
    expect(decodeFrameDelivery(delivery)).toBeNull();
    for (const id of [0, -1, 1.5, 0x100000000, NaN, Infinity, "1"]) {
      expect(parseFrameAck({ t: "ack", id })).toBeNull();
    }
    expect(parseFrameAck({ t: "notify", id: 1 })).toBeNull();
    expect(parseFrameAck(makeFrameAck(0xffff_ffff))).toEqual({ t: "ack", id: 0xffff_ffff });
  });

  it("owns payload bytes even when the incoming Node Buffer shares storage", () => {
    const packet = Buffer.from(encodeFrameDelivery(1, "browser-pane:frame", "t", new Uint8Array([9, 8])));
    const decoded = decodeFrameDelivery(packet)!;
    packet.fill(0);
    expect(Array.from(decoded.payload)).toEqual([9, 8]);
  });
});
