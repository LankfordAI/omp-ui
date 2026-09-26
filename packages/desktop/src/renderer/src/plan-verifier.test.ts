// @vitest-environment jsdom
// The verifier page loads with no preload, so window.ompBackend is absent. The
// real entry graph must still evaluate and register its global (issue #657):
// nothing here mocks ../backend, because a mock is exactly what hid the throw.
import { describe, expect, it } from "vitest";
import "./plan-verifier";

describe("plan verifier entry", () => {
  it("registers window.ompPlanVerifier without a backend bridge", async () => {
    expect("ompBackend" in window).toBe(false);
    const verifier = window.ompPlanVerifier;
    expect(typeof verifier?.verify).toBe("function");
    // The registered entry answers a call, not just exists.
    const result = await verifier!.verify({ html: 42 });
    expect(result.status).toBe("unavailable");
  });
});
