import { useCallback, useEffect, useRef, useState } from "react";
import { backendFor } from "../backend";
import { findOwner, useStore } from "../store";
import { bytesToBase64 } from "./clipboard-image";
import { t as translate } from "./i18n";
import { concatChunks, encodeWavPcm16, resampleLinear, STT_SAMPLE_RATE } from "./stt-wav";

/**
 * Dictation capture (issue #647). MediaRecorder/Blob are deliberately absent:
 * reading a recorded Blob back throws NotReadableError under this Electron
 * sandbox (verified on 43.2.0 — blob I/O needs shm mappings the harness
 * blocks), so audio is pulled through a ScriptProcessor into typed-array
 * memory and encoded by lib/stt-wav. ScriptProcessor itself is deprecated but
 * is the only pure-memory tap that needs no AudioWorklet module URL — and a
 * module URL would need a Blob URL, the same blocked path.
 */

export type DictationPhase = "off" | "requesting" | "recording" | "transcribing" | "error";

/** Providers cap an STT request at 60 s upstream; stop at the cap, abort at 65. */
export const DICTATION_MAX_SECONDS = 60;
/** ½ s at 16 kHz: below this, or with no signal at all, it is a mis-click. */
const MIN_SAMPLES_AT_16K = 8_000;

export interface Dictation {
  phase: DictationPhase;
  /** Elapsed seconds while recording, for the button title. */
  seconds: number;
  error: string | null;
  /** Media capture is possible in this context and the global setting is on. */
  supported: boolean;
  /** off→start capture; recording→stop and transcribe. */
  toggle(): void;
  /** Discard the take (Escape while recording). */
  cancel(): void;
  dismissError(): void;
}

interface Capture {
  stream: MediaStream;
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  sink: GainNode;
  chunks: Float32Array[];
  startedAt: number;
}

function closeCapture(cap: Capture): Promise<void> {
  cap.processor.disconnect();
  cap.source.disconnect();
  cap.sink.disconnect();
  for (const track of cap.stream.getTracks()) track.stop();
  return cap.ctx.close().catch(() => undefined);
}

export function useDictation(tabId: string, onInsert: (text: string) => void): Dictation {
  const voiceInputEnabled = useStore((s) => s.state?.voiceInputEnabled === true);
  const instanceId = useStore((s) => findOwner(s.state, tabId)?.instanceId ?? null);
  const supported = voiceInputEnabled && navigator.mediaDevices !== undefined;
  const [phase, setPhase] = useState<DictationPhase>("off");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const capture = useRef<Capture | null>(null);
  const tick = useRef<number | null>(null);
  const disposed = useRef(false);
  /** Phase as of the last transition, readable from async continuations that
   *  may resolve before the state write renders. */
  const phaseRef = useRef<DictationPhase>("off");
  const goto = useCallback((next: DictationPhase): void => {
    phaseRef.current = next;
    setPhase(next);
  }, []);
  // The insert callback changes every keystroke; the async paths must see the
  // current one without re-subscribing every render.
  const onInsertRef = useRef(onInsert);
  onInsertRef.current = onInsert;
  const instanceRef = useRef(instanceId);
  instanceRef.current = instanceId;

  const stopTick = useCallback((): void => {
    if (tick.current !== null) {
      cancelAnimationFrame(tick.current);
      tick.current = null;
    }
  }, []);

  /** Every path out of capture: device LED off, nodes disconnected. */
  const teardown = useCallback(async (): Promise<void> => {
    const cap = capture.current;
    capture.current = null;
    stopTick();
    if (cap !== null) await closeCapture(cap);
  }, [stopTick]);

  const fail = useCallback(
    (message: string) => {
      void teardown();
      setError(message);
      goto("error");
    },
    [goto, teardown],
  );

  const finish = useCallback(
    async (capped: boolean) => {
      const cap = capture.current;
      if (cap === null) return;
      goto("transcribing");
      const { samples, peak } = concatChunks(cap.chunks);
      const sampleRate = cap.ctx.sampleRate;
      await teardown();
      // Empty guard: a mis-click or a silent device must not bill a provider.
      const mono16 =
        peak === 0 ? new Float32Array(0) : resampleLinear(samples, sampleRate, STT_SAMPLE_RATE);
      if (mono16.length < MIN_SAMPLES_AT_16K) {
        goto("off");
        return;
      }
      try {
        const result = await backendFor(instanceRef.current).transcribeAudio({
          audioBase64: bytesToBase64(encodeWavPcm16(mono16, STT_SAMPLE_RATE)),
          // null lets the provider auto-detect; omp-ui does not guess locales.
          language: null,
        });
        if (result.text !== "") onInsertRef.current(result.text);
        setError(capped ? translate("composer.dictation.capped") : null);
        goto(capped ? "error" : "off");
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        setError(raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, ""));
        goto("error");
      }
    },
    [goto, teardown],
  );

  const cancel = useCallback((): void => {
    if (phaseRef.current === "requesting") {
      // Nothing to discard yet; the resolving getUserMedia sees a phase other
      // than "requesting" and stops the stream itself.
      goto("off");
      return;
    }
    if (capture.current === null) return;
    void teardown();
    goto("off");
  }, [goto, teardown]);

  const toggle = useCallback((): void => {
    if (!supported) return;
    if (capture.current !== null) {
      void finish(false);
      return;
    }
    if (phaseRef.current === "requesting" || phaseRef.current === "transcribing") return;
    setError(null);
    goto("requesting");
    navigator.mediaDevices
      .getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      })
      .then(async (stream) => {
        if (disposed.current || phaseRef.current !== "requesting") {
          for (const track of stream.getTracks()) track.stop();
          return;
        }
        const ctx = new AudioContext();
        const source = ctx.createMediaStreamSource(stream);
        const sink = ctx.createGain();
        sink.gain.value = 0; // muted: pulls audio without feedback
        source.connect(sink);
        sink.connect(ctx.destination);
        const chunks: Float32Array[] = [];
        const processor = ctx.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (event) => {
          chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
        };
        source.connect(processor);
        processor.connect(sink);
        capture.current = { stream, ctx, source, processor, sink, chunks, startedAt: Date.now() };
        setSeconds(0);
        goto("recording");
        const step = (): void => {
          const cap = capture.current;
          if (cap === null) return;
          const elapsed = (Date.now() - cap.startedAt) / 1000;
          if (elapsed >= DICTATION_MAX_SECONDS) {
            void finish(true);
            return;
          }
          setSeconds(Math.floor(elapsed));
          tick.current = requestAnimationFrame(step);
        };
        tick.current = requestAnimationFrame(step);
      })
      .catch((err: unknown) => {
        const name = err instanceof Error && "name" in err ? (err as DOMException).name : "";
        fail(
          name === "NotAllowedError"
            ? translate("composer.dictation.errorBlocked")
            : name === "NotReadableError"
              ? translate("composer.dictation.errorBusy")
              : translate("composer.dictation.errorOpen", {
                  message: err instanceof Error ? err.message : String(err),
                }),
        );
      });
  }, [fail, finish, goto, supported]);

  const dismissError = useCallback((): void => {
    setError(null);
    goto("off");
  }, [goto]);

  // Unmount mid-capture (tab closed): drop the device, never leave the LED on.
  useEffect(() => {
    disposed.current = false;
    return () => {
      disposed.current = true;
      const cap = capture.current;
      capture.current = null;
      stopTick();
      if (cap !== null) void closeCapture(cap);
    };
  }, [stopTick]);

  return { phase, seconds, error, supported, toggle, cancel, dismissError };
}
