import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GitRunner } from "./branches";
import type { GitOptions } from "./git";
import { ghConfigDir, ghLogins, resolveKnowledgeHome, resolveVaultProjectFolder, VAULT_FOLDER_MAX, vaultProjectFolder } from "./knowledge-home";
import type { KnowledgeHome, VaultRegistry } from "./types";

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

describe("vaultProjectFolder", () => {
  const cases: Array<[string, string, string | null, string]> = [
    ["a name and an owner", "Ansible", "AustinM731", "ansible-austinm731"],
    ["no owner", "Ansible", null, "ansible"],
    ["an owner that slugs empty", "ansible", "???", "ansible"],
    ["an owner that slugs equal to the name", "ansible", "ansible", "ansible-ansible"],
    ["punctuation in the owner", "app", "Acme Corp!", "app-acme-corp"],
  ];

  it.each(cases)("%s", (_label, name, owner, expected) => {
    expect(vaultProjectFolder(name, owner)).toBe(expected);
  });

  it("caps the whole name at VAULT_FOLDER_MAX with no trailing dash", () => {
    const folder = vaultProjectFolder("a".repeat(40), "b".repeat(40));
    expect(folder).toHaveLength(VAULT_FOLDER_MAX);
    expect(folder).not.toMatch(/-$/);
    expect(folder.startsWith("a".repeat(32))).toBe(true);
  });
});

describe("resolveVaultProjectFolder", () => {
  async function resolve(git: FakeGit, name = "Ansible"): Promise<string> {
    return resolveVaultProjectFolder(name, "/repo", { runGit: git.runGit });
  }

  it("suffixes an scp-style origin", async () => {
    await expect(resolve(repoGit({ origin: "git@bitbucket.org:InsideRealEstate/Ansible.git\n" }))).resolves.toBe(
      "ansible-insiderealestate",
    );
  });

  it("suffixes an ssh:// origin", async () => {
    await expect(resolve(repoGit({ origin: "ssh://git@github.com/AustinM731/ansible.git\n" }))).resolves.toBe(
      "ansible-austinm731",
    );
  });

  it("suffixes a sole non-origin remote", async () => {
    await expect(resolve(repoGit({ upstream: "https://github.com/SomeOwner/repo.git\n" }))).resolves.toBe(
      "ansible-someowner",
    );
  });

  it("falls back to the plain slug for two remotes without origin", async () => {
    const git = repoGit({ upstream: "git@github.com:A/a.git\n", fork: "git@github.com:B/b.git\n" });
    await expect(resolve(git)).resolves.toBe("ansible");
  });

  it("falls back to the plain slug for a local-path remote", async () => {
    await expect(resolve(repoGit({ origin: "/srv/git/ansible.git\n" }))).resolves.toBe("ansible");
  });

  it("falls back to the plain slug when get-url throws", async () => {
    await expect(resolve(repoGit({ origin: new Error("boom") }))).resolves.toBe("ansible");
  });

  it("falls back to the plain slug outside a git repo", async () => {
    const git = fakeGit({ "rev-parse --show-toplevel": new Error("not a git repository") });
    await expect(resolve(git)).resolves.toBe("ansible");
  });

  it("never rejects with the real git runner in a fresh non-repo dir", async () => {
    await expect(resolveVaultProjectFolder("Ansible", tmpDir())).resolves.toBe("ansible");
  });
});
