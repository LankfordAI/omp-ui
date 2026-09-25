import { describe, expect, it } from "vitest";
import { concatChunks, encodeWavPcm16, resampleLinear, STT_SAMPLE_RATE } from "./stt-wav";

function ascii(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += String.fromCharCode(view.getUint8(offset + i));
  return out;
}

describe("encodeWavPcm16", () => {
  it("writes the 44-byte RIFF header fields the providers parse", () => {
    const wav = encodeWavPcm16(new Float32Array([0.5, -0.5]), 16_000);
    const view = new DataView(wav.buffer);
    expect(wav.length).toBe(48);
    expect(ascii(view, 0, 4)).toBe("RIFF");
    expect(view.getUint32(4, true)).toBe(36 + 4); // 36 + data bytes
    expect(ascii(view, 8, 4)).toBe("WAVE");
    expect(ascii(view, 12, 4)).toBe("fmt ");
    expect(view.getUint32(16, true)).toBe(16);
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint32(28, true)).toBe(32_000); // byte rate
    expect(view.getUint16(32, true)).toBe(2);
    expect(view.getUint16(34, true)).toBe(16);
    expect(ascii(view, 36, 4)).toBe("data");
    expect(view.getUint32(40, true)).toBe(4);
  });

  it("clamps and quantizes samples asymmetrically like every PCM16 encoder", () => {
    const wav = encodeWavPcm16(new Float32Array([1, -1, 3, -3, 0]), 16_000);
    const view = new DataView(wav.buffer);
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(-0x8000);
    expect(view.getInt16(48, true)).toBe(0x7fff);
    expect(view.getInt16(50, true)).toBe(-0x8000);
    expect(view.getInt16(52, true)).toBe(0);
  });
});

describe("resampleLinear", () => {
  it("keeps the exact-ratio 48→16 case at one third the length", () => {
    const out = resampleLinear(new Float32Array(480), 48_000, STT_SAMPLE_RATE);
    expect(out.length).toBe(160);
  });

  it("interpolates between neighbours at fractional positions", () => {
    // 32 kHz → 16 kHz is ratio 2: every output sample lands on an input index.
    const ramp = new Float32Array([0, 1, 2, 3]);
    expect(Array.from(resampleLinear(ramp, 32_000, 16_000))).toEqual([0, 2]);
    // ratio 1.5 walks half-steps: 0, mid(1,2), 3.
    const half = resampleLinear(new Float32Array([0, 1, 2, 3, 4, 5, 6]), 24_000, 16_000);
    expect(Array.from(half)).toEqual([0, 1.5, 3, 4.5]);
  });

  it("returns the same buffer untouched at equal rates", () => {
    const samples = new Float32Array([0.25]);
    expect(resampleLinear(samples, 16_000, 16_000)).toBe(samples);
  });
});

describe("concatChunks", () => {
  it("joins chunks in order and reports the absolute peak", () => {
    const { samples, peak } = concatChunks([
      new Float32Array([0.1, -0.2]),
      new Float32Array([]),
      new Float32Array([0.9]),
    ]);
    // Float32 storage: compare via the rounding the samples were built with.
    expect(Array.from(samples).map((x) => Math.round(x * 100) / 100)).toEqual([0.1, -0.2, 0.9]);
    expect(peak).toBeCloseTo(0.9, 6);
  });

  it("handles no data at all", () => {
    expect(concatChunks([])).toEqual({ samples: new Float32Array(0), peak: 0 });
  });
});
