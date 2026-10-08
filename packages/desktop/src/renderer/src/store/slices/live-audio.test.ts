// #809: connection-scoped recording identity. The reference the load
// dispatches must carry BOTH the session and the connection the turns belong
// to, so a turn number reused by a later connection cannot collide; and with
// no session or no local live start, the load answers `unavailable` without
// dispatching anything.
import { beforeEach, describe, expect, it } from "vitest";
import { formatLiveAudioRef, type LiveSnapshot } from "@omp-ui/core/live-voice";
import type { CapabilitySnapshot } from "@omp-ui/core/capabilities";
import { rpcTabState } from "../../test/fixtures";
import { h } from "../../test/store-harness";
import { emptySessionRuntime } from "../../lib/rpc-types";

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