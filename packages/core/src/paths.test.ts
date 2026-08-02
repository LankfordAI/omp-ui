import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  getArchiveRoot,
  getSessionsRoot,
  isLineageDirName,
  managedOmpPath,
  mintLineageDirName,
  resolveOmpBinary,
  resolveProfile,
} from "./paths";

const home = os.homedir();
const tmpDirs: string[] = [];

function mkTmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-paths-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("getSessionsRoot", () => {
  it("defaults to ~/.omp/agent/sessions", () => {
    expect(getSessionsRoot({})).toBe(path.join(home, ".omp", "agent", "sessions"));
  });

  it("honors PI_CONFIG_DIR as a directory name under $HOME", () => {
    expect(getSessionsRoot({ PI_CONFIG_DIR: "custom" })).toBe(
      path.join(home, "custom", "agent", "sessions"),
    );
  });

  it("places named profiles under profiles/<name>", () => {
    expect(getSessionsRoot({ OMP_PROFILE: "work" })).toBe(
      path.join(home, ".omp", "profiles", "work", "agent", "sessions"),
    );
    expect(getSessionsRoot({ PI_PROFILE: "work" })).toBe(
      path.join(home, ".omp", "profiles", "work", "agent", "sessions"),
    );
  });

  it("honors PI_CODING_AGENT_DIR for the default profile", () => {
    expect(getSessionsRoot({ PI_CODING_AGENT_DIR: "/elsewhere/agent" })).toBe(
      path.join(path.resolve("/elsewhere/agent"), "sessions"),
    );
  });

  it("ignores PI_CODING_AGENT_DIR under a named profile", () => {
    expect(
      getSessionsRoot({ OMP_PROFILE: "work", PI_CODING_AGENT_DIR: "/elsewhere/agent" }),
    ).toBe(path.join(home, ".omp", "profiles", "work", "agent", "sessions"));
  });

  it("takes the XDG branch only when the candidate dir exists", () => {
    const xdg = mkTmp();
    const env = { XDG_DATA_HOME: xdg };
    // Candidate missing → default branch.
    expect(getSessionsRoot(env)).toBe(path.join(home, ".omp", "agent", "sessions"));
    // Candidate present → flattened XDG root (no agent/ prefix).
    fs.mkdirSync(path.join(xdg, "omp"), { recursive: true });
    expect(getSessionsRoot(env)).toBe(path.join(xdg, "omp", "sessions"));
  });

  it("uses the profiled XDG candidate under a named profile", () => {
    const xdg = mkTmp();
    const env = { XDG_DATA_HOME: xdg, OMP_PROFILE: "work" };
    expect(getSessionsRoot(env)).toBe(
      path.join(home, ".omp", "profiles", "work", "agent", "sessions"),
    );
    fs.mkdirSync(path.join(xdg, "omp", "profiles", "work"), { recursive: true });
    expect(getSessionsRoot(env)).toBe(path.join(xdg, "omp", "profiles", "work", "sessions"));
  });

  it("skips the XDG branch when PI_CODING_AGENT_DIR overrode the agent dir", () => {
    const xdg = mkTmp();
    fs.mkdirSync(path.join(xdg, "omp"), { recursive: true });
    expect(getSessionsRoot({ XDG_DATA_HOME: xdg, PI_CODING_AGENT_DIR: "/elsewhere" })).toBe(
      path.join(path.resolve("/elsewhere"), "sessions"),
    );
  });
});

describe("getArchiveRoot", () => {
  it("is the sibling archive/sessions dir", () => {
    expect(getArchiveRoot(path.join("/a", "b", "sessions"))).toBe(
      path.join("/a", "b", "archive", "sessions"),
    );
  });
});

describe("resolveProfile", () => {
  it("prefers OMP_PROFILE over PI_PROFILE", () => {
    expect(resolveProfile({ OMP_PROFILE: "a", PI_PROFILE: "b" })).toBe("a");
  });

  it("treats an explicitly-empty OMP_PROFILE as the default profile", () => {
    expect(resolveProfile({ OMP_PROFILE: "", PI_PROFILE: "b" })).toBeUndefined();
  });

  it("rejects invalid and Windows-reserved names without throwing", () => {
    expect(resolveProfile({ OMP_PROFILE: "Has Space" })).toBeUndefined();
    expect(resolveProfile({ OMP_PROFILE: "-leading-dash" })).toBeUndefined();
    expect(resolveProfile({ OMP_PROFILE: "con" })).toBeUndefined();
    expect(resolveProfile({ OMP_PROFILE: "lpt1.txt" })).toBeUndefined();
    expect(resolveProfile({ OMP_PROFILE: "a".repeat(65) })).toBeUndefined();
    expect(resolveProfile({ OMP_PROFILE: "valid-name.1_2" })).toBe("valid-name.1_2");
  });
});

