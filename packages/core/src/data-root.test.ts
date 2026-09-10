import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authorityClaimEvidence,
  canonicalDataRoot,
  dataHome,
  resolveDataRoot,
  resolveManagedOmpDir,
} from "./data-root";

const tmpDirs: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-data-root-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("dataHome", () => {
  it("linux: XDG_DATA_HOME when absolute, else ~/.local/share", () => {
    expect(dataHome("linux", { XDG_DATA_HOME: "/srv/data" }, "/home/me")).toBe("/srv/data");
    expect(dataHome("linux", { XDG_DATA_HOME: "relative/data" }, "/home/me")).toBe(
      "/home/me/.local/share",
    );
    expect(dataHome("linux", {}, "/home/me")).toBe("/home/me/.local/share");
  });

  it("darwin: ~/Library/Application Support, ignoring XDG", () => {
    expect(dataHome("darwin", { XDG_DATA_HOME: "/srv/data" }, "/Users/me")).toBe(
      "/Users/me/Library/Application Support",
    );
  });

  it("win32: LOCALAPPDATA, else ~/AppData/Local", () => {
    expect(dataHome("win32", { LOCALAPPDATA: "D:\\Local" }, "C:\\Users\\me")).toBe("D:\\Local");
    expect(dataHome("win32", {}, "C:\\Users\\me")).toBe("C:\\Users\\me\\AppData\\Local");
  });
});

describe("resolveDataRoot", () => {
  it("appends the flavor dir to the platform data home", () => {
    expect(resolveDataRoot("installed", {}, "linux", "/home/me")).toBe(
      "/home/me/.local/share/omp-ui",
    );
    expect(resolveDataRoot("dev", {}, "linux", "/home/me")).toBe("/home/me/.local/share/omp-ui-dev");
    expect(resolveDataRoot("dev-server", {}, "darwin", "/Users/me")).toBe(
      "/Users/me/Library/Application Support/omp-ui-dev-server",
    );
    expect(resolveDataRoot("installed", { LOCALAPPDATA: "D:\\Local" }, "win32", "C:\\Users\\me")).toBe(
      "D:\\Local\\omp-ui",
    );
  });

  it("OMP_UI_DATA_DIR replaces the whole root with no flavor suffix", () => {
    const dir = mkTmp();
    expect(resolveDataRoot("dev-server", { OMP_UI_DATA_DIR: dir }, "linux", "/home/me")).toBe(
      fs.realpathSync.native(dir),
    );
    // Empty means unset.
    expect(resolveDataRoot("dev", { OMP_UI_DATA_DIR: "" }, "linux", "/home/me")).toBe(
      "/home/me/.local/share/omp-ui-dev",
    );
  });

  it("ignores omp's own profile selectors", () => {
    const env = {
      OMP_PROFILE: "work",
      PI_PROFILE: "work",
      PI_CODING_AGENT_DIR: "/somewhere/else",
    };
    expect(resolveDataRoot("installed", env, "linux", "/home/me")).toBe(
      "/home/me/.local/share/omp-ui",
    );
  });

  it("canonicalises a symlinked existing root to its realpath", () => {
    const base = mkTmp();
    const real = path.join(base, "real");
    const link = path.join(base, "link");
    fs.mkdirSync(real);
    fs.symlinkSync(real, link, "dir");
    expect(resolveDataRoot("installed", { OMP_UI_DATA_DIR: link })).toBe(
      fs.realpathSync.native(real),
    );
  });
});

describe("resolveManagedOmpDir", () => {
  it("is <root>/omp", () => {
    const dir = mkTmp();
    expect(resolveManagedOmpDir("installed", { OMP_UI_DATA_DIR: dir })).toBe(
      path.join(fs.realpathSync.native(dir), "omp"),
    );
  });
});

describe("canonicalDataRoot", () => {
  it("rejects a flavor root nested inside another flavor root", () => {
    expect(() => canonicalDataRoot("/x/omp-ui/omp-ui-dev", "linux")).toThrow(/^nested data root:/);
    expect(() => canonicalDataRoot("/x/omp-ui-dev/omp-ui", "linux")).toThrow(/^nested data root:/);
    expect(() => canonicalDataRoot("C:\\x\\omp-ui\\omp-ui-dev-server", "win32")).toThrow(
      /^nested data root:/,
    );
  });

  it("accepts a flavor root and non-flavor children of one", () => {
    expect(canonicalDataRoot("/x/omp-ui", "linux")).toBe("/x/omp-ui");
    expect(canonicalDataRoot("/x/omp-ui/omp", "linux")).toBe("/x/omp-ui/omp");
    expect(canonicalDataRoot("/x/omp-ui/", "linux")).toBe("/x/omp-ui");
  });
});

describe("authorityClaimEvidence", () => {
  it("lists only present markers, in marker order", () => {
    const root = mkTmp();
    expect(authorityClaimEvidence(root)).toEqual([]);
    fs.mkdirSync(path.join(root, "worktrees"));
    fs.writeFileSync(path.join(root, "registry.json"), "{}");
    fs.writeFileSync(path.join(root, "unrelated.json"), "{}");
    expect(authorityClaimEvidence(root)).toEqual(["registry.json", "worktrees"]);
  });

  it("is empty for a missing root", () => {
    expect(authorityClaimEvidence(path.join(mkTmp(), "absent"))).toEqual([]);
  });
});
