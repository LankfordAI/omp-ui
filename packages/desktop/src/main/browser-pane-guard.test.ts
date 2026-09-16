import { describe, expect, it } from "vitest";
import { browserPaneRequestCancelled, isDeniedLoopbackRequest } from "./browser-pane-guard";

const DENIED = new Set([9222, 443, 80]);

describe("isDeniedLoopbackRequest (#531 layer 3)", () => {
  it.each([
    ["http://127.0.0.1:9222/json/version", true],
    ["http://127.5.5.5:9222/", true],
    ["http://localhost:9222/", true],
    ["http://[::1]:9222/", true],
    ["http://0.0.0.0:9222/", true],
    ["ws://127.0.0.1:9222/token", true],
    ["http://LOCALHOST:9222/", true],
  ])("cancels %s against a denied port", (url, cancelled) => {
    expect(isDeniedLoopbackRequest(url, DENIED)).toBe(cancelled);
  });

  it("defaults the port from the scheme when the URL carries none", () => {
    expect(isDeniedLoopbackRequest("http://127.0.0.1/", DENIED)).toBe(true);
    expect(isDeniedLoopbackRequest("https://localhost/", DENIED)).toBe(true);
    expect(isDeniedLoopbackRequest("https://localhost/", new Set([80]))).toBe(false);
    expect(isDeniedLoopbackRequest("http://127.0.0.1/", new Set([443]))).toBe(false);
  });

  it("leaves other loopback ports, non-loopback hosts, and unparsable URLs alone", () => {
    expect(isDeniedLoopbackRequest("http://127.0.0.1:3000/", DENIED)).toBe(false);
    expect(isDeniedLoopbackRequest("http://example.com:9222/", DENIED)).toBe(false);
    expect(isDeniedLoopbackRequest("http://192.168.1.10:9222/", DENIED)).toBe(false);
    expect(isDeniedLoopbackRequest("http://127.0.0.1.evil.com:9222/", DENIED)).toBe(false);
    expect(isDeniedLoopbackRequest("not a url", DENIED)).toBe(false);
    expect(isDeniedLoopbackRequest("http://127.0.0.1:9222/", new Set())).toBe(false);
  });
});

describe("browserPaneRequestCancelled (#531 layer 3)", () => {
  const cancelled = (url: string, resourceType: string, denied: ReadonlySet<number> = DENIED) =>
    browserPaneRequestCancelled({ url, resourceType }, denied);

  it("holds main frames to the top-level allow-list", () => {
    expect(cancelled("https://example.com/", "mainFrame")).toBe(false);
    expect(cancelled("about:blank", "mainFrame")).toBe(false);
    expect(cancelled("file:///etc/passwd", "mainFrame")).toBe(true);
    expect(cancelled("data:text/html,hi", "mainFrame")).toBe(true);
    expect(cancelled("javascript:alert(1)", "mainFrame")).toBe(true);
    expect(cancelled("chrome://gpu", "mainFrame")).toBe(true);
  });

  it("lets subframes use data:, blob:, and about: but nothing local", () => {
    expect(cancelled("data:text/html,hi", "subFrame")).toBe(false);
    expect(cancelled("blob:https://example.com/uuid", "subFrame")).toBe(false);
    expect(cancelled("about:srcdoc", "subFrame")).toBe(false);
    expect(cancelled("file:///etc/passwd", "subFrame")).toBe(true);
    expect(cancelled("chrome-extension://abc/x.html", "subFrame")).toBe(true);
  });

  it("cancels every resource type that reaches a denied loopback port", () => {
    for (const type of ["mainFrame", "subFrame", "script", "xhr", "image", "webSocket", "other"]) {
      expect(cancelled("http://127.0.0.1:9222/json/version", type)).toBe(true);
      expect(cancelled("http://127.0.0.1:3000/app.js", type)).toBe(false);
    }
    expect(cancelled("ws://127.0.0.1:9222/token", "webSocket")).toBe(true);
  });
});
