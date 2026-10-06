import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RootGuard } from "./knowledge-vault";
import type { ObsidianListEntry, VaultDetection, VaultRegistry, VaultRegistryEntry } from "./types";
import {
  addVaultEntry,
  buildVaultOpenUri,
  detectVaults,
  findObsidianList,
  knowledgeVaultDiagnostics,
  obsidianListCandidates,
  parseVaultRegistry,
  readObsidianList,
  removeVaultEntry,
  setDefaultWriteVault,
  setVaultHomeFolder,
  setVaultWritesOutsideHome,
} from "./vault-registry";

let base: string;

function mkdir(...segments: string[]): string {
  const dir = path.join(base, ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

function row(name: string, rowPath: string, extra: Partial<VaultRegistryEntry> = {}): VaultRegistryEntry {
  return { name, path: rowPath, homeFolder: "omp-ui/", allowWritesOutsideHome: false, ...extra };
}

function frozen(reg: VaultRegistry): VaultRegistry {
  for (const v of reg.vaults) Object.freeze(v);
  Object.freeze(reg.vaults);
  return Object.freeze(reg);
}

beforeEach(() => {
  base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-vault-reg-")));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const FLATPAK = "/home/u/.var/app/md.obsidian.Obsidian/config/obsidian/obsidian.json";

describe("obsidianListCandidates", () => {
  it("linux: XDG_CONFIG_HOME first when set, Flatpak second", () => {
    expect(obsidianListCandidates({ XDG_CONFIG_HOME: "/x/cfg" }, "linux", "/home/u")).toEqual([
      "/x/cfg/obsidian/obsidian.json",
      FLATPAK,
    ]);
  });

  it("linux: ~/.config when XDG_CONFIG_HOME is absent or empty", () => {
    const expected = ["/home/u/.config/obsidian/obsidian.json", FLATPAK];
    expect(obsidianListCandidates({}, "linux", "/home/u")).toEqual(expected);
    expect(obsidianListCandidates({ XDG_CONFIG_HOME: "" }, "linux", "/home/u")).toEqual(expected);
  });

  it("darwin: Application Support", () => {
    expect(obsidianListCandidates({}, "darwin", "/Users/u")).toEqual([
      "/Users/u/Library/Application Support/obsidian/obsidian.json",
    ]);
  });

  it("win32: APPDATA when set, else <home>\\AppData\\Roaming, joined with backslashes", () => {
    expect(obsidianListCandidates({ APPDATA: "D:\\Roam" }, "win32", "C:\\Users\\u")).toEqual([
      "D:\\Roam\\obsidian\\obsidian.json",
    ]);
    expect(obsidianListCandidates({ APPDATA: "" }, "win32", "C:\\Users\\u")).toEqual([
      "C:\\Users\\u\\AppData\\Roaming\\obsidian\\obsidian.json",
    ]);
    expect(obsidianListCandidates({}, "win32", "C:\\Users\\u")).toEqual([
      "C:\\Users\\u\\AppData\\Roaming\\obsidian\\obsidian.json",
    ]);
  });

  it("any other platform: none", () => {
    expect(obsidianListCandidates({}, "freebsd", "/home/u")).toEqual([]);
  });
});

describe("readObsidianList", () => {
  it("parses the #751 shape", async () => {
    const vault = mkdir("Vault");
    const file = path.join(base, "obsidian.json");
    writeJson(file, { vaults: { d54189eae5e5b8ef: { path: vault, ts: 1759000000000, open: true } }, cli: true });
    expect(await readObsidianList(file)).toEqual({
      vaults: [{ id: "d54189eae5e5b8ef", path: vault, open: true }],
      cli: true,
    });
  });

  it("gives cli false when the key is absent and open false unless true", async () => {
    const vault = mkdir("Vault");
    const file = path.join(base, "obsidian.json");
    writeJson(file, { vaults: { a1: { path: vault, open: "yes" } } });
    expect(await readObsidianList(file)).toEqual({ vaults: [{ id: "a1", path: vault, open: false }], cli: false });
  });

  it("skips rows without a non-empty string path", async () => {
    const vault = mkdir("Vault");
    const file = path.join(base, "obsidian.json");
    writeJson(file, { vaults: { a1: { path: 3 }, a2: { ts: 1 }, a3: { path: "" }, a4: null, a5: { path: vault } } });
    expect(await readObsidianList(file)).toEqual({ vaults: [{ id: "a5", path: vault, open: false }], cli: false });
  });

  it("gives null for malformed JSON, a non-object document and a missing file", async () => {
    const bad = path.join(base, "bad.json");
    writeJson(bad, "{not json");
    expect(await readObsidianList(bad)).toBeNull();
    const arr = path.join(base, "arr.json");
    writeJson(arr, []);
    expect(await readObsidianList(arr)).toBeNull();
    expect(await readObsidianList(path.join(base, "missing.json"))).toBeNull();
  });

  it("stores realpath'd paths, falling back to the resolved path", async () => {
    const vault = mkdir("Real");
    const link = path.join(base, "link");
    fs.symlinkSync(vault, link);
    const gone = path.join(base, "gone", "..", "Gone");
    const file = path.join(base, "obsidian.json");
    writeJson(file, { vaults: { a1: { path: link }, a2: { path: gone } } });
    expect(await readObsidianList(file)).toEqual({
      vaults: [
        { id: "a1", path: vault, open: false },
        { id: "a2", path: path.join(base, "Gone"), open: false },
      ],
      cli: false,
    });
  });
});

describe("findObsidianList", () => {
  it("uses the Flatpak file when XDG_CONFIG_HOME is absent and ~/.config has none", async () => {
    const home = mkdir("home");
    // The linux candidates are built with path.posix on every host.
    const flatpak = path.posix.join(home, ".var", "app", "md.obsidian.Obsidian", "config", "obsidian", "obsidian.json");
    writeJson(flatpak, { vaults: {}, cli: true });
    expect(await findObsidianList({}, "linux", home)).toEqual({ file: flatpak, vaults: [], cli: true });
  });

  it("the first readable candidate wins", async () => {
    const home = mkdir("home");
    const xdg = mkdir("xdg");
    const first = path.posix.join(xdg, "obsidian", "obsidian.json");
    const flatpak = path.posix.join(home, ".var", "app", "md.obsidian.Obsidian", "config", "obsidian", "obsidian.json");
    writeJson(first, { vaults: {} });
    writeJson(flatpak, { vaults: {}, cli: true });
    expect(await findObsidianList({ XDG_CONFIG_HOME: xdg }, "linux", home)).toEqual({ file: first, vaults: [], cli: false });
    // An unparsable first candidate is not readable, so the walk moves on.
    writeJson(first, "{");
    expect(await findObsidianList({ XDG_CONFIG_HOME: xdg }, "linux", home)).toEqual({ file: flatpak, vaults: [], cli: true });
  });

  it("gives null when no candidate exists", async () => {
    expect(await findObsidianList({}, "linux", mkdir("empty-home"))).toBeNull();
  });
});

describe("detectVaults", () => {
  let guard: RootGuard;
  let home: string;

  beforeEach(() => {
    home = mkdir("home");
    guard = {
      home,
      userData: mkdir("user-data"),
      agentDir: mkdir("agent"),
      sessionsRoot: mkdir("agent", "sessions"),
      archiveRoot: mkdir("archive"),
    };
  });

  it("reports ok, no-obsidian-dir, missing and refused-root, Obsidian-list membership and registeredAs", async () => {
    const ok = mkdir("vaults", "Ok");
    mkdir("vaults", "Ok", ".obsidian");
    const plain = mkdir("vaults", "Plain");
    const fileDot = mkdir("vaults", "FileDot");
    fs.writeFileSync(path.join(fileDot, ".obsidian"), "");
    const gone = mkdir("vaults", "Gone");
    const refused = mkdir("user-data", "Inside");
    const linkedReal = mkdir("vaults", "Linked");
    mkdir("vaults", "Linked", ".obsidian");
    mkdir("links");
    const linkedPath = path.join(base, "links", "Linked");
    fs.symlinkSync(linkedReal, linkedPath);
    const unregistered = mkdir("vaults", "Other");
    writeJson(path.join(home, ".config", "obsidian", "obsidian.json"), {
      vaults: {
        aaaa: { path: linkedReal, open: true },
        bbbb: { path: unregistered },
        cccc: { path: gone },
        dddd: { path: ok },
      },
      cli: true,
    });
    // Folder deleted after add (M24): the row survives and shows "folder missing".
    fs.rmSync(gone, { recursive: true });
    const reg: VaultRegistry = {
      vaults: [
        row("Ok", ok),
        row("Plain", plain),
        row("FileDot", fileDot),
        row("Gone", gone),
        row("Inside", refused),
        row("Linked", linkedPath),
      ],
      defaultWriteVault: "Ok",
    };
    const d = await detectVaults(reg, { env: {}, platform: "linux", home, guard, uriHandler: true });
    expect(d.rows).toEqual({
      Ok: { status: "ok", inObsidianList: true, obsidianId: "dddd" },
      Plain: { status: "no-obsidian-dir", inObsidianList: false, obsidianId: null },
      FileDot: { status: "no-obsidian-dir", inObsidianList: false, obsidianId: null },
      Gone: { status: "missing", inObsidianList: true, obsidianId: "cccc" },
      Inside: { status: "refused-root", inObsidianList: false, obsidianId: null },
      Linked: { status: "ok", inObsidianList: true, obsidianId: "aaaa" },
    });
    expect(d.obsidianList).toEqual([
      { id: "aaaa", path: linkedReal, open: true, registeredAs: "Linked" },
      { id: "bbbb", path: unregistered, open: false, registeredAs: null },
      { id: "cccc", path: gone, open: false, registeredAs: "Gone" },
      { id: "dddd", path: ok, open: false, registeredAs: "Ok" },
    ]);
    expect(d.obsidianListFile).toBe(path.join(home, ".config", "obsidian", "obsidian.json"));
    expect(d.cliRegistered).toBe(true);
    expect(d.uriHandler).toBe(true);
  });

  it("falls back to no list file and no CLI when no candidate exists, passing uriHandler through", async () => {
    const vault = mkdir("vaults", "Solo");
    const reg: VaultRegistry = { vaults: [row("Solo", vault)], defaultWriteVault: "Solo" };
    const d = await detectVaults(reg, { env: {}, platform: "linux", home, guard, uriHandler: false });
    expect(d).toEqual({
      obsidianListFile: null,
      obsidianList: [],
      cliRegistered: false,
      uriHandler: false,
      rows: { Solo: { status: "no-obsidian-dir", inObsidianList: false, obsidianId: null } },
    });
  });
});

describe("parseVaultRegistry", () => {
  it("turns a non-object into an empty registry", () => {
    for (const value of [undefined, null, 3, "x", true]) {
      expect(parseVaultRegistry(value)).toEqual({ vaults: [], defaultWriteVault: null });
    }
    expect(parseVaultRegistry({ vaults: "nope" })).toEqual({ vaults: [], defaultWriteVault: null });
  });

  it("drops rows with a missing name or path, a non-boolean toggle or a bad home folder", () => {
    const good = row("Good", "/v/Good");
    expect(
      parseVaultRegistry({
        vaults: [
          null,
          { path: "/v/a", homeFolder: "omp-ui/", allowWritesOutsideHome: false },
          { name: "", path: "/v/a", homeFolder: "omp-ui/", allowWritesOutsideHome: false },
          { name: "NoPath", homeFolder: "omp-ui/", allowWritesOutsideHome: false },
          { name: "Toggle", path: "/v/t", homeFolder: "omp-ui/", allowWritesOutsideHome: "yes" },
          { name: "BadHome", path: "/v/b", homeFolder: "../out", allowWritesOutsideHome: false },
          { name: "NoHome", path: "/v/n", allowWritesOutsideHome: false },
          good,
        ],
        defaultWriteVault: "Good",
      }),
    ).toEqual({ vaults: [good], defaultWriteVault: "Good" });
  });

  it("keeps the first of duplicate names and stores homeFolder normalized", () => {
    expect(
      parseVaultRegistry({
        vaults: [
          { name: "V", path: "/v/one", homeFolder: " ./notes\\omp//", allowWritesOutsideHome: true },
          { name: "V", path: "/v/two", homeFolder: "omp-ui/", allowWritesOutsideHome: false },
        ],
        defaultWriteVault: "V",
      }),
    ).toEqual({
      vaults: [{ name: "V", path: "/v/one", homeFolder: "notes/omp/", allowWritesOutsideHome: true }],
      defaultWriteVault: "V",
    });
  });

  it("repairs the default to the first row, or null", () => {
    const rows = [row("A", "/v/A"), row("B", "/v/B")];
    expect(parseVaultRegistry({ vaults: rows, defaultWriteVault: "B" }).defaultWriteVault).toBe("B");
    expect(parseVaultRegistry({ vaults: rows, defaultWriteVault: "Z" }).defaultWriteVault).toBe("A");
    expect(parseVaultRegistry({ vaults: rows }).defaultWriteVault).toBe("A");
    expect(parseVaultRegistry({ vaults: [], defaultWriteVault: "A" }).defaultWriteVault).toBeNull();
  });

  it("returns a fresh object per call", () => {
    const value = { vaults: [row("A", "/v/A")], defaultWriteVault: "A" };
    const first = parseVaultRegistry(value);
    const second = parseVaultRegistry(value);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(first.vaults).not.toBe(second.vaults);
    expect(first.vaults[0]).not.toBe(value.vaults[0]);
  });
});

describe("registry transforms", () => {
  const empty = (): VaultRegistry => frozen({ vaults: [], defaultWriteVault: null });
  const two = (): VaultRegistry => frozen({ vaults: [row("A", "/v/A"), row("B", "/v/B")], defaultWriteVault: "A" });

  it("addVaultEntry: basename name, omp-ui/ and false defaults, first row becomes the default", () => {
    const one = addVaultEntry(empty(), "/v/Notes");
    expect(one).toEqual({
      vaults: [{ name: "Notes", path: "/v/Notes", homeFolder: "omp-ui/", allowWritesOutsideHome: false }],
      defaultWriteVault: "Notes",
    });
    expect(addVaultEntry(frozen(one), "/w/Other").defaultWriteVault).toBe("Notes");
  });

  it("addVaultEntry: refuses a duplicate basename", () => {
    expect(() => addVaultEntry(two(), "/elsewhere/A")).toThrow("A vault named A is already registered.");
  });

  it("removeVaultEntry: the default moves to the first remaining row, or null", () => {
    const afterA = removeVaultEntry(two(), "A");
    expect(afterA).toEqual({ vaults: [row("B", "/v/B")], defaultWriteVault: "B" });
    expect(removeVaultEntry(two(), "B").defaultWriteVault).toBe("A");
    expect(removeVaultEntry(frozen(afterA), "B")).toEqual({ vaults: [], defaultWriteVault: null });
  });

  it("setDefaultWriteVault switches the default", () => {
    expect(setDefaultWriteVault(two(), "B").defaultWriteVault).toBe("B");
  });

  it("setVaultHomeFolder normalizes and refuses with the exact message", () => {
    expect(setVaultHomeFolder(two(), "B", "./notes\\daily").vaults[1]?.homeFolder).toBe("notes/daily/");
    expect(() => setVaultHomeFolder(two(), "B", "../out")).toThrow("Use a folder inside the vault, like omp-ui/.");
  });

  it("setVaultWritesOutsideHome flips the toggle on one row only", () => {
    const next = setVaultWritesOutsideHome(two(), "A", true);
    expect(next.vaults.map((v) => v.allowWritesOutsideHome)).toEqual([true, false]);
  });

  it("every name-taking transform refuses an unknown vault", () => {
    const message = 'unknown vault "x"';
    expect(() => removeVaultEntry(two(), "x")).toThrow(message);
    expect(() => setDefaultWriteVault(two(), "x")).toThrow(message);
    expect(() => setVaultHomeFolder(two(), "x", "notes")).toThrow(message);
    expect(() => setVaultWritesOutsideHome(two(), "x", true)).toThrow(message);
  });
});

describe("buildVaultOpenUri", () => {
  const list: ObsidianListEntry[] = [{ id: "ee8bdab8baa42089", path: "/v/Notes", open: false }];

  it("is vault-id keyed when the root is listed", () => {
    expect(buildVaultOpenUri("/v/Notes", "omp-ui/Foo.md", list)).toBe(
      "obsidian://open?vault=ee8bdab8baa42089&file=omp-ui%2FFoo",
    );
    expect(buildVaultOpenUri("/v/Notes", null, list)).toBe("obsidian://open?vault=ee8bdab8baa42089");
  });

  it("is path keyed for the root and a note when unlisted", () => {
    expect(buildVaultOpenUri("/v/Other", null, list)).toBe(`obsidian://open?path=${encodeURIComponent("/v/Other")}`);
    expect(buildVaultOpenUri("/v/Other", "omp-ui/Foo.md", list)).toBe(
      `obsidian://open?path=${encodeURIComponent(path.join("/v/Other", "omp-ui", "Foo.md"))}`,
    );
  });
});

describe("knowledgeVaultDiagnostics", () => {
  it("summarizes rows and detection without any folder path", () => {
    const reg: VaultRegistry = {
      vaults: [row("A", "/secret/A", { allowWritesOutsideHome: true }), row("B", "/secret/B", { homeFolder: "x/" })],
      defaultWriteVault: "A",
    };
    const d: VaultDetection = {
      obsidianListFile: "/secret/obsidian.json",
      obsidianList: [{ id: "aaaa", path: "/secret/A", open: true, registeredAs: "A" }],
      cliRegistered: true,
      uriHandler: false,
      rows: { A: { status: "ok", inObsidianList: true, obsidianId: "aaaa" } },
    };
    const diag = knowledgeVaultDiagnostics(reg, d, {});
    expect(diag).toEqual({
      vaults: [
        { name: "A", homeFolder: "omp-ui/", allowWritesOutsideHome: true, isDefault: true, status: "ok", inObsidianList: true },
        { name: "B", homeFolder: "x/", allowWritesOutsideHome: false, isDefault: false, status: "missing", inObsidianList: false },
      ],
      obsidianListFound: true,
      cliRegistered: true,
      uriHandler: false,
      calls: {},
    });
    const json = JSON.stringify(diag);
    expect(json).not.toContain('"path"');
    expect(json).not.toContain("/secret");
  });
});
