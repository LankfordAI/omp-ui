// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectGroup } from "@omp-ui/core/types";
import { backendState, remoteInstance } from "../test/fixtures";
import type { Dictation } from "./use-dictation";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TAB = "tab-voice";
const INSTANCE = "inst-remote";
const transcribeAudio = vi.fn();
// A proxied take would land here instead of on the local backend (#659).
const remoteInstanceRequest = vi.fn(async () => ({ text: "must not be routed" }));
Object.assign(window, {
  ompBackend: {
    transcribeAudio: (req: unknown) => transcribeAudio(req),
    remoteInstanceRequest,
  },
});

// Dynamic import is required: store.ts captures window.ompBackend at module
// evaluation (same reason as Composer.test.tsx).
const { useStore } = await import("../store");
const { useDictation } = await import("./use-dictation");

/** One ScriptProcessor tap whose pull callback the test fires by hand. */
class ProcessorStub {
  onaudioprocess: ((event: { inputBuffer: { getChannelData: () => Float32Array } }) => void) | null =
    null;
  disconnect = vi.fn();
  connect = vi.fn((): void => {
    if (fireOnConnect !== null) this.fire(fireOnConnect);
  });
  fire(chunk: Float32Array): void {
    this.onaudioprocess?.({ inputBuffer: { getChannelData: () => chunk } });
  }
}

class NodeStub {
  gain = { value: 1 };
  connect = vi.fn();
  disconnect = vi.fn();
}

let processor: ProcessorStub;
let stopTrack: ReturnType<typeof vi.fn>;
let closeCalls: number;
/** When set, the processor tap fires this buffer the moment it connects. */
let fireOnConnect: Float32Array | null = null;

class AudioContextStub {
  sampleRate = 48_000;
  destination = new NodeStub();
  constructor() {
    processor = new ProcessorStub();
  }
  createMediaStreamSource(): NodeStub {
    return new NodeStub();
  }
  createGain(): NodeStub {
    return new NodeStub();
  }
  createScriptProcessor(): ProcessorStub {
    return processor;
  }
  close(): Promise<void> {
    closeCalls += 1;
    return Promise.resolve();
  }
}

function fakeStream(): MediaStream {
  return { getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream;
}

let getUserMedia: ReturnType<typeof vi.fn>;
let root: Root | null = null;
let latest: Dictation;
const inserted: string[] = [];
let focusCalls = 0;

function Probe(): null {
  latest = useDictation({
    insert: (text) => inserted.push(text),
    focus: () => {
      focusCalls += 1;
    },
  });
  return null;
}

function mount(voiceInputEnabled: boolean, ownerId: string | null = null): void {
  const group: ProjectGroup = {
    project: {
      path: "/p",
      name: "P",
      addedAt: "t",
      lastModel: null,
      lastThinkingLevel: null,
      lastAdvisor: null,
      lastAdvisorModel: null,
      defaultModel: null,
      defaultAdvisorModel: null,
      browserClock: false,
      reviewRoster: null,
      knowledgeHome: null,
    },
    sessions: [
      {
        tabId: TAB,
        sessionId: "s",
        lineageDir: "l",
        projectCwd: "/p",
        launchedAt: "t",
        mode: "rpc-ui",
        worktree: null,
        planImplementationSource: null,
        experiment: null,
        agentMode: "build",
        compactionMethod: null,
        approvalMode: null,
        serviceTier: null,
        model: null,
        thinkingLevel: null,
        advisor: false,
        advisorModel: null,
        subagentModels: null,
        proposedPlans: [],
        cachedTitle: null,
        cachedModified: null,
        title: "Voice",
        status: "complete",
        live: "live",
        pendingPlan: null,
        planSettle: null,
        streamStalled: false,
      },
    ],
  };
  useStore.setState({
    state: backendState(
      ownerId === null
        ? { voiceInputEnabled, projects: [group] }
        : {
            voiceInputEnabled,
            projects: [],
            remoteInstances: [remoteInstance({ id: ownerId, projects: [group] })],
          },
    ),
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Probe />));
}

/** 1 s of fake signal at 48 kHz: downsamples past the ½ s provider guard. */
const VOICE = new Float32Array(48_000).fill(0.2);
const SILENCE = new Float32Array(48_000).fill(0);
/** 0.7 s of quiet at 48 kHz: past the 600 ms pause that closes a phrase. */
const PAUSE = new Float32Array(33_600);

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Enough turns for a phrase reply to travel the insertion chain. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await settle();
}

