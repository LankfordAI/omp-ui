/**
 * Live phrase segmentation for dictation (issue #746). Splits the capture
 * stream at pauses so each phrase is transcribed while the user keeps
 * talking. The gate is chunk-granular: ScriptProcessor chunks are 4096
 * frames (~85 ms at 48 kHz), fine enough for a 600 ms pause.
 */

/** RMS at or above this (about −40 dBFS) counts a chunk as voiced. */
export const SPEECH_RMS = 0.01;
/** A pause this long after speech closes the phrase. */
export const PAUSE_MS = 600;
/** Silence kept ahead of the first voiced chunk so onsets are not clipped. */
export const PRE_ROLL_MS = 300;
/** A phrase with less voiced audio than this is a click or cough: dropped. */
export const MIN_VOICED_MS = 250;
/** Unbroken audio is cut here; providers cap one request at 60 s upstream. */
export const MAX_PHRASE_MS = 25_000;

function rms(chunk: Float32Array): number {
  if (chunk.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < chunk.length; i += 1) sum += chunk[i]! * chunk[i]!;
  return Math.sqrt(sum / chunk.length);
}

export class PhraseSegmenter {
  private readonly pauseSamples: number;
  private readonly preRollSamples: number;
  private readonly minVoicedSamples: number;
  private readonly maxSamples: number;
  private chunks: Float32Array[] = [];
  private samples = 0;
  private voiced = 0;
  private silentRun = 0;

  constructor(sampleRate: number) {
    const at = (ms: number): number => Math.round((sampleRate * ms) / 1000);
    this.pauseSamples = at(PAUSE_MS);
    this.preRollSamples = at(PRE_ROLL_MS);
    this.minVoicedSamples = at(MIN_VOICED_MS);
    this.maxSamples = at(MAX_PHRASE_MS);
  }

  /** Feeds one captured chunk; returns the phrase this chunk closes, if any. */
  push(chunk: Float32Array): Float32Array[] | null {
    this.chunks.push(chunk);
    this.samples += chunk.length;
    if (rms(chunk) >= SPEECH_RMS) {
      this.voiced += chunk.length;
      this.silentRun = 0;
    } else {
      this.silentRun += chunk.length;
    }
    if (this.voiced === 0) {
      // Before speech only the pre-roll survives: silence is never billed.
      while (
        this.chunks.length > 1 &&
        this.samples - this.chunks[0]!.length >= this.preRollSamples
      ) {
        this.samples -= this.chunks.shift()!.length;
      }
      return null;
    }
    if (this.silentRun >= this.pauseSamples || this.samples >= this.maxSamples) {
      return this.close();
    }
    return null;
  }

  /** The stop: the open phrase, or null when it holds too little speech. */
  flush(): Float32Array[] | null {
    return this.close();
  }

  private close(): Float32Array[] | null {
    const phrase = this.voiced >= this.minVoicedSamples ? this.chunks : null;
    this.chunks = [];
    this.samples = 0;
    this.voiced = 0;
    this.silentRun = 0;
    return phrase;
  }
}
