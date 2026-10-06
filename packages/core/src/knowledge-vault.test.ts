import * as fs from "node:fs";
import * as asyncFs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as yaml from "js-yaml";
import { NOTE_BYTE_CAP, SEARCH_TEXT_CAP, normalizeTitle, resolveVaultPath, scanSecrets, validateVaultRoot, vaultAppend, vaultCreate, vaultEdit, vaultLink, vaultList, vaultRead, vaultSearch, type RootGuard, type VaultCallContext } from "./knowledge-vault";

// Keep real I/O while allowing deterministic filesystem failures and races.
vi.mock("node:fs", async (importOriginal) => ({ ...(await importOriginal<typeof fs>()) }));
vi.mock("node:fs/promises", async (importOriginal) => ({ ...(await importOriginal<typeof asyncFs>()) }));

let base: string;
let guard: RootGuard;

function mkdir(...segments: string[]): string {
  const dir = path.join(base, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

beforeEach(() => {
  // realpath so macOS's /var -> /private/var link never skews expectations.
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-kv-")));
  guard = {
    home: mkdir("home"),
    userData: mkdir("user-data"),
    agentDir: mkdir("agent"),
    sessionsRoot: mkdir("agent", "sessions"),
    archiveRoot: mkdir("archive"),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("validateVaultRoot", () => {
  it("refuses the home directory itself and a symlink pointing at it", async () => {
    const reason = `omp-ui cannot use ${guard.home} as a vault: it is your home directory`;
    expect(await validateVaultRoot(guard.home, guard)).toEqual({ ok: false, code: "refused", reason });
    const link = path.join(base, "home-link");
    fs.symlinkSync(guard.home, link);
    expect(await validateVaultRoot(link, guard)).toEqual({ ok: false, code: "refused", reason });
  });

  it("refuses the filesystem root", async () => {
    const root = path.parse(base).root;
    expect(await validateVaultRoot(root, guard)).toEqual({
      ok: false,
      code: "refused",
      reason: `omp-ui cannot use ${root} as a vault: it is the filesystem root`,
    });
  });

  it("refuses omp-ui's data folder itself and a child of it", async () => {
    const child = mkdir("user-data", "notes");
    for (const target of [guard.userData, child]) {
      expect(await validateVaultRoot(target, guard)).toEqual({
        ok: false,
        code: "refused",
        reason: `omp-ui cannot use ${target} as a vault: it is inside omp-ui's data folder`,
      });
    }
  });

  it("refuses children of the agent folder, sessions folder and session archive, naming the class", async () => {
    const agentChild = mkdir("agent", "skills");
    const sessionsChild = mkdir("agent", "sessions", "lineage");
    const archiveChild = mkdir("archive", "2026");
    expect(await validateVaultRoot(agentChild, guard)).toMatchObject({
      ok: false,
      code: "refused",
      reason: `omp-ui cannot use ${agentChild} as a vault: it is inside omp's agent folder`,
    });
    // sessionsRoot sits inside agentDir here, so the agent class answers first.
    expect(await validateVaultRoot(sessionsChild, guard)).toMatchObject({ ok: false, code: "refused" });
    const sessionsOnly: RootGuard = { ...guard, agentDir: path.join(base, "elsewhere") };
    expect(await validateVaultRoot(sessionsChild, sessionsOnly)).toEqual({
      ok: false,
      code: "refused",
      reason: `omp-ui cannot use ${sessionsChild} as a vault: it is inside omp's sessions folder`,
    });
    expect(await validateVaultRoot(archiveChild, guard)).toEqual({
      ok: false,
      code: "refused",
      reason: `omp-ui cannot use ${archiveChild} as a vault: it is inside omp's session archive`,
    });
  });

  it("refuses a child of a guard root whose spelling does not resolve on disk (resolved compare)", async () => {
    const child = mkdir("archive", "2026");
    // realpath fails on the missing "nope" segment; path.resolve still lands on <base>/archive.
    const unresolvable: RootGuard = { ...guard, archiveRoot: `${base}/nope/../archive` };
    expect(await validateVaultRoot(child, unresolvable)).toEqual({
      ok: false,
      code: "refused",
      reason: `omp-ui cannot use ${child} as a vault: it is inside omp's session archive`,
    });
  });

  it("ignores a guard root that does not exist for an unrelated folder", async () => {
    const vault = mkdir("vaults", "Notes");
    const missing: RootGuard = { ...guard, archiveRoot: path.join(base, "no-archive") };
    expect(await validateVaultRoot(vault, missing)).toEqual({ ok: true, real: vault });
  });

  it("accepts a plain folder without .obsidian/", async () => {
    const vault = mkdir("vaults", "Plain");
    expect(await validateVaultRoot(vault, guard)).toEqual({ ok: true, real: vault });
  });

  it("returns the realpath of a symlinked vault", async () => {
    const vault = mkdir("vaults", "Real");
    const link = path.join(base, "vault-link");
    fs.symlinkSync(vault, link);
    expect(await validateVaultRoot(link, guard)).toEqual({ ok: true, real: vault });
  });

  it("gives code unreachable for a missing path", async () => {
    expect(await validateVaultRoot(path.join(base, "gone"), guard)).toEqual({
      ok: false,
      code: "unreachable",
      reason: "vault folder is unreachable",
    });
  });
});

describe("resolveVaultPath", () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdir("vaults", "Notes");
  });

  it("refuses empty, absolute, drive, parent and hidden paths with the prototype's reasons", async () => {
    expect(await resolveVaultPath(vault, "")).toEqual({ ok: false, reason: "empty path" });
    expect(await resolveVaultPath(vault, "  ")).toEqual({ ok: false, reason: "empty path" });
    expect(await resolveVaultPath(vault, "/abs")).toEqual({ ok: false, reason: "absolute paths are refused: /abs" });
    expect(await resolveVaultPath(vault, "C:\\x")).toEqual({ ok: false, reason: "absolute paths are refused: C:\\x" });
    expect(await resolveVaultPath(vault, "../x")).toEqual({ ok: false, reason: '".." segments are refused: ../x' });
    expect(await resolveVaultPath(vault, ".obsidian/x.md")).toEqual({
      ok: false,
      reason: 'hidden segments (starting with ".") are refused: .obsidian/x.md',
    });
  });

  it("refuses a symlinked folder that points outside the root", async () => {
    const outside = mkdir("outside");
    fs.symlinkSync(outside, path.join(vault, "escape"));
    expect(await resolveVaultPath(vault, "escape/Note.md")).toEqual({
      ok: false,
      reason: "path leaves the vault: escape/Note.md",
    });
  });

  it("accepts a not-yet-existing leaf under an existing folder and normalizes separators", async () => {
    mkdir("vaults", "Notes", "omp-ui");
    expect(await resolveVaultPath(vault, "omp-ui/new/Note.md")).toEqual({
      ok: true,
      abs: path.join(vault, "omp-ui", "new", "Note.md"),
      rel: "omp-ui/new/Note.md",
    });
    expect(await resolveVaultPath(vault, "omp-ui\\\\Note.md")).toEqual({
      ok: true,
      abs: path.join(vault, "omp-ui", "Note.md"),
      rel: "omp-ui/Note.md",
    });
  });

  it("reports a removed root as unreachable", async () => {
    fs.rmSync(vault, { recursive: true, force: true });
    expect(await resolveVaultPath(vault, "Note.md")).toEqual({ ok: false, reason: "vault folder is unreachable" });
  });
});

describe("production vault tools", () => {
  let ctx: VaultCallContext;
  let root: string;
  const prefix = "---\r\nomp-ui: true\r\nforeign: keep me\r\n---\r\n";

  function put(rel: string, text: string | Buffer): string {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
    return abs;
  }
  function disk(rel: string): string { return fs.readFileSync(path.join(root, rel), "utf8"); }
  function diskHash(rel: string): string { return createHash("sha256").update(fs.readFileSync(path.join(root, rel))).digest("hex"); }

  beforeEach(() => {
    root = mkdir("vaults", "Notes");
    ctx = {
      entry: { name: "Notes", path: root, homeFolder: "omp-ui/", allowWritesOutsideHome: false },
      obsidianId: "0123456789abcdef",
      projectFolder: "my-project",
      projectName: 'My "Project"',
      lineage: "older/prefix/12345678-1234-5678-9012-123456789012",
      appVersion: "18.6.1",
      now: () => new Date(2026, 0, 2, 23, 59),
      guard,
    };
  });

  it("creates independently parsed stamps and an ordered, append-only Index", async () => {
    const first = await vaultCreate(ctx, { title: "  a   guide to API v2 omp-ui  ", body: "\n# A Guide to API v2 omp-ui\n\nFirst body", tags: ["alpha", "a: b", "", "   "] });
    expect(first.ok).toBe(true);
    const rel = "omp-ui/my-project/A Guide to API v2 omp-ui.md";
    expect(first.details).toMatchObject({ vaultName: "Notes", vaultId: ctx.obsidianId, action: "create", path: rel, title: "A Guide to API v2 omp-ui", createdByOmpUi: true, indexNotePath: "omp-ui/my-project/my-project Index.md", baseHash: diskHash(rel), collisions: [] });
    const text = disk(rel);
    expect(text.startsWith("---\nomp-ui: true\n")).toBe(true);
    const stamp = text.split("---\n")[1]!;
    expect(yaml.load(stamp)).toEqual({ "omp-ui": true, project: 'My "Project"', lineage: "12345678-1234-5678-9012-123456789012", date: new Date("2026-01-02T00:00:00.000Z"), tool: "omp-ui 18.6.1", tags: ["alpha", "a: b"] });
    expect(text).not.toContain("# A Guide");
    expect(first.details.preview).toBe("\n\nFirst body\n");
    const indexRel = "omp-ui/my-project/my-project Index.md";
    const indexBefore = disk(indexRel);
    expect(yaml.load(indexBefore.split("---\n")[1]!)).toMatchObject({ "omp-ui": true, tags: ["index"] });
    expect(indexBefore.endsWith("- [[omp-ui/my-project/A Guide to API v2 omp-ui|A Guide to API v2 omp-ui]]\n")).toBe(true);
    const second = await vaultCreate(ctx, { title: "second", body: "Second body" });
    expect(second.ok).toBe(true);
    expect(disk(indexRel)).toBe(`${indexBefore}- [[omp-ui/my-project/Second|Second]]\n`);
    expect(disk(indexRel).match(/^- \[\[/gm)).toHaveLength(2);
    expect(first.text).toContain("linked from [[omp-ui/my-project/my-project Index]].");
    expect(first.text).toContain("Link to it as [[omp-ui/my-project/A Guide to API v2 omp-ui|A Guide to API v2 omp-ui]].");
  });

  it("project:false omits project and Index while reporting basename collisions", async () => {
    put("elsewhere/Topic.md", "old");
    put("another/topic.MD", "old");
    const result = await vaultCreate({ ...ctx, projectFolder: null, projectName: null }, { title: "topic", body: "new" });
    expect(result.ok).toBe(true);
    expect(result.details.path).toBe("omp-ui/Topic.md");
    expect(result.details.indexNotePath).toBeUndefined();
    expect(result.details.collisions).toEqual(["another/topic.MD", "elsewhere/Topic.md"]);
    expect(yaml.load(disk("omp-ui/Topic.md").split("---\n")[1]!)).not.toHaveProperty("project");
    expect(fs.readdirSync(path.join(root, "omp-ui"))).toEqual(["Topic.md"]);
    expect(result.text).not.toContain("linked from");
    expect(result.text).toContain("another/topic.MD");
  });

  it("refuses leading frontmatter even after blanks and refuses the Index destination without writes", async () => {
    for (const body of ["---\nkey: value\n---\nbody", "\n\r\n  \n---\r\nkey: value\r\n---\r\nbody"]) {
      expect((await vaultCreate(ctx, { title: "topic", body })).text).toContain("omp-ui writes the frontmatter; send the body only");
    }
    expect((await vaultCreate(ctx, { title: "my-project Index", body: "body" })).text).toContain("the note destination is the project's Index note");
    expect(fs.existsSync(path.join(root, "omp-ui"))).toBe(false);
  });

  it("refuses an existing destination without suffixes or Index changes", async () => {
    put("omp-ui/my-project/Topic.md", "original");
    put("omp-ui/my-project/my-project Index.md", "foreign Index\r\n");
    const result = await vaultCreate(ctx, { title: "topic", body: "replace" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("note exists: omp-ui/my-project/Topic.md; use omp-ui_vault_append or omp-ui_vault_edit, or pick another title");
    expect(disk("omp-ui/my-project/Topic.md")).toBe("original");
    expect(disk("omp-ui/my-project/my-project Index.md")).toBe("foreign Index\r\n");
    expect(fs.readdirSync(path.join(root, "omp-ui/my-project"))).toEqual(["Topic.md", "my-project Index.md"]);
  });

  it("preserves a foreign CRLF Index byte-for-byte before appending its link", async () => {
    const foreign = "---\r\nauthor: someone else\r\n---\r\n# Index\r\nexisting\r\n";
    put("omp-ui/my-project/my-project Index.md", foreign);
    expect((await vaultCreate(ctx, { title: "topic", body: "body" })).ok).toBe(true);
    expect(disk("omp-ui/my-project/my-project Index.md")).toBe(`${foreign}- [[omp-ui/my-project/Topic|Topic]]\n`);
  });

  it("reads complete markdown, byte hashes and exact leading ownership without a text cap", async () => {
    const text = prefix + "body".repeat(20_000);
    put("omp-ui/Large.md", text);
    const result = await vaultRead(ctx, "omp-ui\\Large");
    expect(result.text).toBe(`Vault Notes · omp-ui/Large.md · baseHash ${diskHash("omp-ui/Large.md")}\n\n${text}`);
    expect(result.details).toMatchObject({ path: "omp-ui/Large.md", title: "Large", createdByOmpUi: true, baseHash: diskHash("omp-ui/Large.md") });
    for (const [name, text] of [["Elsewhere", "body\n---\nomp-ui: true\n---\n"], ["Quoted", '---\nomp-ui: "true"\n---\n'], ["Indented", "---\n omp-ui: true\n---\n"]]) {
      put(`${name}.md`, text!);
      expect((await vaultRead(ctx, name!)).details.createdByOmpUi).toBe(false);
    }
  });

  it("resolves only missing root titles, shortest path then lexical, while preferring explicit files", async () => {
    put("b/Topic.md", "b");
    put("a/Topic.md", "a");
    put("a/deeper/Topic.md", "deep");
    expect((await vaultRead(ctx, "tOpIc")).details.path).toBe("a/Topic.md");
    expect((await vaultRead(ctx, "a\\Topic")).details.path).toBe("a/Topic.md");
    expect((await vaultRead(ctx, "missing/Topic")).ok).toBe(false);
    expect((await vaultRead(ctx, "missing\\Topic")).ok).toBe(false);
    put("Topic.md", "root");
    expect((await vaultRead(ctx, "Topic")).details.path).toBe("Topic.md");
    ctx.entry.allowWritesOutsideHome = true;
    fs.unlinkSync(path.join(root, "Topic.md"));
    expect((await vaultAppend(ctx, "Topic", "not a title lookup")).ok).toBe(false);
    expect((await vaultEdit(ctx, "Topic", "not a title lookup", diskHash("a/Topic.md"))).ok).toBe(false);
    expect((await vaultLink(ctx, "Topic", "a/Topic", diskHash("a/Topic.md"))).ok).toBe(false);
    expect(disk("a/Topic.md")).toBe("a");
  });

  it.each([["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["gif", "image/gif"], ["webp", "image/webp"]])("reads %s images by full basename and preserves their MIME", async (ext, mime) => {
    const bytes = Buffer.from([0, 1, 2, 255]);
    put(`images/Picture.${ext}`, bytes);
    const result = await vaultRead(ctx, `picture.${ext}`);
    expect(result.ok).toBe(true);
    expect(result.image).toEqual({ data: bytes.toString("base64"), mimeType: mime });
    expect(result.details).toMatchObject({ path: `images/Picture.${ext}`, createdByOmpUi: null, baseHash: diskHash(`images/Picture.${ext}`) });
    expect(result.text).toBe(`Vault Notes · images/Picture.${ext} · baseHash ${diskHash(`images/Picture.${ext}`)}`);
  });

  it("refuses unsupported files and oversized images but accepts the exact image cap", async () => {
    put("file.txt", "text");
    expect((await vaultRead(ctx, "file.txt")).text).toContain("unsupported file type");
    put("limit.png", Buffer.alloc(1024 * 1024));
    expect((await vaultRead(ctx, "limit.png")).ok).toBe(true);
    put("limit.png", Buffer.alloc(1024 * 1024 + 1));
    expect((await vaultRead(ctx, "limit.png")).text).toContain("images must be at most 1 MiB");
  });

  it("allows confined visible explicit symlinks but refuses hidden and outside real targets", async () => {
    const visible = put("visible/Topic.md", "visible");
    const hidden = put(".trash/Topic.md", "hidden");
    fs.symlinkSync(visible, path.join(root, "Alias.md"));
    fs.symlinkSync(hidden, path.join(root, "Hidden.md"));
    fs.symlinkSync(mkdir("outside"), path.join(root, "Outside"));
    expect((await vaultRead(ctx, "Alias")).ok).toBe(true);
    expect((await resolveVaultPath(root, "Hidden.md")).ok).toBe(false);
    expect((await vaultRead(ctx, "Hidden")).text).toContain("hidden real targets are refused");
    expect((await vaultRead(ctx, "Outside/Topic")).text).toContain("path leaves the vault");
    fs.symlinkSync(path.join(root, ".trash"), path.join(root, "HiddenDir"));
    expect((await resolveVaultPath(root, "HiddenDir/new/Note.md")).ok).toBe(false);
    fs.symlinkSync(path.join(root, "missing"), path.join(root, "Dangling"));
    expect((await resolveVaultPath(root, "Dangling/Note.md")).ok).toBe(false);
  });

  it("does not treat ENOTDIR or permission errors as a missing ancestor", async () => {
    put("leaf.md", "not a folder");
    expect((await resolveVaultPath(root, "leaf.md/child/Note.md"))).toMatchObject({ ok: false });
    const original = fs.realpathSync;
    vi.spyOn(fs, "realpathSync").mockImplementation((...args: Parameters<typeof fs.realpathSync>) => {
      if (String(args[0]).endsWith("denied")) throw Object.assign(new Error("not for output"), { code: "EACCES" });
      return original(...args);
    });
    const result = await resolveVaultPath(root, "denied/new.md");
    expect(result).toEqual({ ok: false, reason: "cannot resolve denied/new.md: EACCES" });
  });

  it("enforces lexical and prospective home confinement, including home-to-sibling symlinks", async () => {
    put("sibling/Note.md", "sibling");
    const outside = await vaultAppend(ctx, "sibling/Note", "no");
    expect(outside.text).toContain("omp-ui writes only inside omp-ui/ in vault Notes; sibling/Note.md is outside it");
    expect(fs.existsSync(path.join(root, "omp-ui"))).toBe(false);
    fs.symlinkSync(path.join(root, "sibling"), path.join(root, "omp-ui"));
    expect((await vaultAppend(ctx, "omp-ui/Note", "no")).ok).toBe(false);
    expect((await vaultCreate(ctx, { title: "new", body: "no" })).ok).toBe(false);
    expect(disk("sibling/Note.md")).toBe("sibling");
    expect(fs.existsSync(path.join(root, "sibling/my-project"))).toBe(false);
  });

  it("widens only explicit existing writes, never create or hidden/vault confinement", async () => {
    ctx.entry.allowWritesOutsideHome = true;
    put("sibling/Note.md", "original");
    expect((await vaultAppend(ctx, "sibling/Note", "append")).ok).toBe(true);
    expect((await vaultEdit(ctx, "sibling/Note", "edited", diskHash("sibling/Note.md"))).ok).toBe(true);
    put("Target.md", "target");
    expect((await vaultLink(ctx, "sibling/Note", "Target", diskHash("sibling/Note.md"))).ok).toBe(true);
    expect((await vaultAppend(ctx, ".hidden/Note", "no")).ok).toBe(false);
    fs.symlinkSync(mkdir("outside"), path.join(root, "escape"));
    expect((await vaultAppend(ctx, "escape/Note", "no")).ok).toBe(false);
    fs.symlinkSync(path.join(root, "sibling"), path.join(root, "omp-ui"));
    expect((await vaultCreate(ctx, { title: "new", body: "no" })).ok).toBe(false);
    expect(fs.existsSync(path.join(root, "sibling/my-project/New.md"))).toBe(false);
  });

  it("preflights the Index before creating any directories or note", async () => {
    fs.mkdirSync(path.join(root, "omp-ui/my-project"), { recursive: true });
    fs.symlinkSync(mkdir("outside"), path.join(root, "omp-ui/my-project/my-project Index.md"));
    const result = await vaultCreate(ctx, { title: "new", body: "no" });
    expect(result.ok).toBe(false);
    expect(fs.existsSync(path.join(root, "omp-ui/my-project/New.md"))).toBe(false);
  });

  it("rechecks leaves after mkdir and refuses swaps before creating the note", async () => {
    const original = fs.mkdirSync;
    const outside = path.join(mkdir("outside"), "Index.md");
    fs.writeFileSync(outside, "outside");
    vi.spyOn(fs, "mkdirSync").mockImplementation((...args: Parameters<typeof fs.mkdirSync>) => {
      const result = original(...args);
      if (String(args[0]) === path.join(root, "omp-ui/my-project")) fs.symlinkSync(outside, path.join(root, "omp-ui/my-project/my-project Index.md"));
      return result;
    });
    expect((await vaultCreate(ctx, { title: "new", body: "body" })).ok).toBe(false);
    expect(fs.existsSync(path.join(root, "omp-ui/my-project/New.md"))).toBe(false);
    expect(fs.readFileSync(outside, "utf8")).toBe("outside");
  });

  it("reports a created note and failed Index update with the known path", async () => {
    put("omp-ui/my-project/my-project Index.md", "foreign\n");
    vi.spyOn(fs, "appendFileSync").mockImplementation(() => { throw Object.assign(new Error("private path /do/not/leak"), { code: "EACCES" }); });
    const result = await vaultCreate(ctx, { title: "topic", body: "body" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("note created: omp-ui/my-project/Topic.md; Index update failed: omp-ui/my-project/my-project Index.md (EACCES)");
    expect(result.text).not.toContain("/do/not/leak");
    expect(result.details).toMatchObject({ path: "omp-ui/my-project/Topic.md", baseHash: diskHash("omp-ui/my-project/Topic.md"), createdByOmpUi: true });
    expect(disk("omp-ui/my-project/my-project Index.md")).toBe("foreign\n");
  });

  it("append preserves every original CRLF byte and ensures blank separation", async () => {
    const before = `${prefix}body\r\n`;
    put("omp-ui/Note.md", before);
    const result = await vaultAppend(ctx, "omp-ui/Note", "addition  \n\n");
    expect(result.ok).toBe(true);
    expect(disk("omp-ui/Note.md")).toBe(`${before}\naddition\n`);
    expect(result.details).toMatchObject({ preview: "addition", title: "Note", createdByOmpUi: true, baseHash: diskHash("omp-ui/Note.md") });
    put("omp-ui/Plain.md", "plain");
    expect((await vaultAppend(ctx, "omp-ui/Plain", "tail")).details.createdByOmpUi).toBe(false);
    expect(disk("omp-ui/Plain.md")).toBe("plain\n\ntail\n");
  });

  it("edit keeps the exact frontmatter prefix, preserves mode and reports a numbered diff", async () => {
    const abs = put("omp-ui/Note.md", `${prefix}before\r\n`);
    fs.chmodSync(abs, 0o640);
    const result = await vaultEdit(ctx, "omp-ui/Note", "after\n", diskHash("omp-ui/Note.md"));
    expect(result.ok).toBe(true);
    expect(disk("omp-ui/Note.md")).toBe(`${prefix}after\n`);
    expect(fs.statSync(abs).mode & 0o777).toBe(0o640);
    expect(result.details.diff).toContain("-5|before");
    expect(result.details.diff).toContain("+5|after");
    expect(result.details).toMatchObject({ createdByOmpUi: true, baseHash: diskHash("omp-ui/Note.md") });
    put("omp-ui/Plain.md", "plain");
    const plain = await vaultEdit(ctx, "omp-ui/Plain", "unstamped", diskHash("omp-ui/Plain.md"));
    expect(plain.details.createdByOmpUi).toBe(false);
    expect(disk("omp-ui/Plain.md")).toBe("unstamped");
  });

  it("refuses stale hashes and supplied frontmatter without changing a source or Index", async () => {
    put("omp-ui/Note.md", `${prefix}original\r\n`);
    put("omp-ui/my-project/my-project Index.md", "Index");
    put("Target.md", "target");
    const before = disk("omp-ui/Note.md");
    expect((await vaultEdit(ctx, "omp-ui/Note", "changed", "wrong")).text).toContain("omp-ui/Note.md changed since you read it; read it again before editing");
    expect((await vaultLink(ctx, "omp-ui/Note", "Target", "wrong")).ok).toBe(false);
    expect((await vaultEdit(ctx, "omp-ui/Note", "\n---\nkey: value\n---\n", diskHash("omp-ui/Note.md"))).text).toContain("omp-ui writes the frontmatter; send the body only");
    expect(disk("omp-ui/Note.md")).toBe(before);
    expect(disk("omp-ui/my-project/my-project Index.md")).toBe("Index");
  });

  it("does not truncate on rename failure or clobber a symlinked atomic temporary", async () => {
    put("omp-ui/Note.md", "before");
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw Object.assign(new Error("no"), { code: "EPERM" }); });
    expect((await vaultEdit(ctx, "omp-ui/Note", "after", diskHash("omp-ui/Note.md"))).ok).toBe(false);
    expect(disk("omp-ui/Note.md")).toBe("before");
    rename.mockRestore();
    const outside = path.join(mkdir("outside"), "private.md");
    fs.writeFileSync(outside, "private");
    fs.symlinkSync(outside, `${path.join(root, "omp-ui/Note.md")}.tmp-${process.pid}`);
    expect((await vaultEdit(ctx, "omp-ui/Note", "after", diskHash("omp-ui/Note.md"))).ok).toBe(false);
    expect(disk("omp-ui/Note.md")).toBe("before");
    expect(fs.readFileSync(outside, "utf8")).toBe("private");
  });

  it("links stamped paths, unique foreign basenames and duplicate foreign path aliases", async () => {
    put("omp-ui/Source.md", `${prefix}source\r\n`);
    put("z/Stamped.md", `${prefix}target`);
    put("z/Unique.md", "foreign");
    put("a/Duplicate.md", "foreign");
    put("z/Duplicate.md", "foreign");
    const first = await vaultLink(ctx, "omp-ui/Source", "stamped", diskHash("omp-ui/Source.md"));
    expect(first.ok).toBe(true);
    expect(disk("omp-ui/Source.md")).toBe(`${prefix}source\r\n\n- [[z/Stamped|Stamped]]\n`);
    expect(first.details.diff).toContain("+7|- [[z/Stamped|Stamped]]");
    expect((await vaultLink(ctx, "omp-ui/Source", "Unique", diskHash("omp-ui/Source.md"))).ok).toBe(true);
    expect(disk("omp-ui/Source.md")).toContain("\n- [[Unique]]\n");
    const last = await vaultLink(ctx, "omp-ui/Source", "Duplicate", diskHash("omp-ui/Source.md"));
    expect(last.ok).toBe(true);
    expect(disk("omp-ui/Source.md")).toContain("\n- [[a/Duplicate|Duplicate]]\n");
    expect(last.details).toMatchObject({ title: "Source", createdByOmpUi: true, baseHash: diskHash("omp-ui/Source.md") });
    const before = disk("omp-ui/Source.md");
    expect((await vaultLink(ctx, "omp-ui/Source", "absent", diskHash("omp-ui/Source.md"))).text).toContain("link target not found: absent");
    expect(disk("omp-ui/Source.md")).toBe(before);
  });

  it("searches YAML values recursively, not keys/folders, and hides frontmatter excerpts", async () => {
    put("folderonly/Topic.md", '---\nkeyonly: scalarvalue\nlist: [listvalue, "quoted: value"]\nblock: |\n  blockvalue\nnested:\n  inner: nestedvalue\nanchor: &anchor [aliasvalue]\nalias: *anchor\nrecursive: &recursive [*recursive]\n---\nbodyvalue\nsecond bodyvalue\n');
    for (const query of ["scalarvalue", "listvalue", "quoted:", "blockvalue", "nestedvalue", "aliasvalue", "Topic scalarvalue bodyvalue"]) {
      const result = await vaultSearch(ctx, query, undefined);
      expect(result.details.matchedFiles).toBe(1);
      expect(result.text).not.toContain("keyonly:");
      expect(result.text).not.toContain("nested:");
    }
    for (const query of ["keyonly", "folderonly", "inner", "recursive"]) expect((await vaultSearch(ctx, query, undefined)).details.matchedFiles).toBe(0);
    const body = await vaultSearch(ctx, "bodyvalue", undefined);
    expect(body.text).toContain("L12: bodyvalue");
    expect(body.text).toContain("L13: second bodyvalue");
    put("Malformed.md", "---\nprivate: [invalid\n---\npublicbody\n");
    expect((await vaultSearch(ctx, "invalid", undefined)).details.matchedFiles).toBe(0);
    expect((await vaultSearch(ctx, "publicbody", undefined)).details.matchedFiles).toBe(1);
  });

  it("sorts search by title and matching body-line scores, caps snippets and counts over fifty matches", async () => {
    put("Needle.md", "no body matches");
    put("Body.md", "needle\nneedle\nneedle\nneedle\n");
    for (let i = 0; i < 55; i++) put(`many/N${String(i).padStart(2, "0")}.md`, "needle\n");
    put(".trash/Needle.md", "needle");
    put("Oversize.md", `needle${"x".repeat(NOTE_BYTE_CAP)}`);
    fs.symlinkSync(path.join(root, "Body.md"), path.join(root, "Alias.md"));
    const result = await vaultSearch(ctx, "needle", 50);
    expect(result.details).toMatchObject({ matchedFiles: 57, returnedFiles: 50, truncated: true, path: null, createdByOmpUi: null });
    expect(result.text).toContain('Vault Notes: 57 notes match "needle" (showing 50).');
    expect(result.text.indexOf("`Needle.md`")).toBeLessThan(result.text.indexOf("`Body.md`"));
    expect(result.text.indexOf("`Body.md`")).toBeLessThan(result.text.indexOf("`many/N00.md`"));
    expect(result.text).toContain("L3: needle");
    expect(result.text).not.toContain("L4: needle");
    expect(result.text).not.toContain(".trash");
    expect(result.text).not.toContain("Oversize");
    expect(result.text).not.toContain("Alias");
    expect(result.text).toContain("… truncated; showing 50 of 57 notes.");
    expect((await vaultSearch(ctx, "needle", undefined)).details.returnedFiles).toBe(10);
  });

  it("bounds whole search/list rows with accurate counts and reserved truncation tails", async () => {
    const folder = `omp-ui/${"f".repeat(180)}`;
    const long = "n".repeat(180);
    for (let i = 0; i < 90; i++) put(`${folder}/${String(i).padStart(2, "0")}${long}.md`, `needle ${"x".repeat(220)}\nneedle ${"y".repeat(220)}\nneedle ${"z".repeat(220)}\n`);
    const search = await vaultSearch(ctx, "needle", 50);
    expect(search.text.length).toBeLessThanOrEqual(SEARCH_TEXT_CAP);
    const searchRows = search.text.split("\n").filter((line) => line.startsWith("- [["));
    expect(searchRows.length).toBe(search.details.returnedFiles);
    expect(search.details.returnedFiles).toBeLessThan(50);
    expect(search.text).toContain(`(showing ${searchRows.length}).`);
    expect(search.text).toContain(`showing ${searchRows.length} of 90 notes.`);
    expect(search.text).toContain(`${"x".repeat(193)}…`);
    const list = await vaultList(ctx, undefined);
    const listRows = list.text.split("\n").filter((line) => line.startsWith("- "));
    expect(list.text.length).toBeLessThanOrEqual(SEARCH_TEXT_CAP);
    expect(list.details).toMatchObject({ path: "omp-ui", action: "list", createdByOmpUi: null, matchedFiles: 90, returnedFiles: listRows.length, truncated: true });
    expect(list.text).toContain(`showing ${listRows.length} of 90 notes.`);
    expect(listRows.every((row) => row.endsWith(".md"))).toBe(true);
  });

  it("lists existing directories recursively in lexical order without hidden files or symlinks", async () => {
    put("omp-ui/z/Last.md", "last");
    put("omp-ui/a/First.md", "first");
    put("omp-ui/Middle.md", "middle");
    put("omp-ui/.trash/Hidden.md", "hidden");
    put("omp-ui/Image.png", "image");
    fs.symlinkSync(path.join(root, "omp-ui/a"), path.join(root, "omp-ui/alias"));
    expect((await vaultList(ctx, undefined)).text).toBe("Vault Notes · omp-ui: 3 notes\n- omp-ui/Middle.md\n- omp-ui/a/First.md\n- omp-ui/z/Last.md");
    expect((await vaultList(ctx, "omp-ui\\a")).details.path).toBe("omp-ui/a");
    expect((await vaultList(ctx, "missing")).ok).toBe(false);
    expect((await vaultList(ctx, "omp-ui/Middle.md")).ok).toBe(false);
  });

  it("returns unreachable failures from all seven operations after the root is removed", async () => {
    fs.rmSync(root, { recursive: true });
    const results = await Promise.all([vaultSearch(ctx, "query", undefined), vaultRead(ctx, "Note"), vaultList(ctx, undefined), vaultCreate(ctx, { title: "Note", body: "body" }), vaultAppend(ctx, "Note", "body"), vaultEdit(ctx, "Note", "body", "hash"), vaultLink(ctx, "Note", "Target", "hash")]);
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.text).toContain("vault Notes is unreachable");
      expect(result.text).not.toContain(root);
    }
    const refused = await vaultRead({ ...ctx, entry: { ...ctx.entry, path: guard.home } }, "Note");
    expect(refused.text).toContain("your home directory");
    expect(refused.text).not.toContain(guard.home);
  });

  const secrets = [
    ["openai-key", `sk-${"a".repeat(20)}`],
    ["github-token", `ghp_${"a".repeat(36)}`],
    ["github-pat", `github_pat_${"a".repeat(22)}`],
    ["aws-access-key", `AKIA${"A".repeat(16)}`],
    ["google-api-key", `AIza${"a".repeat(35)}`],
    ["slack-token", `xoxb-${"a".repeat(10)}`],
    ["jwt", `eyJ${"a".repeat(10)}.eyJ${"b".repeat(10)}.${"c".repeat(10)}`],
  ];
  it.each(secrets)("refuses %s on create/append/edit with no mutation or leaked value", async (id, secret) => {
    put("omp-ui/Note.md", `${prefix}original\n`);
    put("omp-ui/my-project/my-project Index.md", "Index\n");
    const results = [await vaultCreate(ctx, { title: "New", body: secret! }), await vaultAppend(ctx, "omp-ui/Note", secret!), await vaultEdit(ctx, "omp-ui/Note", secret!, diskHash("omp-ui/Note.md"))];
    expect(scanSecrets(secret!)).toBe(id);
    expect(scanSecrets(secret!)).toBe(id);
    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(result.text).toContain(`refused: the text matches the ${id} secret shape; omp-ui never writes keys or tokens to a vault`);
      expect(JSON.stringify(result)).not.toContain(secret!);
    }
    expect(disk("omp-ui/Note.md")).toBe(`${prefix}original\n`);
    expect(disk("omp-ui/my-project/my-project Index.md")).toBe("Index\n");
    expect(fs.existsSync(path.join(root, "omp-ui/my-project/New.md"))).toBe(false);
  });

  it("checks composed links and Index secrets and chooses the first shape before size", async () => {
    const secret = `sk-${"a".repeat(20)}`;
    put("omp-ui/Source.md", "source\n");
    put(`${secret}.md`, "target");
    const link = await vaultLink(ctx, "omp-ui/Source", secret, diskHash("omp-ui/Source.md"));
    expect(link.text).toContain("openai-key secret shape");
    expect(JSON.stringify(link)).not.toContain(secret);
    expect(disk("omp-ui/Source.md")).toBe("source\n");
    put("omp-ui/my-project/my-project Index.md", `${secret}\n`);
    expect((await vaultCreate(ctx, { title: "new", body: "safe" })).text).toContain("openai-key secret shape");
    expect(fs.existsSync(path.join(root, "omp-ui/my-project/New.md"))).toBe(false);
    expect((await vaultCreate(ctx, { title: "new", body: `ghp_${"b".repeat(36)} ${secret}${"x".repeat(NOTE_BYTE_CAP)}` })).text).toContain("openai-key secret shape");
    expect(scanSecrets("Prefix prose sk- and ghp_ and AKIA and AIza and xoxb- and eyJ")).toBeNull();
    fs.unlinkSync(path.join(root, "omp-ui/my-project/my-project Index.md"));
    expect((await vaultCreate(ctx, { title: "safe", body: "Prefix prose sk- and ghp_" })).ok).toBe(true);
  });

  it("accepts exactly 2 MiB of stamped UTF-8 and refuses the next byte, including multibyte bodies", async () => {
    const noProject = { ...ctx, projectFolder: null, projectName: null };
    const seed = await vaultCreate(noProject, { title: "Seed", body: "" });
    expect(seed.ok).toBe(true);
    const overhead = Buffer.byteLength(disk("omp-ui/Seed.md"));
    const bodyBytes = NOTE_BYTE_CAP - overhead;
    const exact = "é".repeat(Math.floor(bodyBytes / 2)) + (bodyBytes % 2 ? "x" : "");
    expect((await vaultCreate(noProject, { title: "Exact", body: exact })).ok).toBe(true);
    expect(fs.statSync(path.join(root, "omp-ui/Exact.md")).size).toBe(NOTE_BYTE_CAP);
    const tooLarge = await vaultCreate(noProject, { title: "Large", body: `${exact}x` });
    expect(tooLarge.ok).toBe(false);
    expect(fs.existsSync(path.join(root, "omp-ui/Large.md"))).toBe(false);
    put("omp-ui/Editable.md", "a");
    expect((await vaultEdit(ctx, "omp-ui/Editable", "é".repeat(NOTE_BYTE_CAP / 2), diskHash("omp-ui/Editable.md"))).ok).toBe(true);
    expect((await vaultEdit(ctx, "omp-ui/Editable", `${"é".repeat(NOTE_BYTE_CAP / 2)}x`, diskHash("omp-ui/Editable.md"))).ok).toBe(false);
    put("omp-ui/Append.md", "x".repeat(NOTE_BYTE_CAP - 4));
    expect((await vaultAppend(ctx, "omp-ui/Append", "a")).ok).toBe(true);
    expect(fs.statSync(path.join(root, "omp-ui/Append.md")).size).toBe(NOTE_BYTE_CAP);
    expect((await vaultAppend(ctx, "omp-ui/Append", "a")).ok).toBe(false);
  });

  it("preflights composed Index bytes at the exact cap and one byte past it", async () => {
    const indexRel = "omp-ui/my-project/my-project Index.md";
    const line = "- [[omp-ui/my-project/Exact|Exact]]\n";
    const before = `${"x".repeat(NOTE_BYTE_CAP - Buffer.byteLength(line) - 1)}\n`;
    put(indexRel, before);
    expect((await vaultCreate(ctx, { title: "Exact", body: "small" })).ok).toBe(true);
    expect(fs.statSync(path.join(root, indexRel)).size).toBe(NOTE_BYTE_CAP);
    const overflow = await vaultCreate(ctx, { title: "Next", body: "small" });
    expect(overflow.ok).toBe(false);
    expect(fs.existsSync(path.join(root, "omp-ui/my-project/Next.md"))).toBe(false);
    expect(disk(indexRel)).toBe(before + line);
  });

  it("enforces win32 note and first-use Index path length before mkdir, restoring the platform", async () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { value: "win32" });
      const noProject = { ...ctx, projectFolder: null, projectName: null };
      const fixed = root.length + "/omp-ui/".length + ".md".length;
      const segments = ["s".repeat(80), "t".repeat(80)];
      const longHome = `${segments.join("/")}/`;
      const longCtx = { ...noProject, entry: { ...ctx.entry, homeFolder: longHome } };
      const fixedLong = root.length + 1 + longHome.length + ".md".length;
      const atLimit = "N".repeat(259 - fixedLong);
      expect(atLimit.length).toBeGreaterThan(0);
      expect((await vaultCreate(longCtx, { title: atLimit, body: "body" })).ok).toBe(true);
      const over = await vaultCreate(longCtx, { title: `${atLimit}x`, body: "body" });
      expect(over.text).toContain("the note path would be longer than Windows allows (260 characters)");
      expect(fs.existsSync(path.join(root, longHome, `${atLimit}x.md`))).toBe(false);
      const projectFolder = "p".repeat(Math.ceil((260 - fixed) / 2));
      const indexCtx = { ...ctx, projectFolder };
      const indexResult = await vaultCreate(indexCtx, { title: "A", body: "body" });
      expect(indexResult.text).toContain("the note path would be longer than Windows allows (260 characters)");
      expect(fs.existsSync(path.join(root, "omp-ui", projectFolder))).toBe(false);
    } finally { Object.defineProperty(process, "platform", descriptor); }
  });

  it("strips only the first matching heading and uses one local creation date for note and Index", async () => {
    const now = vi.fn(() => new Date(2026, 1, 3, 23, 59));
    const result = await vaultCreate({ ...ctx, now }, { title: "topic", body: "\n# topic\n# Topic\nbody" });
    expect(result.ok).toBe(true);
    expect(result.details.preview).toBe("\n# Topic\nbody\n");
    expect(now).toHaveBeenCalledTimes(1);
    expect(disk("omp-ui/my-project/Topic.md")).toContain("date: 2026-02-03\n");
    expect(disk("omp-ui/my-project/my-project Index.md")).toContain("date: 2026-02-03\n");
  });

  it("preserves arbitrary original append bytes and hashes actual disk bytes", async () => {
    const before = Buffer.from([0xff, 0xfe, 0x61]);
    put("omp-ui/Bytes.md", before);
    const result = await vaultAppend(ctx, "omp-ui/Bytes", "tail");
    expect(result.ok).toBe(true);
    expect(fs.readFileSync(path.join(root, "omp-ui/Bytes.md"))).toEqual(Buffer.concat([before, Buffer.from("\n\ntail\n")]));
    expect(result.details.baseHash).toBe(diskHash("omp-ui/Bytes.md"));
  });

  it("skips vanished search notes and runs at most 64 note reads concurrently", async () => {
    for (let i = 0; i < 80; i++) put(`N${String(i).padStart(2, "0")}.md`, "needle");
    const original = asyncFs.readFile;
    let active = 0;
    let peak = 0;
    vi.spyOn(asyncFs, "readFile").mockImplementation(async (...args: Parameters<typeof asyncFs.readFile>) => {
      if (String(args[0]).endsWith("N00.md")) throw Object.assign(new Error("vanished"), { code: "ENOENT" });
      active++;
      peak = Math.max(peak, active);
      try {
        await new Promise<void>((resolve) => setImmediate(resolve));
        return await original(...args);
      } finally { active--; }
    });
    const result = await vaultSearch(ctx, "needle", 50);
    expect(result.ok).toBe(true);
    expect(result.details.matchedFiles).toBe(79);
    expect(peak).toBe(64);
    expect(active).toBe(0);
    expect(result.text).not.toContain("N00.md");
  });

  it("keeps the lexical home gate before secret and size refusals", async () => {
    put("outside/Note.md", "unchanged");
    const body = `sk-${"a".repeat(20)}${"x".repeat(NOTE_BYTE_CAP)}`;
    const result = await vaultAppend(ctx, "outside/Note", body);
    expect(result.text).toContain("omp-ui writes only inside omp-ui/ in vault Notes; outside/Note.md is outside it");
    expect(result.text).not.toContain("secret shape");
    expect(disk("outside/Note.md")).toBe("unchanged");
    expect(fs.existsSync(path.join(root, "omp-ui"))).toBe(false);
  });

  it("edits a confined home alias atomically without replacing the alias", async () => {
    const target = put("omp-ui/real/Target.md", `${prefix}before\r\n`);
    const alias = path.join(root, "omp-ui/Alias.md");
    fs.symlinkSync(target, alias);
    const read = await vaultRead(ctx, "omp-ui/Alias");
    const result = await vaultEdit(ctx, "omp-ui/Alias", "after\n", read.details.baseHash!);
    expect(result.ok).toBe(true);
    expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, "utf8")).toBe(`${prefix}after\n`);
    expect(result.details.baseHash).toBe(diskHash("omp-ui/real/Target.md"));
  });

  it("preserves raw foreign Index bytes when appending a newly created note", async () => {
    const foreign = Buffer.from([0xff, 0xfe, 0x61]);
    const rel = "omp-ui/my-project/my-project Index.md";
    put(rel, foreign);
    expect((await vaultCreate(ctx, { title: "topic", body: "body" })).ok).toBe(true);
    expect(fs.readFileSync(path.join(root, rel))).toEqual(Buffer.concat([foreign, Buffer.from("\n- [[omp-ui/my-project/Topic|Topic]]\n")]));
  });

  it("preserves foreign CRLF frontmatter across append, edit and link without stamping it", async () => {
    const foreign = "---\r\nauthor: somebody else\r\n---\r\n";
    put("omp-ui/Foreign.md", `${foreign}original\r\n`);
    put("Target.md", "target");
    const append = await vaultAppend(ctx, "omp-ui/Foreign", "tail");
    expect(append.details.createdByOmpUi).toBe(false);
    expect(disk("omp-ui/Foreign.md")).toBe(`${foreign}original\r\n\ntail\n`);
    const edit = await vaultEdit(ctx, "omp-ui/Foreign", "replacement\r\n", diskHash("omp-ui/Foreign.md"));
    expect(edit.details.createdByOmpUi).toBe(false);
    expect(disk("omp-ui/Foreign.md")).toBe(`${foreign}replacement\r\n`);
    const link = await vaultLink(ctx, "omp-ui/Foreign", "Target", diskHash("omp-ui/Foreign.md"));
    expect(link.details.createdByOmpUi).toBe(false);
    expect(disk("omp-ui/Foreign.md")).toBe(`${foreign}replacement\r\n\n- [[Target]]\n`);
    expect(disk("omp-ui/Foreign.md")).not.toContain("omp-ui:");
  });

  it("confines a prospective missing home below its unresolved suffix, not its vault ancestor", async () => {
    const sibling = mkdir("vaults", "Notes", "sibling");
    fs.symlinkSync(sibling, path.join(root, "Alias"));
    const missingHome = { ...ctx, entry: { ...ctx.entry, homeFolder: "Alias/future/home/" } };
    const result = await vaultCreate(missingHome, { title: "topic", body: "body" });
    expect(result.ok).toBe(false);
    expect(result.text).toContain("omp-ui writes only inside Alias/future/home/ in vault Notes");
    expect(fs.existsSync(path.join(sibling, "future"))).toBe(false);
    const regularHome = { ...ctx, entry: { ...ctx.entry, homeFolder: "future/home/" } };
    expect((await vaultCreate(regularHome, { title: "topic", body: "body" })).ok).toBe(true);
    expect(fs.existsSync(path.join(root, "future/home/my-project/Topic.md"))).toBe(true);
  });

  it("gates on the hash of actual current disk bytes after a previously successful read", async () => {
    put("omp-ui/Note.md", `${prefix}old\r\n`);
    put("Target.md", "target");
    const read = await vaultRead(ctx, "omp-ui/Note");
    put("omp-ui/Note.md", `${prefix}external change\r\n`);
    const edit = await vaultEdit(ctx, "omp-ui/Note", "replace", read.details.baseHash!);
    const link = await vaultLink(ctx, "omp-ui/Note", "Target", read.details.baseHash!);
    expect(edit.ok).toBe(false);
    expect(link.ok).toBe(false);
    expect(edit.text).toContain("changed since you read it; read it again before editing");
    expect(disk("omp-ui/Note.md")).toBe(`${prefix}external change\r\n`);
  });
});

