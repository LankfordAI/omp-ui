import { describe, expect, it } from "vitest";
import { PhraseSegmenter } from "./stt-segmenter";

const RATE = 48_000;
/** 100 ms at 48 kHz. */
const CHUNK = 4_800;

function voice(n: number): Float32Array[] {
  return Array.from({ length: n }, () => new Float32Array(CHUNK).fill(0.2));
}

function quiet(n: number): Float32Array[] {
  return Array.from({ length: n }, () => new Float32Array(CHUNK));
}

describe("PhraseSegmenter", () => {
  it("closes a phrase at a 600 ms pause, including the pause", () => {
    const seg = new PhraseSegmenter(RATE);
    for (const chunk of [...voice(10), ...quiet(5)]) expect(seg.push(chunk)).toBeNull();
    expect(seg.push(quiet(1)[0]!)).toHaveLength(16);
    for (const chunk of quiet(10)) expect(seg.push(chunk)).toBeNull();
    expect(seg.flush()).toBeNull();
  });

  it("keeps only 300 ms of pre-roll ahead of speech", () => {
    const seg = new PhraseSegmenter(RATE);
    for (const chunk of [...quiet(20), ...voice(5)]) expect(seg.push(chunk)).toBeNull();
    const phrase = seg.flush();
    expect(phrase).toHaveLength(8);
    expect(phrase![0]!.every((s) => s === 0)).toBe(true);
    expect(phrase![3]![0]).toBeCloseTo(0.2);
  });

  it("drops a phrase with under 250 ms of speech", () => {
    const seg = new PhraseSegmenter(RATE);
    for (const chunk of [...voice(2), ...quiet(6)]) expect(seg.push(chunk)).toBeNull();
    expect(seg.flush()).toBeNull();
  });

  it("cuts unbroken speech at 25 s", () => {
    const seg = new PhraseSegmenter(RATE);
    const chunks = voice(250);
    for (const chunk of chunks.slice(0, 249)) expect(seg.push(chunk)).toBeNull();
    expect(seg.push(chunks[249]!)).toHaveLength(250);
  });

  it("flush returns the open phrase once", () => {
    const seg = new PhraseSegmenter(RATE);
    for (const chunk of voice(4)) seg.push(chunk);
    expect(seg.flush()).toHaveLength(4);
    expect(seg.flush()).toBeNull();
  });
});
