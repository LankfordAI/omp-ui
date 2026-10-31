import { describe, expect, it } from "vitest";
import { decodeImage, encodeTouchInput, encodeWheelInput, GrpcMessageParser, grpcFrame } from "./emulator-proto";

describe("emulator-proto", () => {
  it("encodes a negative wheel dy as a 10-byte varint", () => {
    // InputEvent{wheel_event(6): WheelEvent{dy(2): -120}}
    const msg = encodeWheelInput(0, -120);
    expect(msg[0]).toBe((6 << 3) | 2);
    expect(msg[1]).toBe(11);
    expect(msg[2]).toBe(2 << 3);
    const varint = msg.subarray(3);
    expect(varint.length).toBe(10);
    expect(varint[9]).toBe(1);
    expect(varint.subarray(0, 9).every((b) => (b & 0x80) !== 0)).toBe(true);
  });

  it("writes the repeated Touch even when every scalar is 0", () => {
    const msg = encodeTouchInput([{ x: 0, y: 0, id: 0, pressure: 0 }]);
    // InputEvent{touch_event(2): TouchEvent{touches(1): Touch{expiration(7)=1}}}
    expect(Array.from(msg)).toEqual([(2 << 3) | 2, 4, (1 << 3) | 2, 2, 7 << 3, 1]);
  });

  const image = (width: number, height: number, bytes: number) => {
    const fmt = [3 << 3, width, 4 << 3, height];
    return Uint8Array.from([(1 << 3) | 2, fmt.length, ...fmt, (4 << 3) | 2, bytes, ...new Array(bytes).fill(7), 5 << 3, 9]);
  };

  it("decodes an image and rejects a wrong pixel length", () => {
    const img = decodeImage(image(2, 3, 24));
    expect(img).toMatchObject({ width: 2, height: 3, seq: 9 });
    expect(img?.pixels.length).toBe(24);
    expect(() => decodeImage(image(2, 3, 20))).toThrow();
  });

  it("returns null for an empty image", () => {
    expect(decodeImage(image(2, 3, 0))).toBeNull();
    expect(decodeImage(new Uint8Array(0))).toBeNull();
  });

  it("GrpcMessageParser reassembles a message split across three chunks", () => {
    const got: number[][] = [];
    const parser = new GrpcMessageParser(1024, (m) => got.push(Array.from(m)));
    const frame = grpcFrame(Uint8Array.from([1, 2, 3, 4, 5, 6]));
    parser.push(frame.subarray(0, 2));
    parser.push(frame.subarray(2, 7));
    expect(got).toEqual([]);
    parser.push(frame.subarray(7));
    expect(got).toEqual([[1, 2, 3, 4, 5, 6]]);
  });

  it("GrpcMessageParser rejects a compressed flag and an oversized frame", () => {
    const compressed = grpcFrame(Uint8Array.from([1]));
    compressed[0] = 1;
    expect(() => new GrpcMessageParser(1024, () => {}).push(compressed)).toThrow();
    expect(() => new GrpcMessageParser(2, () => {}).push(grpcFrame(Uint8Array.from([1, 2, 3])))).toThrow();
  });
});
