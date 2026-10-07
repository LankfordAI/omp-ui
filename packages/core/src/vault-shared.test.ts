import { describe, expect, it } from "vitest";
import { isKnowledgeHome, normalizeHomeFolder, obsidianOpenUri, obsidianReplyLink, parseObsidianNoteUri, parseVaultDetails, vaultNameFromPath } from "./vault-shared";

describe("isKnowledgeHome", () => {
  it("accepts each home with an absent or nonempty vault pin", () => {
    for (const home of ["docs", "vault", "both"]) {
      expect(isKnowledgeHome({ home })).toBe(true);
      expect(isKnowledgeHome({ home, vault: "My Vault" })).toBe(true);
    }
  });

  it("rejects malformed homes, unknown keys, and present invalid vault pins", () => {
    for (const value of [
      null, undefined, false, "vault", [], ["vault"], {},
      { home: "other" }, { home: 1 }, { home: null },
      { home: "vault", folder: "notes" },
      { home: "vault", vault: undefined }, { home: "vault", vault: null },
      { home: "vault", vault: "" }, { home: "vault", vault: 1 },
    ]) {
      expect(isKnowledgeHome(value), JSON.stringify(value)).toBe(false);
    }
  });
});

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

describe("obsidianReplyLink", () => {
  it("keeps the resolved path and full Markdown extension", () => {
    expect(obsidianReplyLink("My Vault", "nested/Note.md", "Note")).toBe(
      "[Note](obsidian://open?vault=My%20Vault&file=nested%2FNote.md)",
    );
    expect(obsidianReplyLink("V", "Note.md.md", "Note")).toBe(
      "[Note](obsidian://open?vault=V&file=Note.md.md)",
    );
    expect(obsidianReplyLink("V", "Note.MD", "Note")).toBe(
      "[Note](obsidian://open?vault=V&file=Note.MD)",
    );
  });

  it("percent-encodes Unicode and every punctuation unsafe in a Markdown destination", () => {
    expect(obsidianReplyLink("Research & 研究 %!'()*", "nested/é (draft) & 100%!'()*.md", "研究 & draft")).toBe(
      "[研究 \\& draft](obsidian://open?vault=Research%20%26%20%E7%A0%94%E7%A9%B6%20%25%21%27%28%29%2A&file=nested%2F%C3%A9%20%28draft%29%20%26%20100%25%21%27%28%29%2A.md)",
    );
  });

  it.each([
    ["!", "\\!"], ['"', '\\"'], ["#", "\\#"], ["$", "\\$"], ["%", "\\%"], ["&", "\\&"], ["'", "\\'"],
    ["(", "\\("], [")", "\\)"], ["*", "\\*"], ["+", "\\+"], [",", "\\,"], ["-", "\\-"], [".", "\\."], ["/", "\\/"],
    [":", "\\:"], [";", "\\;"], ["<", "\\<"], ["=", "\\="], [">", "\\>"], ["?", "\\?"], ["@", "\\@"],
    ["[", "\\["], ["\\", "\\\\"], ["]", "\\]"], ["^", "\\^"], ["_", "\\_"], ["`", "\\`"],
    ["{", "\\{"], ["|", "\\|"], ["}", "\\}"], ["~", "\\~"],
  ])("backslash-escapes label punctuation %s without HTML entities", (punctuation, escaped) => {
    expect(obsidianReplyLink("V", "Note.md", `a${punctuation}b`)).toBe(
      `[a${escaped}b](obsidian://open?vault=V&file=Note.md)`,
    );
  });

  it("does not escape ordinary or non-ASCII title characters", () => {
    expect(obsidianReplyLink("V", "Note.md", "Résumé 研究 → 123")).toBe(
      "[Résumé 研究 → 123](obsidian://open?vault=V&file=Note.md)",
    );
  });
});

