// #809: connection-scoped recording identity. The reference the load
// dispatches must carry BOTH the session and the connection the turns belong
// to, so a turn number reused by a later connection cannot collide; and with
// no session or no local live start, the load answers `unavailable` without
// dispatching anything.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { formatLiveAudioRef, type LiveHistoryEntry, type LiveSnapshot } from "@omp-ui/core/live-voice";
import type { CapabilitySnapshot } from "@omp-ui/core/capabilities";
import { rpcTabState } from "../../test/fixtures";
import { h } from "../../test/store-harness";
import { emptySessionRuntime } from "../../lib/rpc-types";
import { installLiveReplayGuards } from "./live-audio";

const TAB = "tab-809";
const SESSION = "01890a2b-3c4d-7e5f-8a1b-2c3d4e5f6a7b";
const CONNECTION = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const snap = (patch: Partial<LiveSnapshot> = {}): LiveSnapshot => ({
  phase: "listening",
  levels: null,
  turns: [],
  ended: false,
  error: null,
  connectionId: null,
  ...patch,
});

const CAPS = {
  capabilities: { ompVersion: "18.8.6" } as unknown as CapabilitySnapshot,
};

function seed(
  patch: Partial<LiveSnapshot> = {},
  sessionId: string | null = SESSION,
  extra: Record<string, unknown> = {},
): void {
  h.useStore.setState({
    rpc: {
      [TAB]: rpcTabState({
        session: { ...emptySessionRuntime(), sessionId },
        live: snap(patch),
        ...extra,
      }),
    },
  });
}

beforeEach(() => {
  h.mockBackend.readLiveAudio.mockReset();
  h.mockBackend.readLiveAudio.mockResolvedValue({ status: "unavailable" });
  h.backendState = h.stateWithRecord("sess-1");
  h.sent.length = 0;
});

describe("loadLiveRecording (#809)", () => {
  it("builds the ref from the session AND the snapshot's connection", async () => {
    seed({ connectionId: CONNECTION });
    await h.useStore
      .getState()
      .loadLiveRecording(TAB, { role: "assistant", turn: 2, text: "hi", final: true });
    expect(h.mockBackend.readLiveAudio).toHaveBeenCalledWith(
      TAB,
      `v1/${SESSION}/${CONNECTION}/assistant/2`,
    );
  });

  it("answers unavailable without dispatching when the session never materialized", async () => {
    seed({ connectionId: CONNECTION }, null);
    const load = await h.useStore
      .getState()
      .loadLiveRecording(TAB, { role: "assistant", turn: 0, text: "hi", final: true });
    expect(load.status).toBe("unavailable");
    expect(h.mockBackend.readLiveAudio).not.toHaveBeenCalled();
  });

  it("answers unavailable without dispatching before any local live start", async () => {
    seed({ connectionId: null });
    const load = await h.useStore
      .getState()
      .loadLiveRecording(TAB, { role: "assistant", turn: 0, text: "hi", final: true });
    expect(load.status).toBe("unavailable");
    expect(h.mockBackend.readLiveAudio).not.toHaveBeenCalled();
  });

  it("keeps the connection across stop so history still resolves", async () => {
    seed({ connectionId: CONNECTION, ended: true, phase: null });
    await h.useStore
      .getState()
      .loadLiveRecording(TAB, { role: "user", turn: 1, text: "hey", final: true });
    expect(h.mockBackend.readLiveAudio).toHaveBeenCalledWith(
      TAB,
      `v1/${SESSION}/${CONNECTION}/user/1`,
    );
  });
});

