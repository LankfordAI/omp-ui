import { describe, expect, it } from "vitest";
import { LoginThrottle } from "./login-throttle";

describe("LoginThrottle", () => {
  it("counts failures without locking below the threshold", () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 4; i++) t.recordFailure("1.1.1.1", i);
    expect(t.retryAfter("1.1.1.1", 4)).toBe(0);
  });

  it("locks at five failures for 60s and doubles per further strike", () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 5; i++) t.recordFailure("2.2.2.2", 0);
    expect(t.retryAfter("2.2.2.2", 0)).toBe(60);
    expect(t.retryAfter("2.2.2.2", 59_000)).toBe(1); // still locked 1s before the edge
    expect(t.retryAfter("2.2.2.2", 60_000)).toBe(0); // free at the edge

    t.recordFailure("2.2.2.2", 60_000); // 6th strike
    expect(t.retryAfter("2.2.2.2", 60_000)).toBe(120);
    t.recordFailure("2.2.2.2", 180_000); // 7th strike
    expect(t.retryAfter("2.2.2.2", 180_000)).toBe(240);
  });

  it("caps the lockout at 900s", () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 5; i++) t.recordFailure("ip", 0);
    let now = 60_000;
    for (let strike = 6; strike <= 10; strike++) {
      t.recordFailure("ip", now);
      const expected = Math.min(60 * 2 ** (strike - 5), 900); // 960→900, 1920→900
      expect(t.retryAfter("ip", now)).toBe(expected);
      now += expected * 1000;
    }
  });

  it("clears the failure history on success", () => {
    const t = new LoginThrottle();
    for (let i = 0; i < 4; i++) t.recordFailure("4.4.4.4", i);
    t.clear("4.4.4.4");
    for (let i = 0; i < 4; i++) t.recordFailure("4.4.4.4", 100 + i);
    expect(t.retryAfter("4.4.4.4", 104)).toBe(0); // fresh count, not a 5th consecutive strike
  });

  it("evicts the oldest IP once the map is full", () => {
    const t = new LoginThrottle();
    const CAP = 10_000;
    for (let i = 0; i < 5; i++) t.recordFailure("first", i);
    expect(t.retryAfter("first", 4)).toBe(60);
    for (let i = 0; i < CAP - 1; i++) t.recordFailure(`fill-${i}`, i); // map now at the cap
    t.recordFailure("last", 0); // over cap → "first" (oldest insertion) is evicted
    // "first" was evicted, so its counter restarted: four fresh failures do not lock it.
    for (let i = 0; i < 4; i++) t.recordFailure("first", 100 + i);
    expect(t.retryAfter("first", 104)).toBe(0); // without eviction this would be 120
  });
});
