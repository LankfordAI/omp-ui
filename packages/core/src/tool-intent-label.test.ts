import { describe, expect, it } from "vitest";
import { toolIntentLabel } from "./tool-intent-label";

describe("toolIntentLabel (issue #1274, pi-wire port)", () => {
  it("takes the label off a colon-space separated intent", () => {
    expect(toolIntentLabel("Reading config.json: 3 lines")).toBe("Reading config.json");
    expect(toolIntentLabel("Searching: foo in src")).toBe("Searching");
  });

  it("keeps a bare intent whole and preserves a trailing-colon cut only when nonempty", () => {
    expect(toolIntentLabel("Reading hello.txt")).toBe("Reading hello.txt");
    expect(toolIntentLabel("Reading hello.txt:")).toBe("Reading hello.txt");
    expect(toolIntentLabel(": trailing prose")).toBe(": trailing prose");
  });

  it("never cuts at a URL authority port or file:line reference", () => {
    expect(toolIntentLabel("Fetched https://ex.com:8080/x")).toBe("Fetched https://ex.com:8080/x");
    expect(toolIntentLabel("Opening src/app.tsx:42")).toBe("Opening src/app.tsx:42");
  });
});