describe("normalizeTitle", () => {
  it("collapses whitespace and preserves mixed-case, acronyms, date and version tokens", () => {
    expect(normalizeTitle("  the\nAPI and a guide to omp-ui v2 2026-01-02 iPhone vs HTTP ")).toEqual({ ok: true, title: "The API and a Guide to omp-ui v2 2026-01-02 iPhone vs HTTP" });
    expect(normalizeTitle("via the and an a as at but by for in of on or to vs guide")).toEqual({ ok: true, title: "Via the and an a as at but by for in of on or to vs Guide" });
  });
  it.each(["CON", "con.txt", "PrN", "AUX.more", "nul", "COM1", "com9.txt", "LPT1", "lpt9.md", ".hidden", "trailing.", ...'/\\:*?"<>|#^[]'.split("").map((char) => `a${char}b`)])("refuses illegal title %s", (title) => {
    expect(normalizeTitle(title)).toMatchObject({ ok: false, reason: 'title must not contain / \\ : * ? " < > | # ^ [ ], start with a dot, or be a reserved Windows name' });
  });
  it("accepts 120 characters and nonreserved lookalikes, refusing blank and overlong titles", () => {
    expect(normalizeTitle("x".repeat(120)).ok).toBe(true);
    for (const title of [" ", "x".repeat(121)]) expect(normalizeTitle(title)).toEqual({ ok: false, reason: "title must be 1-to-120 characters" });
    for (const title of ["COM0", "COM10", "LPT10", "connection", "auxiliary"]) expect(normalizeTitle(title).ok).toBe(true);
  });
});
