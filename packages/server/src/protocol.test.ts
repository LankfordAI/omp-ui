import { describe, expect, it } from "vitest";
import { parseClientFrame } from "./protocol";

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
