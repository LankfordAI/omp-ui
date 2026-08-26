import { describe, expect, expectTypeOf, it } from "vitest";
import {
  BACKEND_CHANNELS,
  CH,
  dispatchNotify,
  dispatchRequest,
  makeBackendClient,
  type BackendChannelSpec,
  type BackendTransport,
  type ChannelTable,
  type OmpBackend,
} from "./backend-channels";
import type { MemoryListOptions, MemoryPage, MemoryScope } from "./types";

type SpecChannel<Kind extends BackendChannelSpec[keyof BackendChannelSpec]["kind"]> = {
  [Method in keyof BackendChannelSpec]: BackendChannelSpec[Method]["kind"] extends Kind
    ? BackendChannelSpec[Method]["channel"]
    : never;
}[keyof BackendChannelSpec];

type RuntimeListener = (...args: never[]) => void;

function recordingTransport() {
  const requests: Array<{ channel: string; args: unknown[] }> = [];
  const notifications: Array<{ channel: string; args: unknown[] }> = [];
  const listeners = new Map<string, RuntimeListener>();

  const transport: BackendTransport = {
    request<Args extends unknown[], Result>(channel: string, args: Args): Promise<Result> {
      requests.push({ channel, args });
      return Promise.resolve({ channel, args }) as never;
    },
    notify<Args extends unknown[]>(channel: string, args: Args): void {
      notifications.push({ channel, args });
    },
    on<Args extends unknown[]>(channel: string, cb: (...args: Args) => void): void {
      listeners.set(channel, cb as unknown as RuntimeListener);
    },
  };

  return { transport, requests, notifications, listeners };
}

describe("BACKEND_CHANNELS", () => {
  it("derives same-keyed CH values and keeps every wire string unique", () => {
    const specEntries = Object.entries(BACKEND_CHANNELS);
    const channelStrings = specEntries.map(([, descriptor]) => descriptor.channel);

    expect(Object.keys(CH)).toEqual(specEntries.map(([method]) => method));
    expect(Object.values(CH)).toEqual(channelStrings);
    expect(new Set(channelStrings).size).toBe(channelStrings.length);
  });

  it("derives the complete public client and non-event handler table", () => {
    type Method = keyof BackendChannelSpec;
    type HandledChannel = keyof ChannelTable["request"] | keyof ChannelTable["notify"];

    expectTypeOf<keyof OmpBackend>().toEqualTypeOf<Method>();
    expectTypeOf<keyof typeof CH>().toEqualTypeOf<Method>();
    expectTypeOf<keyof ChannelTable["request"]>().toEqualTypeOf<SpecChannel<"request">>();
    expectTypeOf<keyof ChannelTable["notify"]>().toEqualTypeOf<SpecChannel<"notify">>();
    expectTypeOf<HandledChannel>().toEqualTypeOf<
      SpecChannel<"request"> | SpecChannel<"notify">
    >();
    expectTypeOf<Extract<HandledChannel, SpecChannel<"event">>>().toEqualTypeOf<never>();
    expectTypeOf<ChannelTable["request"]["project:move"]>().toEqualTypeOf<
      (projectPath: string, beforePath: string | null) => void | Promise<void>
    >();
    expectTypeOf<ChannelTable["request"]["project:open"]>().toEqualTypeOf<
      (projectPath: string, target: "vscode" | "files") => void | Promise<void>
    >();
    expectTypeOf<ChannelTable["request"]["memory:list"]>().toEqualTypeOf<
      (
        projectCwd: string,
        scope: MemoryScope,
        opts: MemoryListOptions,
      ) => MemoryPage | Promise<MemoryPage>
    >();
    expectTypeOf<ChannelTable["notify"]["pty:resize"]>().toEqualTypeOf<
      (tabId: string, cols: number, rows: number) => void
    >();
  });
});

