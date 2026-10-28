import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  consumeFleetInbox,
  detectHostOs,
  detectPackageManagers,
  FLEET_INBOX_ARTIFACT,
  parseOsRelease,
  readFleetInbox,
  stageFleetInbox,
} from "./fleet-host";

/** An isExecutableFile seam that answers true only for the listed paths. */
function executables(...paths: string[]): (p: string) => Promise<boolean> {
  const set = new Set(paths);
  return async (p) => set.has(p);
}

function files(map: Record<string, string>): (p: string) => Promise<string> {
  return async (p) => {
    const text = map[p];
    if (text === undefined)
      throw Object.assign(new Error(`ENOENT: ${p}`), { code: "ENOENT" });
    return text;
  };
}

describe("parseOsRelease", () => {
  it("skips blanks and comments, strips one pair of matching quotes, unescapes", () => {
    const fields = parseOsRelease(
      [
        "# a comment",
        "",
        'NAME="Fedora Linux"',
        "VERSION_ID=44",
        "ID='fedora'",
        'PRETTY_NAME="Fedora \\"Linux\\" 44 \\$HOME \\\\ end"',
        `MIXED="half'`,
        "NESTED=\"'inner'\"",
        "not a field",
      ].join("\n"),
    );
    expect(fields).toEqual({
      NAME: "Fedora Linux",
      VERSION_ID: "44",
      ID: "fedora",
      PRETTY_NAME: 'Fedora "Linux" 44 $HOME \\ end',
      MIXED: `"half'`,
      NESTED: "'inner'",
    });
  });
});

describe("detectHostOs", () => {
  it("reads PRETTY_NAME and VERSION_ID from /etc/os-release on Linux", async () => {
    const os = await detectHostOs({
      platform: "linux",
      readFile: files({
        "/etc/os-release":
          'PRETTY_NAME="Fedora Linux 44 (Workstation Edition)"\nVERSION_ID=44\n',
      }),
    });
    expect(os).toEqual({
      name: "Fedora Linux 44 (Workstation Edition)",
      version: "44",
    });
  });

  it("falls back to /usr/lib/os-release, then NAME, then Linux", async () => {
    expect(
      await detectHostOs({
        platform: "linux",
        readFile: files({ "/usr/lib/os-release": "NAME=Alpine\n" }),
      }),
    ).toEqual({ name: "Alpine", version: null });
    expect(
      await detectHostOs({ platform: "linux", readFile: files({}) }),
    ).toEqual({ name: "Linux", version: null });
  });

  it("asks sw_vers on macOS and keeps the name when it fails", async () => {
    const calls: string[][] = [];
    const ok = await detectHostOs({
      platform: "darwin",
      run: async (file, args) => {
        calls.push([file, ...args]);
        return "15.1";
      },
    });
    expect(ok).toEqual({ name: "macOS", version: "15.1" });
    expect(calls).toEqual([["/usr/bin/sw_vers", "-productVersion"]]);
    const failed = await detectHostOs({
      platform: "darwin",
      run: async () => {
        throw new Error("spawn ENOENT");
      },
    });
    expect(failed).toEqual({ name: "macOS", version: null });
  });

  it("renames Windows 10 to Windows 11 from build 22000 only", async () => {
    expect(
      await detectHostOs({
        platform: "win32",
        osVersion: () => "Windows 10 Pro",
        osRelease: () => "10.0.22631",
      }),
    ).toEqual({ name: "Windows 11 Pro", version: "10.0.22631" });
    expect(
      await detectHostOs({
        platform: "win32",
        osVersion: () => "Windows 10 Pro",
        osRelease: () => "10.0.19045",
      }),
    ).toEqual({ name: "Windows 10 Pro", version: "10.0.19045" });
    expect(
      await detectHostOs({
        platform: "win32",
        osVersion: () => "",
        osRelease: () => "",
      }),
    ).toEqual({
      name: "Windows",
      version: null,
    });
  });

  it("uses os.type and os.release on other platforms", async () => {
    const os = await detectHostOs({
      platform: "freebsd",
      osType: () => "FreeBSD",
      osRelease: () => "14.1-RELEASE",
    });
    expect(os).toEqual({ name: "FreeBSD", version: "14.1-RELEASE" });
  });
});

