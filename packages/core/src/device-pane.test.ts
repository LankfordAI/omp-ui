import { describe, expect, it } from "vitest";
import { decodeDevicePaneFrame, encodeDevicePaneFrameHeader, DEVICE_PANE_FRAME_HEADER_BYTES, type DevicePaneFrameHeader } from "./device-pane";

const header: DevicePaneFrameHeader = {
  width: 1280,
  height: 720,
  dsf: 2,
  bindingId: "12345678-1234-4234-9234-123456789abc",
  geometryRevision: 1,
};

describe("device pane v2 frames", () => {
  it("round trips identity and geometry, retaining a zero-copy JPEG view", () => {
    const encoded = encodeDevicePaneFrameHeader(header);
    expect(encoded.byteLength).toBe(28);
    expect(Array.from(encoded.subarray(6, 8))).toEqual([0x44, 0x50]);
    const storage = new Uint8Array(encoded.length + 8);
    storage.set(encoded, 3);
    storage.set([0xff, 0xd8, 0xff, 0xd9], 3 + encoded.length);
    const frame = storage.subarray(3, 3 + encoded.length + 4);
    const decoded = decodeDevicePaneFrame(frame)!;
    expect(decoded.header).toEqual(header);
    expect(Array.from(decoded.jpeg)).toEqual([0xff, 0xd8, 0xff, 0xd9]);
    expect(decoded.jpeg.buffer).toBe(storage.buffer);
    expect(decoded.jpeg.byteOffset).toBe(frame.byteOffset + DEVICE_PANE_FRAME_HEADER_BYTES);
    frame[28] = 42;
    expect(decoded.jpeg[0]).toBe(42);
  });

  it("supports the u16 geometry and nonzero u32 revision boundaries", () => {
    for (const geometryRevision of [1, 0xffff_ffff]) {
      const value = { ...header, width: 1, height: 0xffff, dsf: 655.35, geometryRevision };
      const frame = new Uint8Array(29);
      frame.set(encodeDevicePaneFrameHeader(value));
      frame[28] = 1;
      expect(decodeDevicePaneFrame(frame)?.header).toEqual(value);
    }
  });

  it("rejects invalid geometry, UUIDs and revisions before encoding", () => {
    for (const [field, values] of Object.entries({
      width: [0, -1, 65536, 1.5, NaN],
      height: [0, -1, 65536, Infinity],
      dsf: [0, -1, 0.001, 655.36, NaN, Infinity],
      geometryRevision: [0, -1, 1.5, 0x1_0000_0000, NaN],
      bindingId: ["", "not-a-uuid", "00000000-0000-0000-0000-000000000000", "12345678-1234-4234-1234-123456789abc"],
    })) {
      for (const value of values) expect(() => encodeDevicePaneFrameHeader({ ...header, [field]: value })).toThrow();
    }
  });

  it("rejects truncated, old, empty and corrupted frames", () => {
    const frame = new Uint8Array(29);
    frame.set(encodeDevicePaneFrameHeader(header));
    frame[28] = 1;
    for (let length = 0; length <= 28; length++) expect(decodeDevicePaneFrame(frame.subarray(0, length))).toBeNull();
    for (const offset of [0, 2, 4, 6, 14, 24]) {
      const malformed = frame.slice();
      if (offset === 14) malformed[14] = 0; // Invalid UUID version.
      else if (offset === 24) malformed.fill(0, 24, 28);
      else malformed.fill(0, offset, offset + 2);
      expect(decodeDevicePaneFrame(malformed)).toBeNull();
    }
    const oldFrame = new Uint8Array(64);
    oldFrame.set([0, 100, 0, 100, 0, 100, 0, 0, 0xff, 0xd8]);
    expect(decodeDevicePaneFrame(oldFrame)).toBeNull();
  });
});
