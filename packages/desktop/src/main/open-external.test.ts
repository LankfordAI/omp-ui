import { afterEach, describe, expect, it, vi } from "vitest";

// open-external.ts applies the scheme policy; system-open.ts launches. Stub
// the launch and capture calls.
const systemOpenMock = {
  openExternal: vi.fn(async () => {}),
};
vi.mock("./system-open", () => systemOpenMock);

const { openExternalSafe } = await import("./open-external");

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
      "https://a.dev\u0000evil",
      "",
    ]) {
      openExternalSafe(url);
    }
    expect(systemOpenMock.openExternal).not.toHaveBeenCalled();
  });
});