describe("lineage dir names", () => {
  it("mints omp-ui--<slug>--<uuid>", () => {
    const name = mintLineageDirName("/home/user/My Project");
    expect(name).toMatch(/^omp-ui--my-project--[0-9a-f-]{36}$/);
    expect(isLineageDirName(name)).toBe(true);
  });

  it("slugifies mixed case, spaces, and dash runs", () => {
    expect(mintLineageDirName("/x/Foo  Bar--Baz")).toMatch(/^omp-ui--foo-bar-baz--[0-9a-f-]{36}$/);
  });

  it("truncates the slug to 32 chars", () => {
    const name = mintLineageDirName(`/x/${"a".repeat(50)}`);
    const slug = name.slice("omp-ui--".length, name.lastIndexOf("--"));
    expect(slug).toBe("a".repeat(32));
  });

  it("falls back to 'project' for the filesystem root", () => {
    expect(mintLineageDirName("/")).toMatch(/^omp-ui--project--[0-9a-f-]{36}$/);
  });

  it("rejects non-lineage names", () => {
    expect(isLineageDirName("-Documents-Repos-LankfordAI-omp-ui")).toBe(false);
    expect(isLineageDirName("omp-ui--no-uuid-here")).toBe(false);
    expect(isLineageDirName("omp-ui--slug--not-a-uuid-at-all--------")).toBe(false);
  });

  // The predicate gates a recursive delete, so a name that could escape the
  // sessions root must never pass, however well-formed its prefix and suffix.
  it("rejects names containing a path separator", () => {
    const uuid = "11111111-2222-3333-4444-555555555555";
    expect(isLineageDirName(`omp-ui--x/../../etc--${uuid}`)).toBe(false);
    expect(isLineageDirName(`omp-ui--x\\..\\..--${uuid}`)).toBe(false);
    expect(isLineageDirName(`omp-ui--a/b--${uuid}`)).toBe(false);
  });
});

describe("resolveOmpBinary", () => {
  function fixtureOmp(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    const bin = path.join(dir, "omp");
    fs.writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
    return bin;
  }

  // Pin the managed dir to a nonexistent tmp path so the default under
  // $HOME (which could exist on a developer machine) never skews these.
  function noManaged(env: Record<string, string> = {}): Record<string, string> {
    return { OMP_UI_INSTALL_DIR: path.join(mkTmp(), "nonexistent"), ...env };
  }

  it("prefers OMP_UI_OMP_PATH over PATH", () => {
    const override = fixtureOmp(path.join(mkTmp(), "override"));
    const onPath = fixtureOmp(path.join(mkTmp(), "onpath"));
    expect(
      resolveOmpBinary(noManaged({ OMP_UI_OMP_PATH: override, PATH: path.dirname(onPath) })),
    ).toBe(override);
  });

  it("finds omp on PATH in order", () => {
    const first = fixtureOmp(path.join(mkTmp(), "a"));
    const second = fixtureOmp(path.join(mkTmp(), "b"));
    const env = noManaged({ PATH: [path.dirname(first), path.dirname(second)].join(path.delimiter) });
    expect(resolveOmpBinary(env)).toBe(first);
  });

  it("skips a nonexistent override and falls through to PATH", () => {
    const onPath = fixtureOmp(path.join(mkTmp(), "onpath"));
    expect(
      resolveOmpBinary(noManaged({ OMP_UI_OMP_PATH: "/nonexistent/omp", PATH: path.dirname(onPath) })),
    ).toBe(onPath);
  });

  it("prefers the app-managed copy over PATH", () => {
    const managed = fixtureOmp(path.join(mkTmp(), "managed"));
    const onPath = fixtureOmp(path.join(mkTmp(), "onpath"));
    // The managed candidate is whatever the env's OMP_UI_INSTALL_DIR says.
    const env = {
      OMP_UI_INSTALL_DIR: path.dirname(managed),
      PATH: path.dirname(onPath),
    };
    expect(resolveOmpBinary(env)).toBe(managed);
  });

  it("lets an explicit OMP_UI_OMP_PATH win over the managed copy", () => {
    const managed = fixtureOmp(path.join(mkTmp(), "managed"));
    const override = fixtureOmp(path.join(mkTmp(), "override"));
    const env = {
      OMP_UI_INSTALL_DIR: path.dirname(managed),
      OMP_UI_OMP_PATH: override,
      PATH: "",
    };
    expect(resolveOmpBinary(env)).toBe(override);
  });

  it("falls back to known install locations when PATH misses", () => {
    const result = resolveOmpBinary(noManaged({ PATH: "" }));
    const fallbacks = [
      path.join(home, ".bun", "bin", "omp"),
      "/usr/local/bin/omp",
      path.join(home, ".local", "bin", "omp"),
    ];
    const expected = fallbacks.find((f) => fs.existsSync(f)) ?? null;
    expect(result).toBe(expected);
  });
});

describe("managedOmpPath", () => {
  it("defaults under the user data home, overridable via OMP_UI_INSTALL_DIR", () => {
    expect(managedOmpPath({})).toBe(
      path.join(home, ".local", "share", "omp-ui", "bin", "omp"),
    );
    expect(managedOmpPath({ OMP_UI_INSTALL_DIR: "/custom/bin" })).toBe(
      path.join("/custom/bin", "omp"),
    );
  });
});
