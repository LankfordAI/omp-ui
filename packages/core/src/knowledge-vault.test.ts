import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveVaultPath, validateVaultRoot, type RootGuard } from "./knowledge-vault";

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
