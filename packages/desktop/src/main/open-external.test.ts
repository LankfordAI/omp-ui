import { afterEach, describe, expect, it, vi } from "vitest";

// open-external.ts applies the scheme policy; system-open.ts launches. Stub
// the launch and capture calls.
const systemOpenMock = {
  openExternal: vi.fn(async () => {}),
};
vi.mock("./system-open", () => systemOpenMock);

const { decideSubframeNavigation, openExternalSafe } = await import("./open-external");

afterEach(() => {
  systemOpenMock.openExternal.mockClear();
});

describe("openExternalSafe", () => {
  it("hands https, http and mailto URLs to the system handler", () => {
    for (const url of ["https://a.dev", "http://a.dev", "mailto:a@b.dev"]) {
      openExternalSafe(url);
    }
    expect(systemOpenMock.openExternal.mock.calls).toEqual([
      ["https://a.dev"],
      ["http://a.dev"],
      ["mailto:a@b.dev"],
    ]);
  });

  it("rejects non-web schemes, control characters and empty URLs", () => {
    for (const url of [
      "javascript:alert(1)",
      "file:///etc/passwd",
      "data:text/html,<script>x</script>",
      "obsidian://open?vault=Notes&file=Note.md",
      "obsidian://create?vault=Notes&name=Note",
      "https://a.dev\u0000evil",
      "",
    ]) {
      openExternalSafe(url);
    }
    expect(systemOpenMock.openExternal).not.toHaveBeenCalled();
  });
});

describe("decideSubframeNavigation", () => {
  it("allows main-frame events untouched", () => {
    expect(
      decideSubframeNavigation({ isMainFrame: true, url: "https://example.com", frameName: "omp-backdrop-scene" }),
    ).toBe("allow");
  });

  it("allows only about:srcdoc in omp-backdrop-scene and silently denies every other navigation", () => {
    expect(
      decideSubframeNavigation({ isMainFrame: false, url: "about:srcdoc", frameName: "omp-backdrop-scene" }),
    ).toBe("allow");
    for (const url of ["https://attacker/", "http://attacker/", "about:blank", "file:///etc/passwd"]) {
      expect(
        decideSubframeNavigation({ isMainFrame: false, url, frameName: "omp-backdrop-scene" }),
      ).toBe("deny-silent");
    }
  });

  it("silently denies navigations when frameName is null or undefined", () => {
    expect(decideSubframeNavigation({ isMainFrame: false, url: "https://attacker/", frameName: null })).toBe(
      "deny-silent",
    );
    expect(decideSubframeNavigation({ isMainFrame: false, url: "about:srcdoc", frameName: undefined })).toBe(
      "deny-silent",
    );
  });

  it("preserves about: allow and external-open routing for unnamed plan frames", () => {
    expect(decideSubframeNavigation({ isMainFrame: false, url: "about:srcdoc", frameName: "" })).toBe("allow");
    expect(decideSubframeNavigation({ isMainFrame: false, url: "about:blank", frameName: "" })).toBe("allow");
    expect(decideSubframeNavigation({ isMainFrame: false, url: "https://docs.example", frameName: "" })).toBe(
      "deny-open-external",
    );
  });
});
