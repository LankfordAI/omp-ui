import { describe, expect, it } from "vitest";
import { BROWSER_PANE_INSTRUCTION_PARTS, browserPaneInstruction } from "./browser-pane";
import {
  BROWSER_PANE_RELAY_FIXES_MIN_OMP,
  browserPaneInstructionFor,
  supportsBrowserPaneRelayFixes,
} from "./browser-pane-relay";

const TOKEN = "A".repeat(43);
const URL_A = `http://127.0.0.1:4242/${TOKEN}`;

describe("supportsBrowserPaneRelayFixes (issue #1031)", () => {
  it("admits omp at and above 18.16.0", () => {
    expect(BROWSER_PANE_RELAY_FIXES_MIN_OMP).toBe("18.16.0");
    expect(supportsBrowserPaneRelayFixes("18.16.0")).toBe(true);
    expect(supportsBrowserPaneRelayFixes("18.16.1")).toBe(true);
    expect(supportsBrowserPaneRelayFixes("19.0.0")).toBe(true);
    expect(supportsBrowserPaneRelayFixes("v18.16.0")).toBe(true);
  });

  it("rejects older omp and unknown versions", () => {
    expect(supportsBrowserPaneRelayFixes("18.15.0")).toBe(false);
    expect(supportsBrowserPaneRelayFixes("18.15.99")).toBe(false);
    expect(supportsBrowserPaneRelayFixes(null)).toBe(false);
    expect(supportsBrowserPaneRelayFixes("garbage")).toBe(false);
    expect(supportsBrowserPaneRelayFixes("")).toBe(false);
  });
});

describe("browserPaneInstructionFor (issue #1031)", () => {
  it.each(["18.16.0", "19.0.0"])("omits only the workaround sentence on %s", (version) => {
    const text = browserPaneInstructionFor(URL_A, version);
    expect(text).toBe(
      BROWSER_PANE_INSTRUCTION_PARTS[0] + URL_A + BROWSER_PANE_INSTRUCTION_PARTS[1] + BROWSER_PANE_INSTRUCTION_PARTS[3],
    );
    expect(text).not.toContain("tab.click hangs");
  });

  it.each(["18.15.0", "18.15.99", null, "garbage", ""])(
    "stays byte-identical to the legacy text for %j",
    (version) => {
      expect(browserPaneInstructionFor(URL_A, version)).toBe(browserPaneInstruction(URL_A));
    },
  );
});
