import * as net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { endpointAddress, probeTcp, resolveModelHold } from "./model-hold";

const servers: net.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function listen(): Promise<number> {
  const server = net.createServer((socket) => socket.destroy());
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
  });
}

describe("endpointAddress", () => {
  it("defaults the port by scheme and unbrackets IPv6", () => {
    expect(endpointAddress("http://192.168.110.6:4000/v1")).toEqual({ host: "192.168.110.6", port: 4000 });
    expect(endpointAddress("https://gateway.example/v1")).toEqual({ host: "gateway.example", port: 443 });
    expect(endpointAddress("http://[::1]/v1")).toEqual({ host: "::1", port: 80 });
  });

  it("is null for anything that is not an http(s) URL", () => {
    expect(endpointAddress("not a url")).toBeNull();
    expect(endpointAddress("unix:///tmp/sock")).toBeNull();
  });
});

describe("probeTcp", () => {
  it("is true for a listening port and false for a closed one", async () => {
    const open = await listen();
    expect(await probeTcp("127.0.0.1", open, 1000)).toBe(true);
    // A port that was just freed refuses the connection.
    const closed = await listen();
    await new Promise((resolve) => servers.pop()!.close(resolve));
    expect(await probeTcp("127.0.0.1", closed, 1000)).toBe(false);
  });
});

describe("resolveModelHold", () => {
  const baseUrls: Record<string, string> = { litellm: "http://192.168.110.6:4000/v1" };
  const baseUrlFor = (id: string): string | null => baseUrls[id] ?? null;

  it("holds a model whose models.yml endpoint does not answer", async () => {
    const probed: string[] = [];
    const hold = await resolveModelHold("litellm/Qwen3.8-Flash-Next", {
      baseUrlFor,
      probe: async (host, port) => {
        probed.push(`${host}:${port}`);
        return false;
      },
    });
    expect(probed).toEqual(["192.168.110.6:4000"]);
    expect(hold).toEqual({
      model: "litellm/Qwen3.8-Flash-Next",
      provider: "litellm",
      endpoint: "192.168.110.6:4000",
    });
  });

  it("does not hold when the endpoint answers", async () => {
    expect(await resolveModelHold("litellm/Qwen", { baseUrlFor, probe: async () => true })).toBeNull();
  });

  it("never probes a provider with no models.yml endpoint", async () => {
    let probed = false;
    const probe = async (): Promise<boolean> => {
      probed = true;
      return false;
    };
    expect(await resolveModelHold("openrouter/openai/gpt-5.5", { baseUrlFor, probe })).toBeNull();
    expect(await resolveModelHold("no-provider", { baseUrlFor, probe })).toBeNull();
    expect(probed).toBe(false);
  });
});
