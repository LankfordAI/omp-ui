import type { NotificationCue } from "@omp-ui/core/types";

/**
 * The "Velvet Chord II" desktop-notification cues, synthesized with Web
 * Audio in the Electron desktop renderer (issue: silent GNOME banners).
 * The main process names the cue when a notification posts; nothing here
 * ships an audio file. `playNotificationCue` lazily builds one
 * AudioContext and no-ops when the platform has none.
 */

function epVoice(
  ctx: AudioContext,
  out: AudioNode,
  opts: {
    freq: number;
    start: number;
    atk?: number;
    dec?: number;
    gain?: number;
    cutoff?: number;
    detune?: number;
    tine?: number;
  },
) {
  const { freq, start, atk = 0.012, dec = 0.48, gain = 0.14, cutoff = 1750, detune = 0, tine = 0 } = opts;
  const osc1 = ctx.createOscillator();
  const flt = ctx.createBiquadFilter();
  const g1 = ctx.createGain();
  osc1.type = "triangle";
  osc1.frequency.setValueAtTime(freq, start);
  if (detune) osc1.detune.setValueAtTime(detune, start);
  flt.type = "lowpass";
  flt.frequency.setValueAtTime(cutoff, start);
  flt.frequency.exponentialRampToValueAtTime(Math.max(320, cutoff * 0.42), start + atk + dec);
  g1.gain.setValueAtTime(0.0001, start);
  g1.gain.linearRampToValueAtTime(gain, start + atk);
  g1.gain.exponentialRampToValueAtTime(0.0001, start + atk + dec);
  osc1.connect(flt);
  flt.connect(g1);
  g1.connect(out);
  osc1.start(start);
  osc1.stop(start + atk + dec + 0.04);

  const osc2 = ctx.createOscillator();
  const g2 = ctx.createGain();
  osc2.type = "sine";
  osc2.frequency.setValueAtTime(freq, start);
  g2.gain.setValueAtTime(0.0001, start);
  g2.gain.linearRampToValueAtTime(gain * 0.85, start + atk * 0.8);
  g2.gain.exponentialRampToValueAtTime(0.0001, start + atk + dec * 1.05);
  osc2.connect(g2);
  g2.connect(out);
  osc2.start(start);
  osc2.stop(start + atk + dec * 1.05 + 0.04);

  if (tine > 0) {
    const bell = ctx.createOscillator();
    const gb = ctx.createGain();
    bell.type = "sine";
    bell.frequency.setValueAtTime(freq * 4, start);
    gb.gain.setValueAtTime(0.0001, start);
    gb.gain.linearRampToValueAtTime(gain * tine, start + 0.003);
    gb.gain.exponentialRampToValueAtTime(0.0001, start + 0.09);
    bell.connect(gb);
    gb.connect(out);
    bell.start(start);
    bell.stop(start + 0.11);
  }
}

let ctx: AudioContext | null = null;
let master: GainNode | null = null;

function ensureContext(): { ctx: AudioContext; out: GainNode } | null {
  if (ctx === null) {
    const Ctor = window.AudioContext ?? (window as Partial<typeof window & { webkitAudioContext?: typeof AudioContext }>).webkitAudioContext;
    if (Ctor === undefined) return null;
    try {
      ctx = new Ctor();
      master = ctx.createGain();
      master.gain.value = 0.72;
      master.connect(ctx.destination);
    } catch {
      ctx = null;
      master = null;
      return null;
    }
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  return { ctx, out: master as GainNode };
}

/** Synthesize one cue. Silently no-ops where Web Audio is unavailable. */
export function playNotificationCue(cue: NotificationCue): void {
  const audio = ensureContext();
  if (audio === null) return;
  const { ctx: ac, out } = audio;
  const t = ac.currentTime + 0.01;
  if (cue === "turn") {
    [349.23, 440.0, 523.25, 659.25].forEach((f, i) =>
      epVoice(ac, out, { freq: f, start: t + i * 0.016, atk: 0.015, dec: 0.56, gain: 0.125, cutoff: 1550, detune: i % 2 ? 2.5 : -2.5 }),
    );
    return;
  }
  if (cue === "plan") {
    [[293.66, 440.0, 523.25], [392.0, 493.88, 587.33, 739.99]].forEach((ch, ci) => {
      const st = t + ci * 0.18;
      ch.forEach((f, i) =>
        epVoice(ac, out, { freq: f, start: st + i * 0.01, atk: 0.012, dec: ci === 0 ? 0.24 : 0.46, gain: 0.125, cutoff: 1850, detune: i % 2 ? 2 : -2 }),
      );
    });
    return;
  }
  if (cue === "snooze") {
    const notes = [
      { f: 659.25, off: 0.0, dec: 0.26, g: 0.17 },
      { f: 523.25, off: 0.15, dec: 0.26, g: 0.16 },
      { f: 587.33, off: 0.3, dec: 0.26, g: 0.16 },
      { f: 392.0, off: 0.45, dec: 0.62, g: 0.18 },
    ];
    notes.forEach((n, i) => {
      epVoice(ac, out, {
        freq: n.f,
        start: t + n.off,
        atk: 0.007,
        dec: n.dec,
        gain: n.g,
        cutoff: 2150,
        tine: 0.24,
        detune: i % 2 ? 2 : -2,
      });
    });
    [261.63, 493.88].forEach((f, i) => {
      epVoice(ac, out, {
        freq: f,
        start: t + 0.45,
        atk: 0.02,
        dec: 0.58,
        gain: 0.085,
        cutoff: 1400,
        detune: i ? 2.5 : -2.5,
      });
    });
    return;
  }
  [0, 0.145].forEach((off, pi) => {
    [440.0, 587.33, 659.25, 880.0].forEach((f, i) =>
      epVoice(ac, out, { freq: f, start: t + off, atk: 0.006, dec: pi === 0 ? 0.13 : 0.44, gain: pi === 0 ? 0.115 : 0.135, cutoff: 2500, tine: 0.22, detune: i % 2 ? 3 : -3 }),
    );
  });
}
