import { describe, expect, it, vi } from "vitest";
import { artifactWebviewAdmitted } from "./html-artifact-guard";

// vi.mock is hoisted above the import: the guard module loads against this stub.
vi.mock("electron", () => ({ app: {}, session: {} }));

const DOC = "data:text/html;charset=utf-8;base64,PHA+eDwvcD4=";

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