describe("detectPackageManagers", () => {
  it("reports apt-get as apt and walks PATH in order, skipping empty entries", async () => {
    const found = await detectPackageManagers({
      platform: "linux",
      env: { PATH: "::/usr/local/bin:/usr/bin" },
      isExecutableFile: executables(
        "/usr/bin/apt-get",
        "/usr/bin/flatpak",
        "/usr/local/bin/flatpak",
      ),
    });
    expect(found).toEqual([
      { name: "apt", path: "/usr/bin/apt-get", onPath: true },
      { name: "flatpak", path: "/usr/local/bin/flatpak", onPath: true },
    ]);
  });

  it("suppresses yum when dnf exists and reports it otherwise", async () => {
    const both = await detectPackageManagers({
      platform: "linux",
      env: { PATH: "/usr/bin" },
      isExecutableFile: executables("/usr/bin/dnf", "/usr/bin/yum"),
    });
    expect(both.map((m) => m.name)).toEqual(["dnf"]);
    const yumOnly = await detectPackageManagers({
      platform: "linux",
      env: { PATH: "/usr/bin" },
      isExecutableFile: executables("/usr/bin/yum"),
    });
    expect(yumOnly).toEqual([
      { name: "yum", path: "/usr/bin/yum", onPath: true },
    ]);
  });

  it("reports a fallback-only brew off PATH with its absolute path", async () => {
    expect(
      await detectPackageManagers({
        platform: "linux",
        env: { PATH: "/usr/bin" },
        isExecutableFile: executables(
          "/usr/bin/dnf",
          "/home/linuxbrew/.linuxbrew/bin/brew",
        ),
      }),
    ).toEqual([
      { name: "dnf", path: "/usr/bin/dnf", onPath: true },
      {
        name: "brew",
        path: "/home/linuxbrew/.linuxbrew/bin/brew",
        onPath: false,
      },
    ]);
    expect(
      await detectPackageManagers({
        platform: "darwin",
        env: { PATH: "/usr/bin:/bin" },
        isExecutableFile: executables(
          "/opt/homebrew/bin/brew",
          "/usr/local/bin/brew",
        ),
      }),
    ).toEqual([
      { name: "brew", path: "/opt/homebrew/bin/brew", onPath: false },
    ]);
  });

  it("resolves winget.exe on Windows via the injected Path and case-insensitive env names", async () => {
    const found = await detectPackageManagers({
      platform: "win32",
      env: {
        Path: "C:\\Windows\\system32;;C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps",
        LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local",
        programdata: "C:\\ProgramData",
        SCOOP: "",
        UserProfile: "C:\\Users\\me",
      },
      isExecutableFile: executables(
        "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe",
        "C:\\ProgramData\\chocolatey\\bin\\choco.exe",
        "C:\\Users\\me\\scoop\\shims\\scoop.cmd",
      ),
    });
    expect(found).toEqual([
      {
        name: "winget",
        path: "C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\winget.exe",
        onPath: true,
      },
      {
        name: "choco",
        path: "C:\\ProgramData\\chocolatey\\bin\\choco.exe",
        onPath: false,
      },
      {
        name: "scoop",
        path: "C:\\Users\\me\\scoop\\shims\\scoop.cmd",
        onPath: false,
      },
    ]);
  });

  it("skips a fallback whose env variable is unset or empty", async () => {
    const probed: string[] = [];
    const found = await detectPackageManagers({
      platform: "win32",
      env: { PATH: "", SCOOP: "" },
      isExecutableFile: async (p) => {
        probed.push(p);
        return false;
      },
    });
    expect(found).toEqual([]);
    expect(probed).toEqual([]);
  });

  it("returns nothing on platforms outside the table", async () => {
    expect(
      await detectPackageManagers({
        platform: "freebsd",
        env: { PATH: "/usr/bin" },
        isExecutableFile: async () => true,
      }),
    ).toEqual([]);
  });
});

describe("fleet send inbox (#959)", () => {
  const dir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "fleet-inbox-"));

  it("stages in order, consumes by id, and removes the file when empty", () => {
    const lineage = dir();
    expect(readFleetInbox(lineage)).toEqual([]);
    stageFleetInbox(lineage, { id: "a", text: "one", mode: "queue" });
    stageFleetInbox(lineage, { id: "b", text: "two", mode: "steer" });
    expect(readFleetInbox(lineage)).toEqual([
      { id: "a", text: "one", mode: "queue" },
      { id: "b", text: "two", mode: "steer" },
    ]);
    consumeFleetInbox(lineage, "a");
    expect(readFleetInbox(lineage)).toEqual([{ id: "b", text: "two", mode: "steer" }]);
    consumeFleetInbox(lineage, "b");
    expect(fs.existsSync(path.join(lineage, FLEET_INBOX_ARTIFACT))).toBe(false);
  });

  it.each([
    "not json",
    JSON.stringify({ id: "a", text: "t", mode: "queue" }),
    JSON.stringify([{ id: "a", text: "t", mode: "later" }]),
    JSON.stringify([{ id: "a", text: "t", mode: "queue", extra: 1 }]),
    JSON.stringify([{ id: "", text: "t", mode: "queue" }]),
  ])("reads %s as empty", (content) => {
    const lineage = dir();
    fs.writeFileSync(path.join(lineage, FLEET_INBOX_ARTIFACT), content);
    expect(readFleetInbox(lineage)).toEqual([]);
  });
});
