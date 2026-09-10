import { describe, expect, it } from "vitest";
import type { BackendTransport } from "./backend-channels";
import { DCH, DESKTOP_CHANNELS, desktopArgCodecs, makeDesktopAdapter } from "./desktop-channels";

describe("DESKTOP_CHANNELS", () => {
  it("declares the 18 client effects on the desktop: namespace with codecs for every inbound member", () => {
    const entries = Object.entries(DESKTOP_CHANNELS);
    expect(entries).toHaveLength(18);
    expect(new Set(entries.map(([, d]) => d.channel)).size).toBe(18);
    for (const [method, d] of entries) {
      expect(d.channel.startsWith("desktop:")).toBe(true);
      expect(Reflect.get(DCH, method)).toBe(d.channel);
      expect(desktopArgCodecs.has(d.channel)).toBe(d.kind !== "event");
    }
    expect(DCH.viewedTab).toBe("desktop:viewedTab");
  });
});

describe("makeDesktopAdapter", () => {
  it("routes a client effect through its declared channel", async () => {
    const requests: Array<{ channel: string; args: unknown[] }> = [];
    const transport: BackendTransport = {
      request<Args extends unknown[], Result>(channel: string, args: Args): Promise<Result> {
        requests.push({ channel, args });
        return Promise.resolve(undefined as Result);
      },
      notify(): void {
        throw new Error("unexpected notify");
      },
      on(): void {
        throw new Error("unexpected on");
      },
    };
    const adapter = makeDesktopAdapter(transport);
    await adapter.openPath("/x");
    expect(requests).toEqual([{ channel: "desktop:openPath", args: ["/x"] }]);
  });
});
