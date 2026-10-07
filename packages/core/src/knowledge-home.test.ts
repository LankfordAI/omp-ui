import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "./branches";
import type { GitOptions } from "./git";
import { ghConfigDir, ghLogins, resolveKnowledgeHome, resolveVaultProject, VAULT_FOLDER_MAX, vaultFolderSegment, vaultProjectIdentity } from "./knowledge-home";
import type { KnowledgeHome, VaultProjectIdentity, VaultRegistry } from "./types";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-khome-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const HOSTS_YML = `github.com:
    git_protocol: ssh
    users:
        AustinM731:
    user: AustinM731
`;

/** A gh config dir holding `hostsYml`, or no hosts.yml at all when null. */
function ghDir(hostsYml: string | null = HOSTS_YML): string {
  const dir = tmpDir();
  if (hostsYml !== null) fs.writeFileSync(path.join(dir, "hosts.yml"), hostsYml);
  return dir;
}

interface FakeGit {
  runGit: GitRunner;
  calls: Array<{ cwd: string; args: string[]; options: GitOptions | undefined }>;
}

/** Answers by `args.join(" ")`; an Error value (or a missing key) rejects. */
function fakeGit(answers: Record<string, string | Error>): FakeGit {
  const calls: FakeGit["calls"] = [];
  const runGit: GitRunner = async (cwd, args, options) => {
    calls.push({ cwd, args, options });
    const answer = answers[args.join(" ")];
    if (answer === undefined) throw new Error(`unexpected git ${args.join(" ")}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { runGit, calls };
}

function repoGit(remotes: Record<string, string | Error>): FakeGit {
  const answers: Record<string, string | Error> = {
    "rev-parse --show-toplevel": "/repo\n",
    remote: Object.keys(remotes).map((name) => `${name}\n`).join(""),
  };
  for (const [name, url] of Object.entries(remotes)) answers[`remote get-url ${name}`] = url;
  return fakeGit(answers);
}

const entry = (name: string) => ({ name, path: `/vaults/${name}`, homeFolder: "omp-ui/", allowWritesOutsideHome: false });
const NOTES: VaultRegistry = { vaults: [entry("Notes"), entry("Other")], defaultWriteVault: "Notes" };
const EMPTY: VaultRegistry = { vaults: [], defaultWriteVault: null };

describe("ghConfigDir", () => {
  it("prefers GH_CONFIG_DIR over everything", () => {
    expect(ghConfigDir({ GH_CONFIG_DIR: "/gh", XDG_CONFIG_HOME: "/xdg", APPDATA: "C:\\AppData" }, "win32", "/home/u")).toBe("/gh");
  });

  it("uses $XDG_CONFIG_HOME/gh next", () => {
    expect(ghConfigDir({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/u")).toBe("/xdg/gh");
  });

  it("uses %APPDATA%\\GitHub CLI on win32", () => {
    expect(ghConfigDir({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "win32", "C:\\Users\\u")).toBe(
      "C:\\Users\\u\\AppData\\Roaming\\GitHub CLI",
    );
  });

  it("falls back to home\\AppData\\Roaming\\GitHub CLI on win32 without APPDATA", () => {
    expect(ghConfigDir({}, "win32", "C:\\Users\\u")).toBe("C:\\Users\\u\\AppData\\Roaming\\GitHub CLI");
  });

  it("falls back to ~/.config/gh elsewhere", () => {
    expect(ghConfigDir({}, "darwin", "/Users/u")).toBe("/Users/u/.config/gh");
  });
});

describe("ghLogins", () => {
  it("collects users keys and the user value, lowercased, per host", () => {
    const logins = ghLogins(`GitHub.com:
    users:
        AustinM731:
        Second:
    user: Third
ghe.example.com:
    user: WorkLogin
`);
    expect([...logins.keys()]).toEqual(["github.com", "ghe.example.com"]);
    expect([...logins.get("github.com")!]).toEqual(["austinm731", "second", "third"]);
    expect([...logins.get("ghe.example.com")!]).toEqual(["worklogin"]);
  });

  it("reads the real hosts.yml shape", () => {
    expect([...ghLogins(HOSTS_YML).get("github.com")!]).toEqual(["austinm731"]);
  });

  it("stringifies a numeric login", () => {
    expect([...ghLogins("github.com:\n    user: 1234\n").get("github.com")!]).toEqual(["1234"]);
  });

  it("returns an empty map for malformed YAML or a scalar document", () => {
    expect(ghLogins("github.com: [unclosed").size).toBe(0);
    expect(ghLogins("just a string").size).toBe(0);
    expect(ghLogins("- a\n- b\n").size).toBe(0);
    expect(ghLogins("").size).toBe(0);
  });

  it("leaves out a host with no logins", () => {
    const logins = ghLogins(`github.com:
    git_protocol: ssh
    user: ""
ghe.example.com: plain
gitlab.com:
    user: Someone
`);
    expect([...logins.keys()]).toEqual(["gitlab.com"]);
  });
});

describe("resolveKnowledgeHome with a set home", () => {
  const cases: Array<[string, KnowledgeHome, VaultRegistry, unknown]> = [
    ["docs with a stale pin", { home: "docs", vault: "Gone" }, NOTES, { kind: "docs", source: "set" }],
    ["docs with an empty registry", { home: "docs" }, EMPTY, { kind: "docs", source: "set" }],
    ["vault with a registered pin", { home: "vault", vault: "Other" }, NOTES, { kind: "vault", vault: "Other", source: "set" }],
    ["vault with an unregistered pin", { home: "vault", vault: "Gone" }, NOTES, { kind: "broken", pinned: "Gone" }],
    ["both with a pin and an empty registry", { home: "both", vault: "Gone" }, EMPTY, { kind: "broken", pinned: "Gone" }],
    ["vault with no vaults", { home: "vault" }, EMPTY, { kind: "none" }],
    ["both with no vaults", { home: "both" }, EMPTY, { kind: "none" }],
    ["vault without a pin", { home: "vault" }, NOTES, { kind: "vault", vault: "Notes", source: "set" }],
    ["both without a pin", { home: "both" }, NOTES, { kind: "both", vault: "Notes", source: "set" }],
    ["both with a registered pin", { home: "both", vault: "Other" }, NOTES, { kind: "both", vault: "Other", source: "set" }],
  ];

  it.each(cases)("%s", async (_label, home, reg, expected) => {
    const git = fakeGit({});
    await expect(resolveKnowledgeHome(home, "/repo", reg, { runGit: git.runGit, env: { GH_CONFIG_DIR: ghDir() } })).resolves.toEqual(expected);
    expect(git.calls).toEqual([]);
  });
});

describe("resolveKnowledgeHome routing default", () => {
  const DOCS = { kind: "docs", source: "default" };
  const VAULT = { kind: "vault", vault: "Notes", source: "default" };

  async function resolveDefault(git: FakeGit, dir = ghDir(), reg = NOTES) {
    const result = await resolveKnowledgeHome(null, "/repo", reg, { runGit: git.runGit, env: { GH_CONFIG_DIR: dir } });
    for (const call of git.calls) expect(call.options).toEqual({ timeoutMs: 5000 });
    expect(git.calls.length).toBeGreaterThan(0);
    return result;
  }

  it("routes to docs outside a git repo", async () => {
    const git = fakeGit({ "rev-parse --show-toplevel": new Error("not a git repository") });
    await expect(resolveDefault(git)).resolves.toEqual(DOCS);
  });

  it("routes to docs for a repo with no remotes", async () => {
    await expect(resolveDefault(repoGit({}))).resolves.toEqual(DOCS);
  });

  it("routes to docs when the owner matches a gh login case-insensitively", async () => {
    await expect(resolveDefault(repoGit({ origin: "git@github.com:AUSTINM731/x.git\n" }))).resolves.toEqual(DOCS);
  });

  it("routes to the default vault when the owner differs", async () => {
    await expect(resolveDefault(repoGit({ origin: "https://github.com/someone-else/x.git\n" }))).resolves.toEqual(VAULT);
  });

  it("routes to the default vault without a hosts.yml", async () => {
    await expect(resolveDefault(repoGit({ origin: "git@github.com:AustinM731/x.git\n" }), ghDir(null))).resolves.toEqual(VAULT);
  });

  it("routes to the default vault for the same owner on a different host", async () => {
    await expect(resolveDefault(repoGit({ origin: "git@gitlab.com:AustinM731/x.git\n" }))).resolves.toEqual(VAULT);
  });

  it("routes to the default vault for two remotes without origin", async () => {
    const git = repoGit({ upstream: "git@github.com:AustinM731/x.git\n", fork: "git@github.com:AustinM731/y.git\n" });
    await expect(resolveDefault(git)).resolves.toEqual(VAULT);
  });

  it("routes to docs when a sole non-origin remote's owner matches", async () => {
    await expect(resolveDefault(repoGit({ upstream: "ssh://git@github.com/AustinM731/x.git\n" }))).resolves.toEqual(DOCS);
  });

  it("prefers origin among several remotes", async () => {
    const git = repoGit({ upstream: "git@github.com:someone-else/x.git\n", origin: "git@github.com:AustinM731/x.git\n" });
    await expect(resolveDefault(git)).resolves.toEqual(DOCS);
    expect(git.calls.map((call) => call.args.join(" "))).toContain("remote get-url origin");
  });

  it("routes to the default vault when get-url throws", async () => {
    await expect(resolveDefault(repoGit({ origin: new Error("boom") }))).resolves.toEqual(VAULT);
  });

  it("routes to the default vault for a local-path remote", async () => {
    await expect(resolveDefault(repoGit({ origin: "/srv/git/x.git\n" }))).resolves.toEqual(VAULT);
  });

  it("resolves a vault outcome with an empty registry to none", async () => {
    await expect(resolveDefault(repoGit({ origin: "https://github.com/someone-else/x.git\n" }), ghDir(), EMPTY)).resolves.toEqual({
      kind: "none",
    });
  });

  it("routes to docs with the real git runner in a fresh non-repo dir", async () => {
    await expect(resolveKnowledgeHome(null, tmpDir(), NOTES, { env: { GH_CONFIG_DIR: ghDir() } })).resolves.toEqual(DOCS);
  });
});

describe("vaultProjectIdentity", () => {
  it("nests Owner/Repo in original case, keyed by the lowercased path", () => {
    expect(vaultProjectIdentity("omp-ui", ["LankfordAI", "omp-ui"])).toEqual({
      key: "lankfordai/omp-ui",
      folder: "LankfordAI/omp-ui",
      indexTitle: "omp-ui Index",
      legacy: { suffixed: "omp-ui-lankfordai", plain: "omp-ui" },
    });
  });

  it("computes the same folder for a clone in a differently named directory", () => {
    expect(vaultProjectIdentity("omp-ui-2", ["LankfordAI", "omp-ui"])).toEqual({
      key: "lankfordai/omp-ui",
      folder: "LankfordAI/omp-ui",
      indexTitle: "omp-ui Index",
      legacy: { suffixed: "omp-ui-2-lankfordai", plain: "omp-ui-2" },
    });
  });

  it("nests every GitLab subgroup segment", () => {
    const identity = vaultProjectIdentity("repo", ["grp", "sub", "repo"]);
    expect(identity.key).toBe("grp/sub/repo");
    expect(identity.folder).toBe("grp/sub/repo");
    expect(identity.indexTitle).toBe("repo Index");
  });

  it("is plain for an owner-only path", () => {
    expect(vaultProjectIdentity("Ansible", ["owner"])).toEqual({
      key: null,
      folder: "ansible",
      indexTitle: "ansible Index",
      legacy: null,
    });
  });

  it("is plain with no segments", () => {
    expect(vaultProjectIdentity("Ansible", null)).toEqual({
      key: null,
      folder: "ansible",
      indexTitle: "ansible Index",
      legacy: null,
    });
  });

  it("blanks the plain legacy name when it is the owner folder itself", () => {
    expect(vaultProjectIdentity("Acme", ["Acme", "tools"]).legacy?.plain).toBe("");
  });
});

describe("vaultFolderSegment", () => {
  const cases: Array<[string, string, string | null]> = [
    ["a leading dot", ".hidden", "hidden"],
    ["an illegal character", "a:b", "a-b"],
    ["a reserved Windows name", "CON", "CON-"],
    ["only dots", "...", null],
  ];

  it.each(cases)("%s", (_label, raw, expected) => {
    expect(vaultFolderSegment(raw)).toBe(expected);
  });

  it("caps a segment at VAULT_FOLDER_MAX", () => {
    expect(vaultFolderSegment("a".repeat(70))).toBe("a".repeat(VAULT_FOLDER_MAX));
    expect(VAULT_FOLDER_MAX).toBe(64);
  });
});

describe("resolveVaultProject", () => {
  const PLAIN: VaultProjectIdentity = { key: null, folder: "ansible", indexTitle: "ansible Index", legacy: null };

  async function resolve(git: FakeGit, name = "Ansible"): Promise<VaultProjectIdentity> {
    return resolveVaultProject(name, "/repo", { runGit: git.runGit });
  }

  it("nests an scp-style origin", async () => {
    await expect(resolve(repoGit({ origin: "git@bitbucket.org:InsideRealEstate/Ansible.git\n" }))).resolves.toEqual({
      key: "insiderealestate/ansible",
      folder: "InsideRealEstate/Ansible",
      indexTitle: "Ansible Index",
      legacy: { suffixed: "ansible-insiderealestate", plain: "ansible" },
    });
  });

  it("nests an ssh:// origin", async () => {
    await expect(resolve(repoGit({ origin: "ssh://git@github.com/AustinM731/ansible.git\n" }))).resolves.toEqual({
      key: "austinm731/ansible",
      folder: "AustinM731/ansible",
      indexTitle: "ansible Index",
      legacy: { suffixed: "ansible-austinm731", plain: "ansible" },
    });
  });

  it("nests a sole non-origin remote", async () => {
    await expect(resolve(repoGit({ upstream: "https://github.com/SomeOwner/repo.git\n" }))).resolves.toEqual({
      key: "someowner/repo",
      folder: "SomeOwner/repo",
      indexTitle: "repo Index",
      legacy: { suffixed: "ansible-someowner", plain: "ansible" },
    });
  });

  it("decodes percent-encoded path segments", async () => {
    const identity = await resolve(repoGit({ origin: "https://github.com/Acme/My%20Repo.git\n" }));
    expect(identity.folder).toBe("Acme/My Repo");
    expect(identity.key).toBe("acme/my repo");
    expect(identity.indexTitle).toBe("My Repo Index");
  });

  it("is plain for two remotes without origin", async () => {
    const git = repoGit({ upstream: "git@github.com:A/a.git\n", fork: "git@github.com:B/b.git\n" });
    await expect(resolve(git)).resolves.toEqual(PLAIN);
  });

  it("is plain for a local-path remote", async () => {
    await expect(resolve(repoGit({ origin: "/srv/git/ansible.git\n" }))).resolves.toEqual(PLAIN);
  });

  it("is plain when get-url throws", async () => {
    await expect(resolve(repoGit({ origin: new Error("boom") }))).resolves.toEqual(PLAIN);
  });

  it("is plain outside a git repo", async () => {
    const git = fakeGit({ "rev-parse --show-toplevel": new Error("not a git repository") });
    await expect(resolve(git)).resolves.toEqual(PLAIN);
  });

  it("never rejects with the real git runner in a fresh non-repo dir", async () => {
    await expect(resolveVaultProject("Ansible", tmpDir())).resolves.toEqual(PLAIN);
  });
});
