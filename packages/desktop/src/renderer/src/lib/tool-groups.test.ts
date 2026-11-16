import { describe, expect, it } from "vitest";
import { readPathKey, toolGroupCategory, toolGroupCounts } from "./tool-groups";
import type { ToolItem } from "./transcript";

function tool(name: string, extra: Partial<ToolItem> = {}): ToolItem {
  return { kind: "tool", id: `${name}-1`, toolCallId: `${name}-1`, name, args: {}, status: "done", ...extra };
}

describe("toolGroupCategory", () => {
  it.each([
    ["read", "read"],
    ["grep", "search"],
    ["glob", "search"],
    ["find", "search"],
    ["ast_grep", "search"],
    ["web_search", "web"],
    ["omp-ui_vault_search", "vault"],
    ["omp-ui_vault_read", "vault"],
    ["omp-ui_vault_list", "vault"],
  ])("groups %s as %s", (name, category) => {
    expect(toolGroupCategory(tool(name))).toBe(category);
  });

  it.each(["bash", "edit", "task", "lsp", "omp-ui_vault_create", "readme", "constructor"])(
    "never groups %s",
    (name) => {
      expect(toolGroupCategory(tool(name))).toBeNull();
    },
  );

  it.each(["error", "aborted", "cancelled"] as const)("keeps a %s read on its own", (status) => {
    expect(toolGroupCategory(tool("read", { status }))).toBeNull();
  });

  it("groups a running read", () => {
    expect(toolGroupCategory(tool("read", { status: "running" }))).toBe("read");
  });

  it("keeps a read that carries notes, images, or replies on its own", () => {
    expect(toolGroupCategory(tool("read", { notes: [{ note: "check this" }] }))).toBeNull();
    expect(toolGroupCategory(tool("read", { images: [{ data: "x", mimeType: "image/png" }] }))).toBeNull();
    expect(toolGroupCategory(tool("read", { replies: ["hi"] }))).toBeNull();
  });

  it("keeps a web_search with provider failures on its own", () => {
    expect(
      toolGroupCategory(tool("web_search", { providerFailures: [{ provider: "p", label: "P", reason: "down" }] })),
    ).toBeNull();
  });
});

describe("readPathKey", () => {
  it.each([
    ["a.ts:194-215", "a.ts"],
    ["a.ts:50", "a.ts"],
    ["a.ts:50-", "a.ts"],
    ["a.ts:50+10", "a.ts"],
    ["a.ts:-60", "a.ts"],
    ["a.ts:5-16,960-973", "a.ts"],
    ["a.ts:raw", "a.ts"],
    ["a.ts:2-4:raw", "a.ts"],
    ["a.ts:raw:2-4", "a.ts"],
    ["a.ts:conflicts", "a.ts"],
    ["https://host/x.md:10-20", "https://host/x.md"],
  ])("strips the selector from %s", (path, key) => {
    expect(readPathKey(path)).toBe(key);
  });

  it.each([
    "https://host:8080",
    "https://host:8080/x",
    "https://host/search?q=foo:1",
    "schema/x.json?q={a:1}",
    "C:\\repo\\a.ts",
    "archive.zip:member/path.ts",
    "db.sqlite:table",
    "notes.txt",
  ])("leaves %s whole", (path) => {
    expect(readPathKey(path)).toBe(path);
  });
});

describe("toolGroupCounts", () => {
  it("counts distinct read files and search calls", () => {
    const items = [
      tool("read", { id: "r1", args: { path: "a.ts:1-5" } }),
      tool("read", { id: "r2", args: { path: "a.ts:9-20" } }),
      tool("read", { id: "r3", args: { path: "b.ts" } }),
      tool("grep", { id: "g1", args: { pattern: "x" } }),
      tool("glob", { id: "g2", args: { path: "*.ts" } }),
    ];
    expect(toolGroupCounts(items)).toEqual([
      { category: "read", count: 2 },
      { category: "search", count: 2 },
    ]);
  });

  it("lists categories in first-appearance order", () => {
    const items = [tool("grep", { id: "g1" }), tool("read", { id: "r1", args: { path: "a.ts" } })];
    expect(toolGroupCounts(items).map((c) => c.category)).toEqual(["search", "read"]);
  });

  it("falls back to item.path, then to the id, for reads without path args", () => {
    const items = [
      tool("read", { id: "r1", args: {}, path: "a.ts" }),
      tool("read", { id: "r2", args: { path: "a.ts:3" } }),
      tool("read", { id: "r3", args: {} }),
      tool("read", { id: "r4", args: {} }),
    ];
    expect(toolGroupCounts(items)).toEqual([{ category: "read", count: 3 }]);
  });
});
