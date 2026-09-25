// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { backendState } from "../test/fixtures";
import type { Dictation } from "./use-dictation";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TAB = "tab-voice";
const transcribeAudio = vi.fn();
Object.assign(window, {
  ompBackend: { transcribeAudio: (req: unknown) => transcribeAudio(req) },
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
  connect = vi.fn();
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
let closeCalls: number;
let stopTrack: ReturnType<typeof vi.fn>;

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

function Probe(): null {
  latest = useDictation(TAB, (text) => inserted.push(text));
  return null;
}

function mount(voiceInputEnabled: boolean): void {
  useStore.setState({
    state: backendState({
      voiceInputEnabled,
      projects: [
        {
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
        },
      ],
    }),
  });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<Probe />));
}

/** 1 s of fake signal at 48 kHz: downsamples past the ½ s provider guard. */
const VOICE = new Float32Array(48_000).fill(0.2);
const SILENCE = new Float32Array(48_000).fill(0);

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  closeCalls = 0;
  stopTrack = vi.fn();
  inserted.length = 0;
  transcribeAudio.mockReset();
  getUserMedia = vi.fn(async () => fakeStream());
  vi.stubGlobal("AudioContext", AudioContextStub);
  vi.stubGlobal("webkitAudioContext", AudioContextStub);
  Object.defineProperty(navigator, "mediaDevices", {
    value: { getUserMedia },
    configurable: true,
  });
  // rAF drives the 60 s cap tick; tests never let it run.
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
});
