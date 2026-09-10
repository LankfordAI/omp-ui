import { describe, expect, it } from "vitest";
import {
  HOST_PROTOCOL,
  HOST_PROTOCOL_RANGE,
  makeClientHello,
  makeServerEventFrame,
  makeServerHello,
  makeServerResponseErr,
  makeServerResponseOk,
  parseClientFrame,
  parseClientHello,
  parseServerFrame,
  parseServerHello,
} from "./protocol";

describe("parseClientFrame", () => {
  it("normalizes a well-formed req with and without args", () => {
    expect(parseClientFrame({ t: "req", id: 1, ch: "state:get", args: [] })).toEqual({
      t: "req",
      id: 1,
      ch: "state:get",
      args: [],
    });
    expect(parseClientFrame({ t: "req", id: 2, ch: "state:get" })).toEqual({
      t: "req",
      id: 2,
      ch: "state:get",
      args: [],
    });
  });

  it("accepts a notify frame", () => {
    expect(parseClientFrame({ t: "notify", ch: "pty:write", args: ["tab", "x"] })).toEqual({
      t: "notify",
      ch: "pty:write",
      args: ["tab", "x"],
    });
  });

  it("drops everything else", () => {
    const bad: unknown[] = [
      null,
      42,
      "str",
      [1, 2, 3],
      {},
      { t: "req" }, // no ch
      { t: "req", id: 1, ch: 7 }, // ch not a string
      { t: "req", id: "1", ch: "state:get" }, // id not a number
      { t: "ev", ch: "state:get" }, // unknown t
      { t: "req", id: 1, ch: "state:get", args: "no" }, // args present but not an array
    ];
    for (const frame of bad) {
      expect(parseClientFrame(frame), JSON.stringify(frame)).toBeNull();
    }
  });
});

describe("parseServerFrame", () => {
  it("normalizes well-formed res frames both ways", () => {
    expect(parseServerFrame({ t: "res", id: 1, ok: true, value: { a: 1 } })).toEqual({
      t: "res",
      id: 1,
      ok: true,
      value: { a: 1 },
    });
    expect(parseServerFrame({ t: "res", id: 2, ok: false, message: "boom" })).toEqual({
      t: "res",
      id: 2,
      ok: false,
      message: "boom",
    });
    // A present-but-wrong `ok` is the error arm; a missing message still
    // serializes as an error the client can surface.
    expect(parseServerFrame({ t: "res", id: 3, ok: "yes" })).toEqual({
      t: "res",
      id: 3,
      ok: false,
      message: "remote call failed",
    });
  });

  it("normalizes an event with args absent or malformed to an empty tuple", () => {
    expect(parseServerFrame({ t: "ev", ch: "pty:data", args: ["t", 1] })).toEqual({
      t: "ev",
      ch: "pty:data",
      args: ["t", 1],
    });
    expect(parseServerFrame({ t: "ev", ch: "onX" })).toEqual({ t: "ev", ch: "onX", args: [] });
    expect(parseServerFrame({ t: "ev", ch: "onX", args: "no" })).toEqual({
      t: "ev",
      ch: "onX",
      args: [],
    });
  });

  it("drops everything else, never throws", () => {
    const bad: unknown[] = [
      null,
      42,
      "str",
      [1, 2],
      {},
      { t: "res" }, // no id
      { t: "res", id: "1", ok: true }, // id not a number
      { t: "ev" }, // ch not a string
      { t: "other", id: 1 },
    ];
    for (const frame of bad) {
      expect(parseServerFrame(frame), JSON.stringify(frame)).toBeNull();
    }
  });

  it("builders round-trip through the parser", () => {
    expect(parseServerFrame(makeServerResponseOk(1, undefined))).toEqual({
      t: "res",
      id: 1,
      ok: true,
      value: null,
    });
    expect(parseServerFrame(makeServerResponseErr(2, "x"))).toEqual({
      t: "res",
      id: 2,
      ok: false,
      message: "x",
    });
    expect(parseServerFrame(makeServerEventFrame("onX", []))).toEqual({
      t: "ev",
      ch: "onX",
      args: [],
    });
  });
});

const CLIENT_HELLO = {
  clientRole: "browser",
  clientKind: "browser",
  clientVersion: "1.2.3",
  clientProtocol: 2,
} as const;