describe("makeBackendClient", () => {
  it("routes every request and preserves its tuple args", async () => {
    const recorded = recordingTransport();
    const client = makeBackendClient(recorded.transport);
    const expected: Array<{ channel: string; args: unknown[] }> = [];

    for (const [method, descriptor] of Object.entries(BACKEND_CHANNELS)) {
      if (descriptor.kind !== "request") continue;
      const args = [method, { channel: descriptor.channel }];
      const invoke = Reflect.get(client, method) as (...args: never[]) => Promise<unknown>;
      const result = await invoke(...(args as never[]));
      expected.push({ channel: descriptor.channel, args });
      expect(result).toEqual({ channel: descriptor.channel, args });
    }

    expect(recorded.requests).toEqual(expected);
    expect(recorded.notifications).toEqual([]);
  });

  it("routes every notification and preserves its tuple args", () => {
    const recorded = recordingTransport();
    const client = makeBackendClient(recorded.transport);
    const expected: Array<{ channel: string; args: unknown[] }> = [];

    for (const [method, descriptor] of Object.entries(BACKEND_CHANNELS)) {
      if (descriptor.kind !== "notify") continue;
      const args = [method, { channel: descriptor.channel }];
      const invoke = Reflect.get(client, method) as (...args: never[]) => void;
      invoke(...(args as never[]));
      expected.push({ channel: descriptor.channel, args });
    }

    expect(recorded.notifications).toEqual(expected);
    expect(recorded.requests).toEqual([]);
  });

  it("registers every event on its channel and forwards tuple args unchanged", () => {
    const recorded = recordingTransport();
    const client = makeBackendClient(recorded.transport);
    const received: Array<{ method: string; args: unknown[] }> = [];

    for (const [method, descriptor] of Object.entries(BACKEND_CHANNELS)) {
      if (descriptor.kind !== "event") continue;
      const subscribe = Reflect.get(client, method) as (...args: never[]) => void;
      const cb = (...args: unknown[]): void => {
        received.push({ method, args });
      };
      subscribe(cb as never);

      const args = [method, new Uint8Array([method.length])];
      const listener = recorded.listeners.get(descriptor.channel);
      expect(listener).toBe(cb);
      listener?.(...(args as never[]));
    }

    const expected = Object.entries(BACKEND_CHANNELS)
      .filter(([, descriptor]) => descriptor.kind === "event")
      .map(([method]) => ({ method, args: [method, new Uint8Array([method.length])] }));
    expect(received).toEqual(expected);
  });

  it("exposes tuple-typed methods for each routing mode", async () => {
    const recorded = recordingTransport();
    const client = makeBackendClient(recorded.transport);
    const onData = (...args: [tabId: string, data: Uint8Array]): void => {
      void args;
    };

    await client.moveProject("/project/a", null);
    await client.openProject("/project/a", "files");
    await client.setSessionAdvisor("tab-1", true, "openrouter/a/b:low");
    client.ptyResize("tab-1", 120, 40);
    client.onPtyData(onData);

    expect(recorded.requests.at(-3)).toEqual({
      channel: "project:move",
      args: ["/project/a", null],
    });
    expect(recorded.requests.at(-2)).toEqual({
      channel: "project:open",
      args: ["/project/a", "files"],
    });
    expect(recorded.requests.at(-1)).toEqual({
      channel: "session:setAdvisor",
      args: ["tab-1", true, "openrouter/a/b:low"],
    });
    expect(recorded.notifications.at(-1)).toEqual({
      channel: "pty:resize",
      args: ["tab-1", 120, 40],
    });
    expect(recorded.listeners.get("pty:data")).toBe(onData);
  });
});

describe("transport dispatch (issue #301)", () => {
  const noteCalls: unknown[][] = [];
  const table = {
    request: {
      "echo:sync": (a: unknown, b: unknown) => [a, b],
      "echo:async": async (v: unknown) => `async:${v}`,
      "boom:sync": () => {
        throw new Error("sync-throw");
      },
      "boom:async": async () => {
        throw new Error("async-reject");
      },
    },
    notify: {
      note: (a: unknown, b: unknown) => {
        noteCalls.push([a, b]);
      },
      "note:boom": () => {
        throw new Error("notify-throw");
      },
    },
  } as unknown as ChannelTable;

  it("dispatchRequest resolves handler values and passes args in order", async () => {
    await expect(dispatchRequest(table, "echo:sync", [1, "two"])).resolves.toEqual([1, "two"]);
    await expect(dispatchRequest(table, "echo:async", ["v"])).resolves.toBe("async:v");
  });

  it("dispatchRequest rejects unknown channels by name", async () => {
    await expect(dispatchRequest(table, "nope:nope", [])).rejects.toThrow(
      "unknown channel nope:nope",
    );
  });

  it("dispatchRequest rejects with the handler's own error", async () => {
    await expect(dispatchRequest(table, "boom:sync", [])).rejects.toThrow("sync-throw");
    await expect(dispatchRequest(table, "boom:async", [])).rejects.toThrow("async-reject");
  });

  it("dispatchNotify invokes with args, ignores unknown channels, swallows throws", () => {
    dispatchNotify(table, "note", ["x", 1]);
    expect(noteCalls).toEqual([["x", 1]]);
    expect(() => dispatchNotify(table, "nope:nope", [])).not.toThrow();
    expect(() => dispatchNotify(table, "note:boom", [])).not.toThrow();
  });
});
