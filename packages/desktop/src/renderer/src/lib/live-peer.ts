// The renderer-owned WebRTC peer behind omp's `live_connect` (omp ≥ 18.14.0,
// ADR-0071). omp signals the call and keeps its sideband; this peer owns the
// microphone, the speaker, the level meters, and the `oai-events` data channel
// — the only client path that can make the realtime model speak without the
// user talking first (issue #967).

/** What the store hears from one peer. Every callback is fire-and-forget. */
export interface LivePeerEvents {
  /** The realtime server's `session.started` arrived on the data channel. */
  onSessionStarted(): void;
  /** Microphone and speaker RMS in [0, 1], edge-triggered at ≤ 10 Hz. */
  onLevels(input: number, output: number): void;
  /** The audio path died: the peer connection, the data channel, or the mic. */
  onFailed(message: string): void;
}

export interface LivePeer {
  /** The complete (ICE-gathered) SDP offer `live_connect` carries. */
  readonly offer: string;
  /** Applies omp's `sdpAnswer`. */
  accept(answer: string): Promise<void>;
  /** Hold-to-talk: only an enabled track transmits audio. Starts disabled. */
  setMicEnabled(enabled: boolean): void;
  /** One client event on the data channel; false when the channel is not open. */
  send(event: object): boolean;
  /** Idempotent: stops the mic, the speaker, the meters, and the connection. */
  close(): void;
}

export type LivePeerFactory = (events: LivePeerEvents) => Promise<LivePeer>;

/** The data channel label omp's native peer opens too (pi-natives). */
const EVENTS_CHANNEL = "oai-events";
/** The signaling POST is not trickle ICE: the offer must carry its candidates. */
const ICE_GATHER_TIMEOUT_MS = 3_000;
const LEVEL_INTERVAL_MS = 100;

function rms(buffer: Float32Array<ArrayBuffer>): number {
  let sum = 0;
  for (const v of buffer) sum += v * v;
  return Math.min(1, Math.sqrt(sum / buffer.length));
}

async function openBrowserLivePeer(events: LivePeerEvents): Promise<LivePeer> {
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const track = mic.getAudioTracks()[0];
  if (track === undefined) {
    for (const t of mic.getTracks()) t.stop();
    throw new Error("no microphone track");
  }
  track.enabled = false;
  const ctx = new AudioContext();
  const pc = new RTCPeerConnection();
  const channel = pc.createDataChannel(EVENTS_CHANNEL);
  const speaker = new Audio();
  const inputMeter = ctx.createAnalyser();
  ctx.createMediaStreamSource(mic).connect(inputMeter);
  let outputMeter: { node: AnalyserNode; buffer: Float32Array<ArrayBuffer> } | null = null;
  let closed = false;
  const inputBuffer = new Float32Array(inputMeter.fftSize);
  let lastInput = -1;
  let lastOutput = -1;
  const meterTimer = window.setInterval(() => {
    inputMeter.getFloatTimeDomainData(inputBuffer);
    const input = track.enabled ? rms(inputBuffer) : 0;
    let output = 0;
    if (outputMeter !== null) {
      outputMeter.node.getFloatTimeDomainData(outputMeter.buffer);
      output = rms(outputMeter.buffer);
    }
    if (input === lastInput && output === lastOutput) return;
    lastInput = input;
    lastOutput = output;
    events.onLevels(input, output);
  }, LEVEL_INTERVAL_MS);

  const close = (): void => {
    if (closed) return;
    closed = true;
    window.clearInterval(meterTimer);
    channel.onclose = null;
    pc.onconnectionstatechange = null;
    track.onended = null;
    for (const t of mic.getTracks()) t.stop();
    speaker.pause();
    speaker.srcObject = null;
    channel.close();
    pc.close();
    void ctx.close();
  };
  const fail = (message: string): void => {
    if (closed) return;
    close();
    events.onFailed(message);
  };

  pc.addTrack(track, mic);
  pc.ontrack = (e) => {
    const stream = e.streams[0] ?? new MediaStream([e.track]);
    speaker.srcObject = stream;
    void speaker.play().catch(() => undefined);
    const node = ctx.createAnalyser();
    ctx.createMediaStreamSource(stream).connect(node);
    outputMeter = { node, buffer: new Float32Array(node.fftSize) };
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed") fail("connection failed");
  };
  track.onended = () => fail("microphone ended");
  channel.onclose = () => fail("data channel closed");
  channel.onmessage = (e) => {
    if (typeof e.data !== "string") return;
    try {
      const event: unknown = JSON.parse(e.data);
      if (typeof event === "object" && event !== null && "type" in event && event.type === "session.started")
        events.onSessionStarted();
    } catch {
      // Not ours to judge: omp's sideband reports the call's errors.
    }
  };
  try {
    await pc.setLocalDescription(await pc.createOffer());
    if (pc.iceGatheringState !== "complete") {
      const gathered = Promise.withResolvers<void>();
      const timer = window.setTimeout(gathered.resolve, ICE_GATHER_TIMEOUT_MS);
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState !== "complete") return;
        window.clearTimeout(timer);
        gathered.resolve();
      };
      await gathered.promise;
    }
  } catch (err) {
    close();
    throw err;
  }
  const offer = pc.localDescription?.sdp;
  if (offer === undefined || offer.trim() === "") {
    close();
    throw new Error("the live peer produced no SDP offer");
  }
  return {
    offer,
    accept: async (answer) => {
      if (closed) throw new Error("the live peer is closed");
      await pc.setRemoteDescription({ type: "answer", sdp: answer });
    },
    setMicEnabled: (enabled) => {
      if (!closed) track.enabled = enabled;
    },
    send: (event) => {
      if (closed || channel.readyState !== "open") return false;
      channel.send(JSON.stringify(event));
      return true;
    },
    close,
  };
}

let factory: LivePeerFactory = openBrowserLivePeer;

export function openLivePeer(events: LivePeerEvents): Promise<LivePeer> {
  return factory(events);
}

/** Test seam: node has no WebRTC; null restores the browser peer. */
export function setLivePeerFactoryForTests(next: LivePeerFactory | null): void {
  factory = next ?? openBrowserLivePeer;
}
