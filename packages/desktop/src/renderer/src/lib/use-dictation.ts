import { useCallback, useEffect, useRef, useState } from "react";
import { backend } from "../backend";
import { useStore } from "../store";
import { bytesToBase64 } from "./clipboard-image";
import { t as translate } from "./i18n";
import { PhraseSegmenter } from "./stt-segmenter";
import { concatChunks, encodeWavPcm16, resampleLinear, STT_SAMPLE_RATE } from "./stt-wav";

/**
 * Dictation capture (issue #647). MediaRecorder/Blob are deliberately absent:
 * reading a recorded Blob back throws NotReadableError under this Electron
 * sandbox (verified on 43.2.0 — blob I/O needs shm mappings the harness
 * blocks), so audio is pulled through a ScriptProcessor into typed-array
 * memory and encoded by lib/stt-wav. ScriptProcessor itself is deprecated but
 * is the only pure-memory tap that needs no AudioWorklet module URL — and a
 * module URL would need a Blob URL, the same blocked path.
 *
 * Phrases are transcribed live (issue #746): lib/stt-segmenter closes a phrase
 * at each pause, its request goes out while capture continues, and replies are
 * inserted strictly in spoken order. The stop only flushes the open phrase.
 */

export type DictationPhase = "off" | "requesting" | "recording" | "transcribing" | "error";

/** ½ s at 16 kHz: a shorter phrase is a mis-click and is never billed. */
const MIN_SAMPLES_AT_16K = 8_000;

/** Where transcribed phrases go: the Composer's draft. */
export interface DictationSink {
  /** Splices one phrase at the draft caret. Must not move focus: a held R
   *  would auto-repeat into a focused textarea. */
  insert(text: string): void;
  /** The take drained after a stop with at least one phrase inserted. */
  focus(): void;
}

export interface Dictation {
  phase: DictationPhase;
  /** Elapsed seconds while recording, for the button title. */
  seconds: number;
  error: string | null;
  /** Media capture is possible in this context and the global setting is on. */
  supported: boolean;
  /** off→start capture; recording→stop and transcribe the open phrase. */
  toggle(): void;
  /** Stop and transcribe the open phrase (release of the push-to-talk key, issue #707). */
  stop(): void;
  /** Stop capture and drop every reply still in flight (Escape while recording);
   *  phrases already inserted stay in the draft. */
  cancel(): void;
  dismissError(): void;
}

interface Capture {
  stream: MediaStream;
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  processor: ScriptProcessorNode;
  sink: GainNode;
  take: Take;
  startedAt: number;
}

/** One take: outlives its capture until every phrase reply settles. */
interface Take {
  segmenter: PhraseSegmenter;
  /** Insertion chain: phrase N inserts only after phrase N−1 settled. */
  tail: Promise<void>;
  inserted: number;
  failed: boolean;
}

/** A rejected invoke's message without Electron's remote-method wrapper. */
function invokeMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "");
}

function closeCapture(cap: Capture): Promise<void> {
  cap.processor.disconnect();
  cap.source.disconnect();
  cap.sink.disconnect();
  for (const track of cap.stream.getTracks()) track.stop();
  return cap.ctx.close().catch(() => undefined);
}

