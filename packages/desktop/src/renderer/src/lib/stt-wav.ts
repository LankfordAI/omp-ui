/**
 * Pure-memory capture encoding for dictation (issue #647).
 *
 * MediaRecorder/Blob are unusable under this app's Electron sandbox — reading
 * a recorded Blob back throws NotReadableError (verified on Electron 43; the
 * blob's backing store needs shm mappings the harness blocks). So capture
 * pulls Float32 chunks through a ScriptProcessor and encodes them here, into
 * typed-array memory only: resample → RIFF/WAVE header → int16 samples.
 */

/** Every dictation model omp-ui calls posts 16 kHz mono PCM16. */
export const STT_SAMPLE_RATE = 16_000;

/** Concatenates captured chunks into one mono buffer; also reports |peak|. */
export function concatChunks(chunks: readonly Float32Array[]): {
  samples: Float32Array;
  peak: number;
} {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const samples = new Float32Array(total);
  let peak = 0;
  let offset = 0;
  for (const chunk of chunks) {
    samples.set(chunk, offset);
    offset += chunk.length;
    for (let i = 0; i < chunk.length; i += 1) {
      const x = Math.abs(chunk[i]!);
      if (x > peak) peak = x;
    }
  }
  return { samples, peak };
}

/**
 * Linear resample. 48 kHz → 16 kHz is the exact-ratio case; generic linear
 * keeps it correct for 44.1 kHz capture too.
 */
export function resampleLinear(
  samples: Float32Array,
  inRate: number,
  outRate: number,
): Float32Array {
  if (inRate === outRate) return samples;
  const ratio = inRate / outRate;
  const out = new Float32Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i += 1) {
    const p = i * ratio;
    const i0 = Math.floor(p);
    const frac = p - i0;
    const a = samples[i0] ?? 0;
    const b = samples[i0 + 1] ?? a;
    out[i] = a * (1 - frac) + b * frac;
  }
  return out;
}

/** Float32 mono → 44-byte-header RIFF WAV, 16-bit PCM, little-endian. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): Uint8Array {
  const n = samples.length;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const ascii = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk length
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, n * 2, true);
  let offset = 44;
  for (let i = 0; i < n; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  return new Uint8Array(buffer);
}
