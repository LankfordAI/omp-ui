import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { HTML_ARTIFACT_PARTITION } from "@omp-ui/core";
import { artifactWebviewAdmitted, installHtmlArtifactGuard } from "./html-artifact-guard";

// vi.mock is hoisted above the import: the guard module loads against this stub.
const electron = vi.hoisted(() => {
  const partition: Record<string, unknown> = { setProxy: () => Promise.resolve() };
  return {
    partition,
    app: { handlers: new Map<string, (...args: never[]) => void>(), on: (event: string, handler: (...args: never[]) => void) => electron.app.handlers.set(event, handler) },
    session: { fromPartition: () => partition },
  };
});
vi.mock("electron", () => ({ app: electron.app, session: electron.session }));

const DOC = "data:text/html;charset=utf-8;base64,PHA+eDwvcD4=";

class FakeContents extends EventEmitter {
  session = electron.partition;
  hostWebContents: FakeContents | undefined;
  focused = 0;
  isDestroyed(): boolean { return false; }
  focus(): void { this.focused++; }
  getType(): string { return this.hostWebContents ? "webview" : "window"; }
  setWebRTCIPHandlingPolicy(): void {}
  setWindowOpenHandler(): void {}
}

describe("installHtmlArtifactGuard", () => {
  it("reclaims host focus when a plain partition guest sees Escape (#1130)", () => {
    electron.partition.webRequest = { onBeforeRequest: () => {} };
    (electron.partition as Record<string, unknown>).setPermissionRequestHandler = () => {};
    (electron.partition as Record<string, unknown>).setPermissionCheckHandler = () => {};
    (electron.partition as Record<string, unknown>).setDevicePermissionHandler = () => {};
    (electron.partition as Record<string, unknown>).setDisplayMediaRequestHandler = () => {};
    electron.partition.on = () => {};
    const host = new FakeContents();
    installHtmlArtifactGuard(host as never);
    const guest = new FakeContents();
    guest.hostWebContents = host;
    electron.app.handlers.get("web-contents-created")?.({} as never, guest as never);
    guest.emit("before-input-event", {}, { type: "keyDown", key: "a" });
    expect(host.focused).toBe(0);
    guest.emit("before-input-event", {}, { type: "keyDown", key: "Escape" });
    expect(host.focused).toBe(1);
    const foreign = new FakeContents();
    foreign.hostWebContents = host;
    foreign.session = {};
    electron.app.handlers.get("web-contents-created")?.({} as never, foreign as never);
    foreign.emit("before-input-event", {}, { type: "keyDown", key: "Escape" });
    expect(host.focused).toBe(1);
  });
});

describe("artifactWebviewAdmitted", () => {
  it("admits only an artifact document on the locked artifact partition", () => {
    expect(artifactWebviewAdmitted({ partition: "omp-ui-artifacts", src: DOC }, true)).toBe(true);
  });

  it.each([
    ["before the partition's proxy is in force", { partition: "omp-ui-artifacts", src: DOC }, false],
    ["on another partition", { partition: "persist:omp-ui-browser-pane", src: DOC }, true],
    ["on the default session", { src: DOC }, true],
    ["for a web page", { partition: "omp-ui-artifacts", src: "https://example.com/" }, true],
    ["for a file", { partition: "omp-ui-artifacts", src: "file:///etc/passwd" }, true],
  ])("refuses a webview %s", (_label, params, locked) => {
    expect(artifactWebviewAdmitted(params as Record<string, string>, locked)).toBe(false);
  });
});
