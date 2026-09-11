import { describe, expect, it } from "vitest";
import { makeServerEventFrame, makeServerResponseErr, makeServerResponseOk, parseClientFrame, parseServerFrame } from "./protocol";

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