describe("parseObsidianNoteUri", () => {
  it.each([
    ["obsidian://open?vault=V&file=Note", { vaultName: "V", file: "Note.md" }],
    ["OBSIDIAN://OPEN?file=nested%2FNote.md&vault=My%20Vault", { vaultName: "My Vault", file: "nested/Note.md" }],
    ["ObSiDiAn://OpEn?vault=V&file=Note.MD", { vaultName: "V", file: "Note.MD" }],
    ["obsidian://open?vault=V&file=Note.md.md", { vaultName: "V", file: "Note.md.md" }],
    ["obsidian://open?vault=V&file=nested%5Cdeeper%5CNote", { vaultName: "V", file: "nested/deeper/Note.md" }],
    ["obsidian://open?vault=V&file=nested/deeper/Note", { vaultName: "V", file: "nested/deeper/Note.md" }],
    ["obsidian://open?vault=V&file=nested\\deeper\\Note", { vaultName: "V", file: "nested/deeper/Note.md" }],
    ["obsidian://open?vault=V&file=%20Note%20", { vaultName: "V", file: " Note .md" }],
    ["obsidian://open?vault=My+Vault&file=a+b%2Bc.md", { vaultName: "My Vault", file: "a b+c.md" }],
    ["obsidian://open?vault=%20V%20&file=Note", { vaultName: " V ", file: "Note.md" }],
    ["obsidian://open?vault=V%23%5E%25&file=Note", { vaultName: "V#^%", file: "Note.md" }],
    ["obsidian://open?vault=Unknown&file=Note", { vaultName: "Unknown", file: "Note.md" }],
    ["obsidian://open?vault=V&file=a=b.md", { vaultName: "V", file: "a=b.md" }],
    ["obsidian://open?vault=V&file=not.markdown", { vaultName: "V", file: "not.markdown.md" }],
    ["obsidian://open?vault=V&file=%252e%252e%252fsecret", { vaultName: "V", file: "%2e%2e%2fsecret.md" }],
    ["obsidian://open?vault=V%2520Name&file=%2523%255e%2500.md", { vaultName: "V%20Name", file: "%23%5e%00.md" }],
    ["obsidian://open?vault=%E7%A0%94%E7%A9%B6%20%26%20%25&file=nested%2F%C3%A9%20%28draft%29%20%26%20%25.md", { vaultName: "研究 & %", file: "nested/é (draft) & %.md" }],
  ])("accepts the exact note target in %s", (href, target) => {
    expect(parseObsidianNoteUri(href)).toEqual(target);
  });

  it("round-trips a canonical reply destination without dropping a second .md", () => {
    const reply = obsidianReplyLink("My & 研究 Vault", "nested/é (draft) %.md.md", "[Literal] *title*");
    const href = reply.slice(reply.lastIndexOf("](") + 2, -1);
    expect(parseObsidianNoteUri(href)).toEqual({
      vaultName: "My & 研究 Vault",
      file: "nested/é (draft) %.md.md",
    });
  });

  it.each([
    "", "https://open?vault=V&file=Note", "obsidian:open?vault=V&file=Note", "obsidian:/open?vault=V&file=Note",
    "obsidian://other?vault=V&file=Note", "obsidian://open.example?vault=V&file=Note", "obsidian://op%65n?vault=V&file=Note",
    "obsidian://user@open?vault=V&file=Note", "obsidian://user:pass@open?vault=V&file=Note", "obsidian://open:80?vault=V&file=Note",
    "obsidian://open/?vault=V&file=Note", "obsidian://open/path?vault=V&file=Note", "obsidian://open\\?vault=V&file=Note",
    "obsidian://open?vault=V&file=Note#", "obsidian://open?vault=V&file=Note#heading", "obsidian://open?vault=V#name&file=Note",
    "obsidian://open", "obsidian://open?", "obsidian://open?vault=V", "obsidian://open?file=Note",
    "obsidian://open?path=Note&vault=V", "obsidian://open?vault=V&file=Note&path=Note", "obsidian://open?vault=V&file=Note&silent=true",
    "obsidian://open?vault=V&vault=W", "obsidian://open?file=Note&file=Other", "obsidian://open?vault=V&file=Note&file=Other",
    "obsidian://open?Vault=V&file=Note", "obsidian://open?vault=V&FILE=Note", "obsidian://open?%76ault=V&file=Note",
    "obsidian://open?vault=V&%66ile=Note", "obsidian://open?vault=V&file=", "obsidian://open?vault=&file=Note",
    "obsidian://open?vault=V&file", "obsidian://open?vault&file=Note", "obsidian://open?=V&file=Note",
    "obsidian://open?&vault=V&file=Note", "obsidian://open?vault=V&&file=Note", "obsidian://open?vault=V&file=Note&",
    "obsidian://open?vault=%20%20&file=Note", "obsidian://open?vault=+&file=Note", "obsidian://open?vault=%E3%80%80&file=Note",
  ])("rejects noncanonical authority or query structure in %s", (href) => {
    expect(parseObsidianNoteUri(href)).toBeNull();
  });

  it.each([" ", "\t", "\r", "\n", "\u0000", "\u001f", "\u007f", "\u00a0", "\u2003", "\ufeff"])(
    "rejects raw whitespace and controls %j without URL cleanup",
    (character) => {
      expect(parseObsidianNoteUri(`${character}obsidian://open?vault=V&file=Note`)).toBeNull();
      expect(parseObsidianNoteUri(`obsidian://open?vault=V${character}&file=Note`)).toBeNull();
      expect(parseObsidianNoteUri(`obsidian://open?vault=V&file=Note${character}`)).toBeNull();
    },
  );

  it.each(["%", "%0", "%GG", "%C3", "%C3%28", "%80", "%C0%AF", "%ED%A0%80", "%F4%90%80%80"])(
    "rejects malformed escaping or UTF-8 %s in either value",
    (value) => {
      expect(parseObsidianNoteUri(`obsidian://open?vault=V${value}&file=Note`)).toBeNull();
      expect(parseObsidianNoteUri(`obsidian://open?vault=V&file=Note${value}`)).toBeNull();
    },
  );

  it("rejects every ASCII control and DEL raw or decoded in either value", () => {
    for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
      const raw = String.fromCharCode(code);
      const encoded = `%${code.toString(16).padStart(2, "0")}`;
      for (const value of [raw, encoded]) {
        expect(parseObsidianNoteUri(`obsidian://open?vault=V${value}&file=Note`), `vault control ${code}`).toBeNull();
        expect(parseObsidianNoteUri(`obsidian://open?vault=V&file=Note${value}`), `file control ${code}`).toBeNull();
      }
    }
  });

  it.each([
    "/Note", "%2FNote", "%5CNote", "%2F%2Fserver%2FNote", "%5C%5Cserver%5CNote",
    "C:Note", "c%3A%2FNote", "Z%3A%5CNote", "nested//Note", "nested%2F%2FNote", "nested%5C%5CNote", "nested/", "nested%5C",
    ".", "..", "../Note", "%2E%2E%2FNote", ".hidden", "%2Ehidden", "nested/.hidden", "nested/./Note", "nested/../Note", "nested%5C..%5CNote",
    "Note%23heading", "Note%5Eblock", "nested%2F%23Note.md", "nested%2F%5ENote.md",
  ])("rejects unsafe or ambiguous vault-relative file %s", (file) => {
    expect(parseObsidianNoteUri(`obsidian://open?vault=V&file=${file}`)).toBeNull();
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
      adopted: ["a.md"],
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
        adopted: "a",
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