describe("startLiveVoice connection identity (#809)", () => {
  // The running-session guard refuses a second live_start; an ended
  // snapshot is the lawful precondition for a fresh start.
  const start = async (): Promise<void> => {
    seed({ ended: true }, SESSION, CAPS);
    const promise = h.useStore.getState().startLiveVoice(TAB);
    for (const { tabId, cmd } of [...h.sent]) h.respond(tabId, cmd, { voice: "ash" }, true);
    await promise;
  };

  const connectionOf = (): string | null =>
    h.useStore.getState().rpc[TAB]?.live?.connectionId ?? null;

  it("mints a fresh UUID connectionId on a successful start", async () => {
    await start();
    const id = connectionOf();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("two connections mint distinct ids so the same turn number resolves apart", async () => {
    await start();
    const first = connectionOf();
    await start();
    const second = connectionOf();
    expect(second).not.toBe(first);
    const ref = (connectionId: string): string =>
      formatLiveAudioRef({ sessionId: SESSION, connectionId, role: "assistant", turn: 2 });
    expect(ref(first as string)).not.toBe(ref(second as string));
  });

  it("a failed start leaves no connection id", async () => {
    seed({ ended: true }, SESSION, CAPS);
    const promise = h.useStore.getState().startLiveVoice(TAB);
    for (const { tabId, cmd } of [...h.sent]) h.respond(tabId, cmd, {}, false);
    await promise;
    expect(connectionOf()).toBeNull();
  });
});

describe("listLiveRecordings (#809)", () => {
  it("relays the confined listing", async () => {
    h.mockBackend.listLiveAudio.mockResolvedValueOnce([]);
    expect(await h.useStore.getState().listLiveRecordings(TAB)).toEqual([]);
    expect(h.mockBackend.listLiveAudio).toHaveBeenCalledWith(TAB);
  });
});

// #810: the replay machine. Bytes reach the player through the confined
// read channel and a data URI on one module-level Audio singleton; the
// guards pause on tab leave and on live output speaking; nothing here ever
// dispatches a live command, so #811's pending state and the sidebar glyph
// cannot see replay (AC 5).
class AudioStub {
  static instances: AudioStub[] = [];
  static playMode: "ok" | "reject" = "ok";
  src = "";
  onended: (() => void) | null = null;
  readonly pauseCalls: number[] = [];
  readonly playCalls: number[] = [];
  constructor() {
    AudioStub.instances.push(this);
  }
  play(): Promise<void> {
    this.playCalls.push(1);
    return AudioStub.playMode === "reject" ? Promise.reject(new Error("autoplay")) : Promise.resolve();
  }
  pause(): void {
    this.pauseCalls.push(1);
  }
}
// The slice's module-level singleton outlives the tests in this file: the
// constructor runs once, ever. Assertions read `lastAudio()` (the singleton)
// and never assume a per-test construction.
const lastAudio = (): AudioStub | undefined => AudioStub.instances.at(-1);

const READY = { status: "ready", wavBase64: "AAAA" } as const;

describe("playLiveRecording (#810)", () => {
  beforeEach(() => {
    AudioStub.playMode = "ok";
    vi.stubGlobal("Audio", AudioStub);
    // Silence between tests: slot null, singleton src empty.
    h.useStore.getState().stopLiveReplay();
  });

  it("plays an entry target after a reopen with no live snapshot at all", async () => {
    h.mockBackend.readLiveAudio.mockResolvedValue(READY);
    seed({}, SESSION);
    // Reopen truth: the boot reset cleared `live` entirely (AC 2).
    h.useStore.setState((s) => ({ rpc: { [TAB]: { ...s.rpc[TAB], live: null } } }));
    await h.useStore
      .getState()
      .playLiveRecording(TAB, {
        kind: "entry",
        entry: { connectionId: CONNECTION, role: "assistant", turn: 3, sizeBytes: 9, modifiedAt: "t" },
      });
    expect(h.mockBackend.readLiveAudio).toHaveBeenCalledWith(
      TAB,
      `v1/${SESSION}/${CONNECTION}/assistant/3`,
    );
    expect(h.useStore.getState().liveReplay).toMatchObject({
      key: `${TAB}:${CONNECTION}:3`,
      tabId: TAB,
      status: "playing",
      notice: null,
    });
    expect(lastAudio()?.src).toBe("data:audio/wav;base64,AAAA");
    // AC 5: no command dispatch of any kind rides replay.
    expect(h.sent).toHaveLength(0);
  });

  it("plays a turn target from the snapshot's connection", async () => {
    h.mockBackend.readLiveAudio.mockResolvedValue(READY);
    seed({ connectionId: CONNECTION });
    await h.useStore
      .getState()
      .playLiveRecording(TAB, {
        kind: "turn",
        turn: { role: "assistant", turn: 2, text: "hi", final: true },
      });
    expect(h.mockBackend.readLiveAudio).toHaveBeenCalledWith(
      TAB,
      `v1/${SESSION}/${CONNECTION}/assistant/2`,
    );
    expect(h.useStore.getState().liveReplay?.status).toBe("playing");
  });

  it("answers unavailable mid-race by clearing the slot, never the fallback", async () => {
    // The beforeEach's stop blanked the singleton; an unavailable answer
    // must leave it blank — no fabricated bytes ever reach the element
    // (AC 6) — and clear the loading slot.
    seed({ connectionId: CONNECTION });
    await h.useStore
      .getState()
      .playLiveRecording(TAB, {
        kind: "entry",
        entry: { connectionId: CONNECTION, role: "assistant", turn: 0, sizeBytes: 9, modifiedAt: "t" },
      });
    expect(h.useStore.getState().liveReplay).toBeNull();
    expect(lastAudio()?.src ?? "").toBe("");
  });

  it("a turn target without a local connection dispatches nothing", async () => {
    seed({ connectionId: null });
    await h.useStore
      .getState()
      .playLiveRecording(TAB, {
        kind: "turn",
        turn: { role: "assistant", turn: 0, text: "hi", final: true },
      });
    expect(h.mockBackend.readLiveAudio).not.toHaveBeenCalled();
    expect(h.useStore.getState().liveReplay).toBeNull();
  });

  it("refuses while live output is speaking, with no state change", async () => {
    seed({ connectionId: CONNECTION, phase: "speaking" });
    await h.useStore
      .getState()
      .playLiveRecording(TAB, {
        kind: "entry",
        entry: { connectionId: CONNECTION, role: "assistant", turn: 1, sizeBytes: 9, modifiedAt: "t" },
      });
    expect(h.mockBackend.readLiveAudio).not.toHaveBeenCalled();
    expect(h.useStore.getState().liveReplay).toBeNull();
  });

  it("a superseded play's continuation is discarded", async () => {
    const slow = h.deferred<{ status: "ready"; wavBase64: string }>();
    h.mockBackend.readLiveAudio
      .mockImplementationOnce(() => slow.promise)
      .mockResolvedValueOnce(READY);
    seed({ connectionId: CONNECTION });
    const first = h.useStore
      .getState()
      .playLiveRecording(TAB, {
        kind: "turn",
        turn: { role: "assistant", turn: 1, text: "a", final: true },
      });
    await h.useStore
      .getState()
      .playLiveRecording(TAB, {
        kind: "turn",
        turn: { role: "assistant", turn: 2, text: "b", final: true },
      });
    slow.resolve({ status: "ready", wavBase64: "VVVV" });
    await first;
    const state = h.useStore.getState();
    expect(state.liveReplay?.key).toBe(`${TAB}:${CONNECTION}:2`);
    expect(state.liveReplay?.status).toBe("playing");
  });

  it("a second play replaces the first clip on the one singleton", async () => {
    h.mockBackend.readLiveAudio.mockResolvedValue(READY);
    seed({ connectionId: CONNECTION });
    await h.useStore
      .getState()
      .playLiveRecording(TAB, {
        kind: "turn",
        turn: { role: "assistant", turn: 1, text: "a", final: true },
      });
    h.mockBackend.readLiveAudio.mockResolvedValueOnce({ status: "ready", wavBase64: "QkJC" });
    await h.useStore
      .getState()
      .playLiveRecording(TAB, {
        kind: "turn",
        turn: { role: "assistant", turn: 2, text: "b", final: true },
      });
    expect(AudioStub.instances).toHaveLength(1);
    expect(lastAudio()?.src).toBe("data:audio/wav;base64,QkJC");
  });

  it("pause stops the element; resume replays and clears the notice", async () => {
    h.mockBackend.readLiveAudio.mockResolvedValue(READY);
    seed({ connectionId: CONNECTION });
    await h.useStore
      .getState()
      .playLiveRecording(TAB, {
        kind: "turn",
        turn: { role: "assistant", turn: 1, text: "a", final: true },
      });
    h.useStore.getState().pauseLiveReplay();
    expect(h.useStore.getState().liveReplay?.status).toBe("paused");
    expect((lastAudio()?.pauseCalls.length ?? 0)).toBeGreaterThan(0);
    h.useStore.setState((s) => ({ liveReplay: { ...s.liveReplay!, notice: "live-speaking" } }));
    h.useStore.getState().resumeLiveReplay();
    await h.flushMicrotasks();
    expect(h.useStore.getState().liveReplay).toMatchObject({ status: "playing", notice: null });
  });

  it("a rejected play leaves the clip paused with Resume available", async () => {
    AudioStub.playMode = "reject";
    h.mockBackend.readLiveAudio.mockResolvedValue(READY);
    seed({ connectionId: CONNECTION });
    await h.useStore
      .getState()
      .playLiveRecording(TAB, {
        kind: "turn",
        turn: { role: "assistant", turn: 1, text: "a", final: true },
      });
    expect(h.useStore.getState().liveReplay?.status).toBe("paused");
    AudioStub.playMode = "ok";
    h.useStore.getState().resumeLiveReplay();
    await h.flushMicrotasks();
    expect(h.useStore.getState().liveReplay?.status).toBe("playing");
  });

  it("stop clears the slot and silences the element", async () => {
    h.mockBackend.readLiveAudio.mockResolvedValue(READY);
    seed({ connectionId: CONNECTION });
    await h.useStore
      .getState()
      .playLiveRecording(TAB, {
        kind: "turn",
        turn: { role: "assistant", turn: 1, text: "a", final: true },
      });
    h.useStore.getState().stopLiveReplay();
    expect(h.useStore.getState().liveReplay).toBeNull();
    expect(lastAudio()?.src).toBe("");
  });
});

describe("installLiveReplayGuards (#810)", () => {
  beforeEach(() => {
    AudioStub.playMode = "ok";
    vi.stubGlobal("Audio", AudioStub);
    h.useStore.getState().stopLiveReplay();
    // Idempotent by WeakSet: installed once, live for the rest of the file.
    installLiveReplayGuards(h.useStore);
  });

  const playTurn = async (): Promise<void> => {
    h.mockBackend.readLiveAudio.mockResolvedValue(READY);
    seed({ connectionId: CONNECTION });
    await h.useStore
      .getState()
      .playLiveRecording(TAB, {
        kind: "turn",
        turn: { role: "assistant", turn: 1, text: "a", final: true },
      });
    h.useStore.setState({ activeTabId: TAB });
    expect(h.useStore.getState().liveReplay?.status).toBe("playing");
  };

  it("leaving the tab pauses; returning never resumes (AC 3)", async () => {
    await playTurn();
    h.useStore.setState({ activeTabId: "other-tab" });
    expect(h.useStore.getState().liveReplay?.status).toBe("paused");
    expect(h.useStore.getState().liveReplay?.notice).toBeNull();
    h.useStore.setState({ activeTabId: TAB });
    expect(h.useStore.getState().liveReplay?.status).toBe("paused");
  });

  it("live output speaking mid-clip pauses with the reason (AC 4)", async () => {
    await playTurn();
    h.useStore.setState((s) => ({
      rpc: {
        [TAB]: {
          ...s.rpc[TAB],
          live: { ...s.rpc[TAB].live!, phase: "speaking" },
        },
      },
    }));
    expect(h.useStore.getState().liveReplay).toMatchObject({
      status: "paused",
      notice: "live-speaking",
    });
    expect((lastAudio()?.pauseCalls.length ?? 0)).toBeGreaterThan(0);
  });

  it("a clip that ended on its own clears the slot", async () => {
    h.mockBackend.readLiveAudio.mockResolvedValue(READY);
    seed({ connectionId: CONNECTION });
    await h.useStore
      .getState()
      .playLiveRecording(TAB, {
        kind: "turn",
        turn: { role: "assistant", turn: 1, text: "a", final: true },
      });
    lastAudio()?.onended?.();
    expect(h.useStore.getState().liveReplay).toBeNull();
  });
});

// #817: the history channel verbs. Append dispatches only finals under a
// real connection id and swallows channel failures — the snapshot already
// rendered the text. Read relays the confined listing; a rejected read
// answers empty, never an error boundary. A row's explicit connectionId
// overrides the snapshot's: a history row probes its own connection's take.
describe("appendLiveHistory / listLiveHistory (#817)", () => {
  beforeEach(() => {
    h.mockBackend.liveTranscriptAppend.mockReset();
    h.mockBackend.liveTranscriptAppend.mockResolvedValue(undefined);
    h.mockBackend.liveTranscriptRead.mockReset();
    h.mockBackend.liveTranscriptRead.mockResolvedValue([]);
  });

  it("appends a final under the connection with the entry payload", async () => {
    await h.useStore
      .getState()
      .appendLiveHistory(TAB, CONNECTION, { role: "assistant", turn: 2, text: "hi", final: true });
    expect(h.mockBackend.liveTranscriptAppend).toHaveBeenCalledWith(TAB, CONNECTION, {
      role: "assistant",
      turn: 2,
      text: "hi",
    });
  });

  it("a non-final dispatches nothing", async () => {
    await h.useStore
      .getState()
      .appendLiveHistory(TAB, CONNECTION, { role: "assistant", turn: 2, text: "hi", final: false });
    expect(h.mockBackend.liveTranscriptAppend).not.toHaveBeenCalled();
  });

  it("an un-minted connection id dispatches nothing", async () => {
    await h.useStore
      .getState()
      .appendLiveHistory(TAB, "c-not-a-uuid", { role: "user", turn: 0, text: "hi", final: true });
    expect(h.mockBackend.liveTranscriptAppend).not.toHaveBeenCalled();
  });

  it("a channel rejection is swallowed", async () => {
    h.mockBackend.liveTranscriptAppend.mockRejectedValue(new Error("disk full"));
    await expect(
      h.useStore
        .getState()
        .appendLiveHistory(TAB, CONNECTION, { role: "user", turn: 0, text: "hi", final: true }),
    ).resolves.toBeUndefined();
  });

  it("listLiveHistory relays the confined read", async () => {
    const entries: LiveHistoryEntry[] = [{ connectionId: CONNECTION, role: "user", turn: 0, text: "hi" }];
    h.mockBackend.liveTranscriptRead.mockResolvedValueOnce(entries);
    expect(await h.useStore.getState().listLiveHistory(TAB)).toEqual(entries);
    expect(h.mockBackend.liveTranscriptRead).toHaveBeenCalledWith(TAB);
  });

  it("a rejected read answers empty", async () => {
    h.mockBackend.liveTranscriptRead.mockRejectedValueOnce(new Error("ipc down"));
    expect(await h.useStore.getState().listLiveHistory(TAB)).toEqual([]);
  });
});

describe("explicit connectionId overrides (#817)", () => {
  it("loadLiveRecording builds the ref from the explicit connection", async () => {
    seed({ connectionId: CONNECTION });
    const other = "9e2504e0-4f89-41d3-9a0c-0305e82c3309";
    await h.useStore
      .getState()
      .loadLiveRecording(TAB, { role: "assistant", turn: 4, text: "old", final: true }, other);
    expect(h.mockBackend.readLiveAudio).toHaveBeenCalledWith(
      TAB,
      `v1/${SESSION}/${other}/assistant/4`,
    );
  });

  it("a turn target's connectionId wins over the snapshot's", async () => {
    h.mockBackend.readLiveAudio.mockResolvedValue(READY);
    seed({ connectionId: CONNECTION });
    const other = "9e2504e0-4f89-41d3-9a0c-0305e82c3309";
    await h.useStore
      .getState()
      .playLiveRecording(TAB, {
        kind: "turn",
        turn: { role: "assistant", turn: 4, text: "old", final: true },
        connectionId: other,
      });
    expect(h.mockBackend.readLiveAudio).toHaveBeenCalledWith(
      TAB,
      `v1/${SESSION}/${other}/assistant/4`,
    );
    expect(h.useStore.getState().liveReplay?.key).toBe(`${TAB}:${other}:4`);
  });
});