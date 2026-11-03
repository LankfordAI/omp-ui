import { describe, expect, it } from "vitest";
import { credentialFallbackFromFrame } from "./credential-fallback";

describe("credentialFallbackFromFrame (issue #1032)", () => {
  it("reads a credential-reasoned retry_fallback_applied frame", () => {
    expect(
      credentialFallbackFromFrame({
        type: "retry_fallback_applied",
        from: "nokeyprov/m1",
        to: "keyprov/m1",
        role: "nokeyprov/m1",
        reason: "no credential for nokeyprov",
      }),
    ).toEqual({ from: "nokeyprov/m1", to: "keyprov/m1" });
  });

  it("tolerates extra unknown fields", () => {
    expect(
      credentialFallbackFromFrame({
        type: "retry_fallback_applied",
        from: "a/m",
        to: "b/m",
        reason: "no credential for a",
        attempt: 2,
        chain: ["b/m", "c/m"],
      }),
    ).toEqual({ from: "a/m", to: "b/m" });
  });

  it("says nothing for ordinary retry reasons", () => {
    expect(
      credentialFallbackFromFrame({
        type: "retry_fallback_applied",
        from: "a/m",
        to: "b/m",
        reason: "Request failed: overloaded",
      }),
    ).toBeNull();
    expect(
      credentialFallbackFromFrame({
        type: "retry_fallback_applied",
        from: "a/m",
        to: "b/m",
        reason: "fireworks",
      }),
    ).toBeNull();
  });

  it("says nothing for absent, empty, or non-string reasons", () => {
    const base = { type: "retry_fallback_applied", from: "a/m", to: "b/m" };
    expect(credentialFallbackFromFrame(base)).toBeNull();
    expect(credentialFallbackFromFrame({ ...base, reason: "" })).toBeNull();
    expect(credentialFallbackFromFrame({ ...base, reason: 42 })).toBeNull();
    expect(credentialFallbackFromFrame({ ...base, reason: null })).toBeNull();
  });

  it("says nothing for missing or empty selectors", () => {
    const frame = { type: "retry_fallback_applied", reason: "no credential for a" };
    expect(credentialFallbackFromFrame(frame)).toBeNull();
    expect(credentialFallbackFromFrame({ ...frame, from: "a/m" })).toBeNull();
    expect(credentialFallbackFromFrame({ ...frame, to: "b/m" })).toBeNull();
    expect(credentialFallbackFromFrame({ ...frame, from: "", to: "b/m" })).toBeNull();
    expect(credentialFallbackFromFrame({ ...frame, from: "a/m", to: "" })).toBeNull();
    expect(credentialFallbackFromFrame({ ...frame, from: 7, to: "b/m" })).toBeNull();
  });

  it("says nothing for unrelated or non-object frames", () => {
    expect(credentialFallbackFromFrame({ type: "model_changed" })).toBeNull();
    expect(credentialFallbackFromFrame(null)).toBeNull();
    expect(credentialFallbackFromFrame("str")).toBeNull();
    expect(credentialFallbackFromFrame([])).toBeNull();
    expect(credentialFallbackFromFrame(42)).toBeNull();
  });
});
