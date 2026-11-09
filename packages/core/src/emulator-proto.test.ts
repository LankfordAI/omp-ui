import { describe, expect, it } from "vitest";
import {
  decodeDisplayConfigurations,
  decodeEmulatorNotification,
  decodeImage,
  decodePhysicalModel,
  encodeImageFormat,
  encodeMouseInput,
  encodePhysicalModel,
  encodeTouchInput,
  encodeWheelInput,
  GrpcMessageParser,
  grpcFrame,
} from "./emulator-proto";

function varint(value: number | bigint): number[] {
  let n = BigInt.asUintN(64, BigInt(value));
  const bytes: number[] = [];
  while (n >= 128n) {
    bytes.push(Number(n & 127n) | 128);
    n >>= 7n;
  }
  bytes.push(Number(n));
  return bytes;
}

const scalar = (field: number, value: number | bigint) => [...varint(field << 3), ...varint(value)];
const bytesField = (field: number, bytes: readonly number[]) => [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];

function floats(...values: number[]): number[] {
  const data = new Uint8Array(values.length * 4);
  const view = new DataView(data.buffer);
  values.forEach((value, index) => view.setFloat32(index * 4, value, true));
  return Array.from(data);
}

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

  it("encodes packed little-endian physical values and omits a getter's value", () => {
    expect(Array.from(encodePhysicalModel(1))).toEqual([8, 1]);
    expect(Array.from(encodePhysicalModel(1, [0, 0, -180]))).toEqual([
      8, 1, 26, 14, 10, 12,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 52, 195,
    ]);
    expect(Array.from(encodePhysicalModel(10, [90]))).toEqual([8, 10, 26, 6, 10, 4, 0, 0, 180, 66]);
  });

  it("decodes signed native status, repeated packed values and unpacked float32", () => {
    const raw = Uint8Array.from([
      ...scalar(1, 1),
      ...scalar(2, -3),
      ...bytesField(3, [
        ...bytesField(1, floats(0, 90)),
        13, ...floats(-180),
        ...bytesField(7, [1, 2, 3]),
      ]),
    ]);
    expect(decodePhysicalModel(raw)).toEqual({ target: 1, status: -3, values: [0, 90, -180] });
    expect(decodePhysicalModel(new Uint8Array(0))).toEqual({ target: 0, status: 0, values: [] });
  });

  it.each([NaN, Infinity, -Infinity, 1e100])("rejects non-finite float32 physical data %s", (value) => {
    expect(() => encodePhysicalModel(10, [value])).toThrow(/finite/);
    expect(() => decodePhysicalModel(Uint8Array.from(bytesField(3, bytesField(1, floats(value)))))).toThrow(/finite/);
  });

  it("rejects malformed physical parameters and bounds repeated metadata", () => {
    expect(() => encodePhysicalModel(-1)).toThrow();
    expect(() => encodePhysicalModel(10, new Array(65).fill(0))).toThrow(/too many/);
    expect(() => decodePhysicalModel(Uint8Array.from(bytesField(3, bytesField(1, [0, 0, 0]))))).toThrow(/float/);
    expect(() => decodePhysicalModel(Uint8Array.from(bytesField(3, bytesField(1, floats(...new Array(65).fill(0))))))).toThrow(/too many/);
    expect(() => decodePhysicalModel(Uint8Array.from(bytesField(2, [0])))).toThrow(/status/);
  });

  it("skips unknown varint, bytes, fixed-width and grouped fields", () => {
    const raw = Uint8Array.from([
      ...scalar(90, 0xffffffffffffffffn),
      ...bytesField(91, [0, 255, 0]),
      ...varint((92 << 3) | 1), ...new Array(8).fill(255),
      ...varint((93 << 3) | 5), 1, 2, 3, 4,
      ...varint((94 << 3) | 3), ...scalar(1, 123), ...varint((94 << 3) | 4),
      ...scalar(1, 10),
      ...bytesField(3, bytesField(1, floats(90))),
    ]);
    expect(decodePhysicalModel(raw)).toEqual({ target: 10, status: 0, values: [90] });
  });

  it.each([
    [0],
    [8, 128],
    [8, ...new Array(9).fill(255), 2],
    [26, 3, 10],
    [153, 6, 0],
    [157, 6, 0],
    [155, 6, 164, 6],
    [156, 6],
    [158, 6],
  ])("rejects malformed protobuf %j", (...raw: number[]) => {
    expect(() => decodePhysicalModel(Uint8Array.from(raw))).toThrow();
  });

  it("decodes display configurations without confusing capture and input display IDs", () => {
    const primary = [...scalar(1, 2208), ...scalar(2, 1840), ...scalar(3, 420), ...scalar(4, 1)];
    const cover = [...scalar(1, 1080), ...scalar(2, 2092), ...scalar(3, 420), ...scalar(5, 6), ...scalar(99, 1)];
    expect(decodeDisplayConfigurations(Uint8Array.from([
      ...bytesField(1, primary), ...bytesField(1, cover), ...scalar(2, 3), ...scalar(3, 11),
    ]))).toEqual([
      { display: 0, width: 2208, height: 1840, dpi: 420, flags: 1 },
      { display: 6, width: 1080, height: 2092, dpi: 420, flags: 0 },
    ]);
    expect(decodeDisplayConfigurations(new Uint8Array(0))).toEqual([]);
    expect(() => decodeDisplayConfigurations(Uint8Array.from(bytesField(1, scalar(1, 16385))))).toThrow();
    expect(() => decodeDisplayConfigurations(Uint8Array.from(new Array(65).fill(bytesField(1, [8, 1, 16, 1])).flat()))).toThrow(/too many/);
  });

  it("decodes native posture, display configuration and power notifications", () => {
    expect(decodeEmulatorNotification(Uint8Array.from(bytesField(4, scalar(3, 2))))).toEqual({ type: "posture", posture: 2 });
    expect(decodeEmulatorNotification(Uint8Array.from(bytesField(3, bytesField(1, bytesField(1, [8, 2, 16, 3]))))))
      .toEqual({ type: "display-configurations", displays: [{ display: 0, width: 2, height: 3, dpi: 0, flags: 0 }] });
    expect(decodeEmulatorNotification(Uint8Array.from(bytesField(11, [8, 6, 16, 2]))))
      .toEqual({ type: "display-power", display: 6, powerMode: 2 });
    expect(decodeEmulatorNotification(Uint8Array.from(bytesField(11, []))))
      .toEqual({ type: "display-power", display: 0, powerMode: 0 });
    expect(decodeEmulatorNotification(Uint8Array.from(bytesField(9, [8, 1])))).toEqual({ type: "unknown" });
    expect(decodeEmulatorNotification(Uint8Array.from([
      ...bytesField(4, scalar(3, 3)), ...scalar(100, 42),
    ]))).toEqual({ type: "posture", posture: 3 });
    expect(() => decodeEmulatorNotification(Uint8Array.from([34, 1, 24]))).toThrow();
  });

  it.each([0, 1, 2, 3] as const)("preserves quadrant %s, folded original geometry, display mode and microsecond time", (rotation) => {
    const format = [
      ...bytesField(2, [...scalar(1, rotation), 17, ...new Array(8).fill(0)]),
      ...scalar(3, 2), ...scalar(4, 3), ...scalar(5, 6),
      ...bytesField(7, [...scalar(1, 1080), ...scalar(2, 2092), ...scalar(3, 100), ...scalar(4, 20)]),
      ...scalar(8, 1),
    ];
    const raw = Uint8Array.from([
      ...bytesField(1, format), ...bytesField(4, new Array(24).fill(7)),
      ...scalar(5, 9), ...scalar(6, 1794096000123456), ...scalar(90, 1),
    ]);
    const decoded = decodeImage(raw);
    expect(decoded).toMatchObject({
      width: 2, height: 3, seq: 9, rotation, display: 6, displayMode: 1, timestampUs: 1794096000123456,
      foldedDisplay: { width: 1080, height: 2092, xOffset: 100, yOffset: 20 },
    });
    expect(decoded?.pixels.buffer).toBe(raw.buffer);
    expect(decoded?.pixels.length).toBe(24);
  });

  it("observes same-size 180-degree rotation and supplies absent metadata defaults", () => {
    const normal = decodeImage(image(2, 3, 24));
    const rotated = decodeImage(Uint8Array.from([
      ...bytesField(1, [...bytesField(2, scalar(1, 2)), ...scalar(3, 2), ...scalar(4, 3)]),
      ...bytesField(4, new Array(24).fill(7)),
    ]));
    expect(normal).toMatchObject({ rotation: 0, display: 0, foldedDisplay: null, displayMode: null, timestampUs: 0 });
    expect(rotated).toMatchObject({ width: 2, height: 3, rotation: 2 });
  });

  it("rejects invalid image dimensions, rotation, folded bounds and unsafe timestamps", () => {
    const wrap = (format: number[], extra: number[] = []) => Uint8Array.from([
      ...bytesField(1, format), ...bytesField(4, [1, 2, 3, 4]), ...extra,
    ]);
    for (const width of [0, 16385, 0xffffffff]) {
      expect(() => decodeImage(wrap([...scalar(3, width), ...scalar(4, 1)]))).toThrow(/range/);
    }
    expect(() => decodeImage(wrap([...scalar(3, 1), ...scalar(4, 16385)]))).toThrow(/range/);
    expect(() => decodeImage(wrap([...scalar(3, 1), ...scalar(4, 1), ...bytesField(2, scalar(1, 4))]))).toThrow();
    expect(() => decodeImage(wrap([...scalar(3, 1), ...scalar(4, 1), ...bytesField(7, [])]))).toThrow();
    expect(() => decodeImage(wrap([
      ...scalar(3, 1), ...scalar(4, 1), ...bytesField(7, [8, 1, 16, 1, ...scalar(3, 16384)]),
    ]))).toThrow(/folded/);
    expect(() => decodeImage(wrap([24, 1, 32, 1], scalar(6, 9007199254740992n)))).toThrow();
    expect(() => decodeImage(wrap([24, 1, 32, 1], scalar(6, 0xffffffffffffffffn)))).toThrow();
    expect(() => decodeImage(Uint8Array.from([10, 3, 24]))).toThrow();
  });

  it("carries explicit display IDs on each native input kind and screenshot request", () => {
    expect(Array.from(encodeTouchInput([], 6))).toEqual([18, 2, 16, 6]);
    expect(Array.from(encodeMouseInput(0, 0, 0, 6))).toEqual([26, 2, 32, 6]);
    expect(Array.from(encodeWheelInput(0, 0, 6))).toEqual([50, 2, 24, 6]);
    expect(Array.from(encodeImageFormat({ width: 2, height: 3, display: 6 }))).toEqual([8, 1, 24, 2, 32, 3, 40, 6]);
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

  it("rejects a response ending in an incomplete gRPC header or payload", () => {
    for (const partial of [Uint8Array.from([0, 0, 0]), Uint8Array.from([0, 0, 0, 0, 2, 1])]) {
      const parser = new GrpcMessageParser(1024, () => {});
      parser.push(partial);
      expect(() => parser.end()).toThrow(/truncated/);
      expect(() => parser.push(new Uint8Array(0))).toThrow(/truncated/);
    }
  });

  it("GrpcMessageParser reassembles a 1 MB message from 16 KB chunks plus a trailing message", () => {
    const big = new Uint8Array(1 << 20);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
    const small = Uint8Array.from([9, 8, 7]);
    const a = grpcFrame(big);
    const b = grpcFrame(small);
    const stream = new Uint8Array(a.length + b.length);
    stream.set(a);
    stream.set(b, a.length);
    const got: Uint8Array[] = [];
    const parser = new GrpcMessageParser(2 << 20, (m) => got.push(m.slice()));
    const step = 16 * 1024;
    let pos = 0;
    while (stream.length - pos > step + b.length) {
      parser.push(stream.slice(pos, pos + step));
      pos += step;
    }
    expect(got).toHaveLength(0);
    parser.push(stream.slice(pos));
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual(big);
    expect(got[1]).toEqual(small);
  });
});