const SERVER_HELLO = {
  verdict: "compatible",
  hostVersion: "4.5.6",
  hostProtocol: HOST_PROTOCOL,
  protocolRange: HOST_PROTOCOL_RANGE,
  reason: null,
} as const;

describe("hello frames", () => {
  it("normalizes a client hello through both the hello and the frame parser, dropping extras", () => {
    const wire = { t: "hello", ...CLIENT_HELLO, extra: true };
    const expected = { t: "hello", ...CLIENT_HELLO };
    expect(parseClientHello(wire)).toEqual(expected);
    expect(parseClientFrame(wire)).toEqual(expected);
    expect(parseClientFrame(makeClientHello(CLIENT_HELLO))).toEqual(expected);
  });

  it("normalizes a server hello through both parsers, copying the range", () => {
    const wire = { t: "hello", ...SERVER_HELLO, extra: true };
    const expected = { t: "hello", ...SERVER_HELLO };
    expect(parseServerHello(wire)).toEqual(expected);
    expect(parseServerFrame(wire)).toEqual(expected);
    const parsed = parseServerHello(makeServerHello(SERVER_HELLO));
    expect(parsed).toEqual(expected);
    expect(parsed?.protocolRange).not.toBe(HOST_PROTOCOL_RANGE);
    expect(
      parseServerHello({ ...wire, verdict: "incompatible", reason: "role mismatch" }),
    ).toMatchObject({ verdict: "incompatible", reason: "role mismatch" });
  });

  it("rejects a client hello with a missing, mistyped, or out-of-domain field", () => {
    const bad: unknown[] = [
      { ...CLIENT_HELLO }, // no t
      { t: "hello", ...CLIENT_HELLO, clientRole: "admin" },
      { t: "hello", ...CLIENT_HELLO, clientRole: 1 },
      { t: "hello", ...CLIENT_HELLO, clientKind: null },
      { t: "hello", ...CLIENT_HELLO, clientVersion: 1 },
      { t: "hello", ...CLIENT_HELLO, clientProtocol: "2" },
      { t: "hello", ...CLIENT_HELLO, clientProtocol: 1.5 },
      { t: "hello", ...CLIENT_HELLO, clientProtocol: 0 },
      { t: "hello", clientRole: "browser" },
    ];
    for (const frame of bad) {
      expect(parseClientHello(frame), JSON.stringify(frame)).toBeNull();
      expect(parseClientFrame(frame), JSON.stringify(frame)).toBeNull();
    }
  });

  it("rejects a server hello with a missing, mistyped, or out-of-domain field", () => {
    const bad: unknown[] = [
      { ...SERVER_HELLO },
      { t: "hello", ...SERVER_HELLO, verdict: "maybe" },
      { t: "hello", ...SERVER_HELLO, hostVersion: 4 },
      { t: "hello", ...SERVER_HELLO, hostProtocol: "2" },
      { t: "hello", ...SERVER_HELLO, hostProtocol: 2.5 },
      { t: "hello", ...SERVER_HELLO, protocolRange: null },
      { t: "hello", ...SERVER_HELLO, protocolRange: { min: 1 } },
      { t: "hello", ...SERVER_HELLO, protocolRange: { min: "1", max: 2 } },
      { t: "hello", ...SERVER_HELLO, reason: 7 },
      { t: "hello", ...SERVER_HELLO, reason: undefined },
    ];
    for (const frame of bad) {
      expect(parseServerHello(frame), JSON.stringify(frame)).toBeNull();
      expect(parseServerFrame(frame), JSON.stringify(frame)).toBeNull();
    }
  });

  it("does not let a hello leak into the req/notify/res/ev arms", () => {
    // A well-formed hello that also carries `ch`/`id` is still a hello, never a request.
    expect(parseClientFrame({ t: "hello", ...CLIENT_HELLO, ch: "state:get", id: 1 })).toEqual({
      t: "hello",
      ...CLIENT_HELLO,
    });
    expect(parseServerFrame({ t: "hello", ...SERVER_HELLO, id: 1, ok: true })).toEqual({
      t: "hello",
      ...SERVER_HELLO,
    });
    // And the old arms never see a hello as theirs.
    expect(parseClientHello({ t: "req", id: 1, ch: "x", args: [] })).toBeNull();
    expect(parseServerHello({ t: "ev", ch: "x", args: [] })).toBeNull();
  });
});