beforeEach(() => {
  closeCalls = 0;
  stopTrack = vi.fn();
  inserted.length = 0;
  focusCalls = 0;
  fireOnConnect = null;
  transcribeAudio.mockReset();
  remoteInstanceRequest.mockClear();
  getUserMedia = vi.fn(async () => fakeStream());
  vi.stubGlobal("AudioContext", AudioContextStub);
  vi.stubGlobal("webkitAudioContext", AudioContextStub);
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia },
    configurable: true,
  });
  // rAF drives the elapsed-seconds tick; tests never let it run.
  vi.stubGlobal("requestAnimationFrame", vi.fn(() => 1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("useDictation", () => {
  it("is unsupported without the global setting and opens nothing", async () => {
    mount(false);
    expect(latest.supported).toBe(false);
    act(() => latest.toggle());
    await settle();
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(latest.phase).toBe("off");
  });

  it("drops a missing mediaDevices (non-secure remote web client)", () => {
    Object.defineProperty(navigator, "mediaDevices", { value: undefined, configurable: true });
    mount(true);
    expect(latest.supported).toBe(false);
  });

  it("records, transcribes, and hands the text to onInsert without sending", async () => {
    mount(true);
    expect(latest.supported).toBe(true);
    transcribeAudio.mockResolvedValue({ text: "call the api team" });
    act(() => latest.toggle());
    await settle();
    expect(latest.phase).toBe("recording");
    processor.fire(VOICE);
    act(() => latest.toggle());
    await settle();
    expect(latest.phase).toBe("off");
    expect(latest.error).toBeNull();
    expect(inserted).toEqual(["call the api team"]);
    const req = transcribeAudio.mock.calls[0]![0] as {
      audioBase64: string;
      language: string | null;
    };
    expect(req.language).toBeNull();
    // 16 kHz mono PCM16 from 1 s of 48 kHz: 44 + 16 000×2 bytes.
    expect(Math.round((atob(req.audioBase64).length - 44) / 2)).toBe(16_000);
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(closeCalls).toBe(1);
  });

  it("transcribes a remote-owned tab through the local main (#659)", async () => {
    mount(true, INSTANCE);
    transcribeAudio.mockResolvedValue({ text: "dictated across the wire" });
    act(() => latest.toggle());
    await settle();
    processor.fire(VOICE);
    act(() => latest.toggle());
    await settle();
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(remoteInstanceRequest).not.toHaveBeenCalled();
    expect(inserted).toEqual(["dictated across the wire"]);
    expect(latest.phase).toBe("off");
  });

  it("discards a silent take without a provider call", async () => {
    mount(true);
    act(() => latest.toggle());
    await settle();
    processor.fire(SILENCE);
    act(() => latest.toggle());
    await settle();
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(inserted).toEqual([]);
    expect(latest.phase).toBe("off");
    expect(closeCalls).toBe(1);
  });

  it("discards a sub-half-second take", async () => {
    mount(true);
    transcribeAudio.mockResolvedValue({ text: "x" });
    act(() => latest.toggle());
    await settle();
    processor.fire(new Float32Array(4_800).fill(0.2)); // 0.1 s at 48 kHz
    act(() => latest.toggle());
    await settle();
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(latest.phase).toBe("off");
  });

  it("cancel releases the device and never calls the provider", async () => {
    mount(true);
    act(() => latest.toggle());
    await settle();
    processor.fire(VOICE);
    act(() => latest.cancel());
    await settle();
    expect(latest.phase).toBe("off");
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(closeCalls).toBe(1);
  });

  it("cancel during the permission prompt stops the stream on resolve", async () => {
    const gate = Promise.withResolvers<MediaStream>();
    getUserMedia.mockImplementationOnce(() => gate.promise);
    mount(true);
    act(() => latest.toggle());
    expect(latest.phase).toBe("requesting");
    act(() => latest.cancel());
    await act(async () => {
      gate.resolve(fakeStream());
      await Promise.resolve();
    });
    expect(latest.phase).toBe("off");
    expect(stopTrack).toHaveBeenCalledTimes(1);
    // No AudioContext was ever built for a discarded prompt.
    expect(closeCalls).toBe(0);
  });

  it("a release during requesting transcribes once capture opens (#707)", async () => {
    // The quick tap: key up before getUserMedia resolved. `fireOnConnect`
    // hands the pending finish one buffer so the take is real signal.
    fireOnConnect = VOICE;
    mount(true);
    transcribeAudio.mockResolvedValue({ text: "quick tap" });
    act(() => latest.toggle());
    expect(latest.phase).toBe("requesting");
    act(() => latest.stop());
    await settle();
    await settle();
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(inserted).toEqual(["quick tap"]);
    expect(latest.phase).toBe("off");
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it("cancel clears a pending stop (#707)", async () => {
    const gate = Promise.withResolvers<MediaStream>();
    getUserMedia.mockImplementationOnce(() => gate.promise);
    mount(true);
    act(() => latest.toggle());
    act(() => latest.stop());
    expect(latest.phase).toBe("requesting");
    act(() => latest.cancel());
    await act(async () => {
      gate.resolve(fakeStream());
      await Promise.resolve();
    });
    expect(transcribeAudio).not.toHaveBeenCalled();
    expect(latest.phase).toBe("off");
    expect(stopTrack).toHaveBeenCalledTimes(1);
    // The discarded prompt never built an AudioContext.
    expect(closeCalls).toBe(0);
  });

  it("unmount mid-recording tears the device down", async () => {
    mount(true);
    act(() => latest.toggle());
    await settle();
    expect(latest.phase).toBe("recording");
    act(() => root!.unmount());
    root = null;
    await settle();
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(closeCalls).toBe(1);
  });

  it("surfaces a blocked microphone as the privacy hint", async () => {
    const err = new Error("denied") as Error & { name: string };
    err.name = "NotAllowedError";
    getUserMedia.mockRejectedValueOnce(err);
    mount(true);
    act(() => latest.toggle());
    await settle();
    expect(latest.phase).toBe("error");
    expect(latest.error).toContain("OS privacy settings");
    act(() => latest.dismissError());
    expect(latest.phase).toBe("off");
  });

  it("surfaces the provider's message from a failed transcription", async () => {
    mount(true);
    transcribeAudio.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'stt:transcribe': Error: no credential for openai — add it in Settings → Providers",
      ),
    );
    act(() => latest.toggle());
    await settle();
    processor.fire(VOICE);
    act(() => latest.toggle());
    await settle();
    expect(latest.phase).toBe("error");
    expect(latest.error).toBe("no credential for openai — add it in Settings → Providers");
    expect(inserted).toEqual([]);
  });

  it("inserts each phrase while still recording and focuses once after the drain", async () => {
    mount(true);
    transcribeAudio
      .mockResolvedValueOnce({ text: "first phrase" })
      .mockResolvedValueOnce({ text: "second phrase" });
    act(() => latest.toggle());
    await settle();
    processor.fire(VOICE);
    processor.fire(PAUSE);
    await drain();
    expect(transcribeAudio).toHaveBeenCalledTimes(1);
    expect(inserted).toEqual(["first phrase"]);
    expect(latest.phase).toBe("recording");
    expect(stopTrack).not.toHaveBeenCalled();
    expect(focusCalls).toBe(0);
    processor.fire(VOICE);
    act(() => latest.toggle());
    await drain();
    expect(transcribeAudio).toHaveBeenCalledTimes(2);
    expect(inserted).toEqual(["first phrase", "second phrase"]);
    expect(latest.phase).toBe("off");
    expect(focusCalls).toBe(1);
  });

  it("lands phrases in spoken order when replies arrive out of order", async () => {
    const one = Promise.withResolvers<{ text: string }>();
    const two = Promise.withResolvers<{ text: string }>();
    transcribeAudio.mockImplementationOnce(() => one.promise).mockImplementationOnce(() => two.promise);
    mount(true);
    act(() => latest.toggle());
    await settle();
    processor.fire(VOICE);
    processor.fire(PAUSE);
    processor.fire(VOICE);
    processor.fire(PAUSE);
    two.resolve({ text: "two" });
    await drain();
    expect(inserted).toEqual([]);
    one.resolve({ text: "one" });
    await drain();
    expect(inserted).toEqual(["one", "two"]);
  });

  it("cancel keeps inserted phrases and drops replies in flight", async () => {
    const gate = Promise.withResolvers<{ text: string }>();
    transcribeAudio
      .mockResolvedValueOnce({ text: "kept" })
      .mockImplementationOnce(() => gate.promise);
    mount(true);
    act(() => latest.toggle());
    await settle();
    processor.fire(VOICE);
    processor.fire(PAUSE);
    await drain();
    processor.fire(VOICE);
    processor.fire(PAUSE);
    act(() => latest.cancel());
    gate.resolve({ text: "dropped" });
    await drain();
    expect(inserted).toEqual(["kept"]);
    expect(latest.phase).toBe("off");
    expect(focusCalls).toBe(0);
  });

  it("a failed phrase ends the take and drops later replies", async () => {
    const gate = Promise.withResolvers<{ text: string }>();
    transcribeAudio
      .mockImplementationOnce(() => gate.promise)
      .mockResolvedValueOnce({ text: "late" });
    mount(true);
    act(() => latest.toggle());
    await settle();
    processor.fire(VOICE);
    processor.fire(PAUSE);
    processor.fire(VOICE);
    processor.fire(PAUSE);
    gate.reject(new Error("Error invoking remote method 'stt:transcribe': Error: rate limited"));
    await drain();
    expect(latest.phase).toBe("error");
    expect(latest.error).toBe("rate limited");
    expect(inserted).toEqual([]);
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });
});
