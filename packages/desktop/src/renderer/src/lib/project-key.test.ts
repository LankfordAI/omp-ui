import { describe, expect, it } from "vitest";
import { projectKey, splitProjectKey } from "./project-key";

describe("projectKey (issue #416)", () => {
  it("keeps a local project's key as the bare path so persisted focus stays valid", () => {
    expect(projectKey(null, "/home/u/proj")).toBe("/home/u/proj");
    expect(splitProjectKey("/home/u/proj")).toEqual({ instanceId: null, path: "/home/u/proj" });
  });

  it("round-trips a remote project through a key distinct from the local one", () => {
    const key = projectKey("6f1c2b0e-1111-4222-8333-444455556666", "/home/u/proj");
    expect(key).not.toBe("/home/u/proj");
    expect(splitProjectKey(key)).toEqual({
      instanceId: "6f1c2b0e-1111-4222-8333-444455556666",
      path: "/home/u/proj",
    });
  });

  it("does not mistake a separator inside a local path for an instance prefix", () => {
    expect(splitProjectKey("/srv/a::b")).toEqual({ instanceId: null, path: "/srv/a::b" });
    expect(splitProjectKey("C:\\work\\a::b")).toEqual({ instanceId: null, path: "C:\\work\\a::b" });
  });
});
