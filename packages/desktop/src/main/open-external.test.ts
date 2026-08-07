import { afterEach, describe, expect, it, vi } from "vitest";

// open-external.ts touches only electron's `shell`; stub it and capture calls.
const shellMock = {
  openExternal: vi.fn(async () => {}),
};
vi.mock("electron", () => ({ shell: shellMock }));

const { openExternalSafe } = await import("./open-external");

afterEach(() => {
  shellMock.openExternal.mockClear();
});

describe("openExternalSafe", () => {
  it("opens https, http and mailto URLs via the system shell", () => {
    for (const url of ["https://a.dev", "http://a.dev", "mailto:a@b.dev"]) {
      openExternalSafe(url);
    }
    expect(shellMock.openExternal).toHaveBeenCalledTimes(3);
    expect(shellMock.openExternal).toHaveBeenCalledWith("https://a.dev");
    expect(shellMock.openExternal).toHaveBeenCalledWith("http://a.dev");
    expect(shellMock.openExternal).toHaveBeenCalledWith("mailto:a@b.dev");
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
    expect(shellMock.openExternal).not.toHaveBeenCalled();
  });
});
