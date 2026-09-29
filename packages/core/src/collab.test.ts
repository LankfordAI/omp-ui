import { describe, expect, it } from "vitest";
import { parseCollabListing } from "./collab";

const HOST = {
  instanceId: "inst-1",
  pid: 4242,
  generation: 3,
  sessionId: "sess-abc",
  sessionName: "my session",
  cwd: "/repo",
  model: "anthropic/claude",
  startedAt: "2026-09-29T00:00:00.000Z",
  participants: 2,
  access: "full",
  relayConnected: true,
  inputRequired: false,
  busy: true,
};

describe("parseCollabListing", () => {
  it("accepts a full row verbatim", () => {
    expect(parseCollabListing({ version: 1, hosts: [HOST] })).toEqual([HOST]);
  });

  it("returns an empty list for no hosts", () => {
    expect(parseCollabListing({ version: 1, hosts: [] })).toEqual([]);
  });

  it("degrades optional fields to safe defaults", () => {
    const rows = parseCollabListing({
      hosts: [{ instanceId: "i", pid: 1, generation: 0, access: "view" }],
    });
    expect(rows).toEqual([
      {
        instanceId: "i",
        pid: 1,
        generation: 0,
        sessionId: "",
        sessionName: "",
        cwd: "",
        model: "",
        startedAt: "",
        participants: 0,
        access: "view",
        relayConnected: false,
        inputRequired: false,
        busy: false,
      },
    ]);
  });

  it("drops rows missing an identity and keeps the rest", () => {
    expect(parseCollabListing({ hosts: [{ pid: 1, generation: 0 }, { instanceId: "", pid: 2, generation: 0 }, HOST] })).toEqual([HOST]);
  });

  it("rejects non-object documents and a missing hosts array", () => {
    expect(parseCollabListing(null)).toBeNull();
    expect(parseCollabListing("hosts")).toBeNull();
    expect(parseCollabListing({ version: 1 })).toBeNull();
  });
});
