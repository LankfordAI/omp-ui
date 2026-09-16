import { describe, expect, it } from "vitest";
import { isLocalDevUrl, localDevUrls } from "./browser-pane-offer";

describe("local dev-server URL detection", () => {
  it("normalizes distinct loopback URLs in first-seen order", () => {
    expect(localDevUrls("Local: http://localhost:5173/ and http://127.0.0.1:5173/"))
      .toEqual(["http://localhost:5173/", "http://127.0.0.1:5173/"]);
    expect(localDevUrls("http://localhost:5173/ then http://localhost:5173/")).toEqual([
      "http://localhost:5173/",
    ]);
  });

  it("accepts IPv6 and localhost subdomains but rejects lookalikes and other schemes", () => {
    expect(isLocalDevUrl("http://[::1]:3000")).toBe(true);
    expect(isLocalDevUrl("https://app.localhost:8443/x")).toBe(true);
    expect(isLocalDevUrl("https://example.com")).toBe(false);
    expect(isLocalDevUrl("ftp://localhost/x")).toBe(false);
    expect(isLocalDevUrl("http://localhost.evil.com")).toBe(false);
  });

  it("uses markdown boundary trimming", () => {
    expect(localDevUrls("ready (http://localhost:8123/path)."))
      .toEqual(["http://localhost:8123/path"]);
  });
});
