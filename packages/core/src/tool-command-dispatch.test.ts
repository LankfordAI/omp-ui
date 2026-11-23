import { describe, expect, it } from "vitest";
import { parseToolCommandDispatches } from "./tool-command-dispatch";

describe("parseToolCommandDispatches (issue #1274)", () => {
  it("keeps the record's invocation order with mode and exit status", () => {
    expect(
      parseToolCommandDispatches({
        toolCommands: [
          { tool: "lsp", mode: "help", exitCode: 0 },
          { tool: "read", mode: "execute", exitCode: 1, args: { path: "a.ts" } },
        ],
      }),
    ).toEqual([
      { tool: "lsp", mode: "help", exitCode: 0 },
      { tool: "read", mode: "execute", exitCode: 1, args: { path: "a.ts" } },
    ]);
  });

  it("drops malformed entries but keeps the valid ones", () => {
    expect(
      parseToolCommandDispatches({
        toolCommands: [
          { tool: "", mode: "execute", exitCode: 0 },
          { tool: "grep", mode: "run", exitCode: 0 },
          { tool: "grep", mode: "execute", exitCode: "0" },
          null,
          "x",
          { tool: "grep", mode: "execute", exitCode: 0 },
        ],
      }),
    ).toEqual([{ tool: "grep", mode: "execute", exitCode: 0 }]);
  });

  it("reads a missing or non-array record as empty — pre-19.1 binaries and quiet runs", () => {
    expect(parseToolCommandDispatches(undefined)).toEqual([]);
    expect(parseToolCommandDispatches({})).toEqual([]);
    expect(parseToolCommandDispatches({ toolCommands: "read" })).toEqual([]);
    expect(parseToolCommandDispatches(null)).toEqual([]);
  });

  it("keeps a non-object args projection off the record", () => {
    expect(
      parseToolCommandDispatches({ toolCommands: [{ tool: "x", mode: "execute", exitCode: 0, args: [1] }] }),
    ).toEqual([{ tool: "x", mode: "execute", exitCode: 0 }]);
  });
});