export function useDictation(target: DictationSink): Dictation {
  const voiceInputEnabled = useStore((s) => s.state?.voiceInputEnabled === true);
  const supported = voiceInputEnabled && navigator.mediaDevices !== undefined;
  const [phase, setPhase] = useState<DictationPhase>("off");
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const capture = useRef<Capture | null>(null);
  const tick = useRef<number | null>(null);
  const disposed = useRef(false);
  /** Released during `requesting` (issue #707): finish as soon as capture opens. */
  const pendingStop = useRef(false);
  /** Phase as of the last transition, readable from async continuations that
   *  may resolve before the state write renders. */
  const phaseRef = useRef<DictationPhase>("off");
  const goto = useCallback((next: DictationPhase): void => {
    phaseRef.current = next;
    setPhase(next);
  }, []);
  // The insert callback changes every keystroke; the async paths must see the
  // current one without re-subscribing every render.
  const targetRef = useRef(target);
  targetRef.current = target;
  /** The take whose phrase replies may still land; null drops every straggler. */
  const take = useRef<Take | null>(null);

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

  const dispatch = useCallback(
    (owner: Take, chunks: Float32Array[], sampleRate: number): void => {
      const mono16 = resampleLinear(concatChunks(chunks).samples, sampleRate, STT_SAMPLE_RATE);
      if (mono16.length < MIN_SAMPLES_AT_16K) return;
      // The local main transcribes whatever tab is focused (issue #659): the
      // mic, the `sttModel` setting, and the provider credential all belong
      // to this app, and `stt:transcribe` rides no instance proxy.
      const request = backend.transcribeAudio({
        audioBase64: bytesToBase64(encodeWavPcm16(mono16, STT_SAMPLE_RATE)),
        // null lets the provider auto-detect; omp-ui does not guess locales.
        language: null,
      });
      // Handled below once the chain reaches it; never an unhandled rejection meanwhile.
      request.catch(() => undefined);
      // Requests overlap; insertion is serialized so phrases land in spoken order.
      owner.tail = owner.tail.then(async () => {
        let text: string;
        try {
          ({ text } = await request);
        } catch (err) {
          if (take.current !== owner || owner.failed) return;
          // A gap would splice later phrases onto earlier ones: end the take.
          owner.failed = true;
          fail(invokeMessage(err));
          return;
        }
        if (take.current !== owner || owner.failed || text === "") return;
        targetRef.current.insert(text);
        owner.inserted += 1;
      });
    },
    [fail],
  );

  const finish = useCallback(async (): Promise<void> => {
    const cap = capture.current;
    if (cap === null) return;
    const owner = cap.take;
    const last = owner.segmenter.flush();
    const sampleRate = cap.ctx.sampleRate;
    goto("transcribing");
    await teardown();
    if (last !== null) dispatch(owner, last, sampleRate);
    await owner.tail;
    if (take.current !== owner || owner.failed) return;
    take.current = null;
    if (owner.inserted > 0) targetRef.current.focus();
    setError(null);
    goto("off");
  }, [dispatch, goto, teardown]);

  const cancel = useCallback((): void => {
    pendingStop.current = false;
    if (phaseRef.current === "requesting") {
      // Nothing to discard yet; the resolving getUserMedia sees a phase other
      // than "requesting" and stops the stream itself.
      goto("off");
      return;
    }
    if (capture.current === null) return;
    // Phrases already inserted stay as draft text; every reply still in flight is dropped.
    take.current = null;
    void teardown();
    goto("off");
  }, [goto, teardown]);

  const stop = useCallback((): void => {
    if (capture.current !== null) {
      void finish();
      return;
    }
    // Released before getUserMedia resolved (quick tap): finish as soon
    // as capture starts rather than dropping the take.
    if (phaseRef.current === "requesting") pendingStop.current = true;
  }, [finish]);

  const toggle = useCallback((): void => {
    if (!supported) return;
    if (capture.current !== null) {
      void finish();
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
        const owner: Take = {
          segmenter: new PhraseSegmenter(ctx.sampleRate),
          tail: Promise.resolve(),
          inserted: 0,
          failed: false,
        };
        take.current = owner;
        const processor = ctx.createScriptProcessor(4096, 1, 1);
        processor.onaudioprocess = (event) => {
          if (take.current !== owner || owner.failed) return;
          const phrase = owner.segmenter.push(new Float32Array(event.inputBuffer.getChannelData(0)));
          if (phrase !== null) dispatch(owner, phrase, ctx.sampleRate);
        };
        source.connect(processor);
        processor.connect(sink);
        capture.current = { stream, ctx, source, processor, sink, take: owner, startedAt: Date.now() };
        if (pendingStop.current) {
          pendingStop.current = false;
          void finish();
          return;
        }
        setSeconds(0);
        goto("recording");
        const step = (): void => {
          const cap = capture.current;
          if (cap === null) return;
          setSeconds(Math.floor((Date.now() - cap.startedAt) / 1000));
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
  }, [dispatch, fail, finish, goto, supported]);

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
      take.current = null;
      stopTick();
      if (cap !== null) void closeCapture(cap);
    };
  }, [stopTick]);

  return { phase, seconds, error, supported, toggle, stop, cancel, dismissError };
}
