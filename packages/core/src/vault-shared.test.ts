import { describe, expect, it } from "vitest";
import { normalizeHomeFolder, obsidianOpenUri, parseVaultDetails, vaultNameFromPath } from "./vault-shared";

describe("obsidianOpenUri", () => {
  it("matches the spec examples byte for byte", () => {
    expect(obsidianOpenUri({ vault: "ee8bdab8baa42089" }, "omp-ui/omp-ui/Foo.md")).toBe(
      "obsidian://open?vault=ee8bdab8baa42089&file=omp-ui%2Fomp-ui%2FFoo",
    );
    expect(obsidianOpenUri({ vault: "Obsidian" }, null)).toBe("obsidian://open?vault=Obsidian");
    expect(obsidianOpenUri({ path: "/home/u/Vault/omp-ui/Foo.md" }, null)).toBe(
      "obsidian://open?path=%2Fhome%2Fu%2FVault%2Fomp-ui%2FFoo.md",
    );
  });

  it("strips an upper-case .MD extension", () => {
    expect(obsidianOpenUri({ vault: "v" }, "Notes/Foo.MD")).toBe("obsidian://open?vault=v&file=Notes%2FFoo");
  });

  it("encodes &, # and spaces in every value", () => {
    expect(obsidianOpenUri({ vault: "My Vault&#" }, "a & b #1.md")).toBe(
      "obsidian://open?vault=My%20Vault%26%23&file=a%20%26%20b%20%231",
    );
    expect(obsidianOpenUri({ path: "/v/a & b #1.md" }, null)).toBe("obsidian://open?path=%2Fv%2Fa%20%26%20b%20%231.md");
  });
});

describe("normalizeHomeFolder", () => {
  it("accepts and normalizes relative folders to one trailing slash", () => {
    expect(normalizeHomeFolder("omp-ui")).toBe("omp-ui/");
    expect(normalizeHomeFolder("./omp-ui/")).toBe("omp-ui/");
    expect(normalizeHomeFolder("a\\b//")).toBe("a/b/");
    expect(normalizeHomeFolder(" ./notes\\omp//")).toBe("notes/omp/");
  });

  it("refuses empty, absolute, drive, parent and dot-leading input", () => {
    for (const input of ["", "   ", "/x", "\\x", "C:x", "C:\\x", "../x", "a/../b", ".obsidian", ".hidden", "a/.hidden"]) {
      expect(normalizeHomeFolder(input), input).toBeNull();
    }
  });
});

describe("vaultNameFromPath", () => {
  it("takes the last segment, splitting both separators", () => {
    expect(vaultNameFromPath("/home/u/Vault")).toBe("Vault");
    expect(vaultNameFromPath("/home/u/Vault/")).toBe("Vault");
    expect(vaultNameFromPath("C:\\Users\\u\\Notes")).toBe("Notes");
    expect(vaultNameFromPath("C:\\Users/u\\Mixed/")).toBe("Mixed");
    expect(vaultNameFromPath("/")).toBe("");
  });
});

describe("parseVaultDetails", () => {
  it("returns null for a non-object, a missing vaultName or an unknown action", () => {
    expect(parseVaultDetails(null)).toBeNull();
    expect(parseVaultDetails("x")).toBeNull();
    expect(parseVaultDetails({ action: "read" })).toBeNull();
    expect(parseVaultDetails({ vaultName: 1, action: "read" })).toBeNull();
    expect(parseVaultDetails({ vaultName: "V", action: "delete" })).toBeNull();
    expect(parseVaultDetails({ vaultName: "V" })).toBeNull();
  });

  it("fills null for missing or wrongly typed required-nullable fields", () => {
    expect(parseVaultDetails({ vaultName: "V", action: "search", vaultId: 7, path: false, createdByOmpUi: "yes" })).toEqual({
      vaultName: "V",
      vaultId: null,
      path: null,
      action: "search",
      createdByOmpUi: null,
    });
  });

  it("copies correctly typed optionals", () => {
    const details = {
      vaultName: "V",
      vaultId: "ee8bdab8baa42089",
      path: "omp-ui/Foo.md",
      action: "create",
      createdByOmpUi: true,
      title: "Foo",
      stamp: ["created: 2026-10-06"],
      preview: "body",
      diff: "+1|x",
      baseHash: "abc",
      indexNotePath: "omp-ui/omp-ui.md",
      collisions: ["other/Foo.md"],
      matchedFiles: 3,
      returnedFiles: 2,
      truncated: false,
    };
    expect(parseVaultDetails(details)).toEqual(details);
    expect(parseVaultDetails(details)).not.toBe(details);
  });

  it("drops wrongly typed optionals", () => {
    expect(
      parseVaultDetails({
        vaultName: "V",
        action: "list",
        title: 1,
        stamp: ["ok", 2],
        preview: null,
        diff: [],
        baseHash: {},
        indexNotePath: true,
        collisions: "a",
        matchedFiles: Number.NaN,
        returnedFiles: "2",
        truncated: "true",
      }),
    ).toEqual({ vaultName: "V", vaultId: null, path: null, action: "list", createdByOmpUi: null });
  });

  it("never returns input keys it does not know", () => {
    const parsed = parseVaultDetails({ vaultName: "V", action: "read", extra: 1, __proto__x: 2 });
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed ?? {}).sort()).toEqual(["action", "createdByOmpUi", "path", "vaultId", "vaultName"]);
  });
});
