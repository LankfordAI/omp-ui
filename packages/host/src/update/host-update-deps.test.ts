import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_RELEASE_BASE, hostFeedName, normalizeSha512, parseHostFeed, switchCurrent } from "./host-update-deps";

const HEX = "ab".repeat(64);
const B64 = Buffer.from(HEX, "hex").toString("base64");

/** The release pipeline's `latest-host-mac.yml`: one feed, both arches. */
const MAC_FEED = `version: 1.2.3
files:
  - url: omp-ui-host-1.2.3-mac-x64.zip
    sha512: ${B64}
    size: 11
    arch: x64
  - url: omp-ui-host-1.2.3-mac-arm64.zip
    sha512: ${"cd".repeat(64)}
    size: 22
    arch: arm64
path: omp-ui-host-1.2.3-mac-x64.zip
sha512: ${B64}
releaseDate: '2026-09-10T17:55:37.000Z'
`;

describe("host feed", () => {
  it("names one feed per platform lane", () => {
    expect(hostFeedName("linux")).toBe("latest-host-linux.yml");
    expect(hostFeedName("darwin")).toBe("latest-host-mac.yml");
    expect(hostFeedName("win32")).toBe("latest-host-win.yml");
    expect(hostFeedName("freebsd")).toBeNull();
  });

  it("selects this arch's archive and normalizes its digest to hex", () => {
    expect(parseHostFeed(MAC_FEED, "darwin", "arm64")).toEqual({
      version: "1.2.3",
      url: `${HOST_RELEASE_BASE}/omp-ui-host-1.2.3-mac-arm64.zip`,
      sha512: "cd".repeat(64),
      size: 22,
    });
    expect(parseHostFeed(MAC_FEED, "darwin", "x64")).toMatchObject({ sha512: HEX, size: 11 });
  });

  it("falls back to the top-level path for a single-arch feed and refuses a foreign lane", () => {
    const linux = `version: 2.0.0\npath: omp-ui-host-2.0.0-linux-x64.tar.gz\nsha512: ${HEX}\nreleaseDate: '2026-09-10'\n`;
    expect(parseHostFeed(linux, "linux", "x64")).toEqual({
      version: "2.0.0",
      url: `${HOST_RELEASE_BASE}/omp-ui-host-2.0.0-linux-x64.tar.gz`,
      sha512: HEX,
      size: 0,
    });
    expect(parseHostFeed(linux, "linux", "arm64")).toBeNull();
    expect(parseHostFeed(MAC_FEED, "linux", "x64")).toBeNull();
    expect(parseHostFeed("files:\n  - url: x\n", "linux", "x64")).toBeNull();
  });

  it("accepts hex or base64 sha512 and nothing else", () => {
    expect(normalizeSha512(HEX.toUpperCase())).toBe(HEX);
    expect(normalizeSha512(B64)).toBe(HEX);
    expect(normalizeSha512("deadbeef")).toBeNull();
    expect(normalizeSha512(Buffer.alloc(32).toString("base64"))).toBeNull();
  });
});

describe("switchCurrent", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  interface Layout {
    home: string;
    dataRoot: string;
    versions: string;
    current: string;
    staged: string;
  }

  function layout(): Layout {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-switch-"));
    dirs.push(home);
    const dataHomeDir = path.join(home, ".local", "share");
    const dataRoot = path.join(dataHomeDir, "omp-ui");
    const versions = path.join(dataHomeDir, "omp-ui-host", "versions");
    const staged = path.join(dataRoot, "updates", "host-1.1.0");
    for (const dir of [path.join(versions, "1.0.0", "bin"), path.join(staged, "bin")]) fs.mkdirSync(dir, { recursive: true });
    return { home, dataRoot, versions, current: path.join(dataHomeDir, "omp-ui-host", "current"), staged };
  }

  const linuxDeps = (l: Layout) => ({
    platform: "linux" as const,
    env: { XDG_DATA_HOME: path.join(l.home, ".local", "share") },
    home: l.home,
    dataRoot: l.dataRoot,
  });

  it("creates an absent pointer, replaces one of ours atomically, and leaves the stable command untouched", () => {
    const l = layout();
    switchCurrent(path.join(l.versions, "1.0.0"), linuxDeps(l));
    expect(fs.readlinkSync(l.current)).toBe(path.join(l.versions, "1.0.0"));
    switchCurrent(l.staged, linuxDeps(l));
    expect(fs.readlinkSync(l.current)).toBe(l.staged);
    expect(fs.readdirSync(path.dirname(l.current))).toEqual(["current", "versions"]);
  });

  it("refuses a pointer that is a real directory or links somewhere that is not ours", () => {
    const l = layout();
    fs.mkdirSync(l.current, { recursive: true });
    expect(() => switchCurrent(l.staged, linuxDeps(l))).toThrow("is not a link");
    fs.rmdirSync(l.current);
    fs.symlinkSync("/opt/someone-elses/omp-ui", l.current);
    expect(() => switchCurrent(l.staged, linuxDeps(l))).toThrow("not ours");
    expect(fs.readlinkSync(l.current)).toBe("/opt/someone-elses/omp-ui");
  });

  it("refuses a target that does not exist", () => {
    const l = layout();
    expect(() => switchCurrent(path.join(l.versions, "9.9.9"), linuxDeps(l))).toThrow("does not exist");
    expect(fs.existsSync(l.current)).toBe(false);
  });
});
