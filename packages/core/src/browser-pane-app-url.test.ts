import { describe, expect, it } from "vitest";
import { browserPaneInstruction } from "./browser-pane";
import { BROWSER_PANE_APP_URL_MIN_OMP, browserPaneInstructionFor, supportsBrowserPaneAppUrl } from "./browser-pane-app-url";

const TOKEN = "A".repeat(43);
const URL_A = `http://127.0.0.1:4242/${TOKEN}`;

describe("supportsBrowserPaneAppUrl (issue #1188)", () => {
  it("admits omp at and above 18.19.0", () => {
    expect(BROWSER_PANE_APP_URL_MIN_OMP).toBe("18.19.0");
    expect(supportsBrowserPaneAppUrl("18.19.0")).toBe(true);
    expect(supportsBrowserPaneAppUrl("18.19.1")).toBe(true);
    expect(supportsBrowserPaneAppUrl("18.22.0")).toBe(true);
    expect(supportsBrowserPaneAppUrl("19.0.0")).toBe(true);
    expect(supportsBrowserPaneAppUrl("v18.19.0")).toBe(true);
  });

  it("rejects older omp and unknown versions", () => {
    expect(supportsBrowserPaneAppUrl("18.18.99")).toBe(false);
    expect(supportsBrowserPaneAppUrl("18.18.0")).toBe(false);
    expect(supportsBrowserPaneAppUrl("18.16.0")).toBe(false);
    expect(supportsBrowserPaneAppUrl(null)).toBe(false);
    expect(supportsBrowserPaneAppUrl("garbage")).toBe(false);
    expect(supportsBrowserPaneAppUrl("")).toBe(false);
  });
});

describe("browserPaneInstructionFor (issue #1188)", () => {
  it.each(["18.19.0", "18.22.0", "19.0.0"])("names the endpoint as a string app on %s", (version) => {
    const text = browserPaneInstructionFor(URL_A, version);
    expect(text).toContain(`app: "${URL_A}" });`);
    expect(text).not.toContain("cdp_url");
    // The endpoint still appears exactly once.
    expect(text.split(URL_A)).toHaveLength(2);
  });

  it.each(["18.16.0", "18.18.7", "18.18.99", null, "garbage", "", "unknown"])(
    "stays byte-identical to the legacy object-form text for %j",
    (version) => {
      expect(browserPaneInstructionFor(URL_A, version)).toBe(browserPaneInstruction(URL_A));
    },
  );
});
