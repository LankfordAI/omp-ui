import { describe, expect, it } from "vitest";
import type { BackendTransport } from "./backend-channels";
import {
  BCH,
  HOST_BOOTSTRAP_CHANNELS,
  hostBootstrapArgCodecs,
  makeHostBootstrap,
} from "./host-bootstrap-channels";

describe("HOST_BOOTSTRAP_CHANNELS", () => {
  it("declares five argless requests and one status event on the bootstrap: namespace", () => {
    const entries = Object.entries(HOST_BOOTSTRAP_CHANNELS);
    expect(entries.map(([m]) => m)).toEqual([
      "connection",
      "retry",
      "status",
      "stop",
      "rollback",
      "onStatus",
    ]);
    for (const [method, d] of entries) {
      expect(d.channel.startsWith("bootstrap:")).toBe(true);
      expect(Reflect.get(BCH, method)).toBe(d.channel);
      if (d.kind !== "event") {
        expect(d.kind).toBe("request");
        expect(hostBootstrapArgCodecs.get(d.channel)).toEqual([]);
      }
    }
    // One string serves both: main answers the `status` invoke and pushes `onStatus` through
    // webContents.send — Electron keeps invoke/handle and send/on apart.
    expect(BCH.status).toBe(BCH.onStatus);
  });
});

describe("makeHostBootstrap", () => {
  it("routes a request through its declared channel and subscribes to status pushes", async () => {
    const requests: string[] = [];
    const subscriptions: string[] = [];
    const transport: BackendTransport = {
      request<Args extends unknown[], Result>(channel: string, args: Args): Promise<Result> {
        expect(args).toEqual([]);
        requests.push(channel);
        return Promise.resolve(undefined as Result);
      },
      notify(): void {
        throw new Error("unexpected notify");
      },
      on(channel: string): void {
        subscriptions.push(channel);
      },
    };
    const bootstrap = makeHostBootstrap(transport);
    await bootstrap.connection();
    await bootstrap.retry();
    bootstrap.onStatus(() => {});
    expect(requests).toEqual(["bootstrap:connection", "bootstrap:retry"]);
    expect(subscriptions).toEqual(["bootstrap:status"]);
  });
});
