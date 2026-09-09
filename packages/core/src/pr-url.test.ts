import { describe, expect, it } from "vitest";
import type { GitRunner } from "./branches";
import { parseRemoteWebUrl, pullRequestUrl } from "./pr-url";

interface FakeRepo {
  /** Remote name → URL as plain `remote get-url` prints it. */
  remotes: Record<string, string>;
  /** Push URLs for a remote that pushes somewhere else (`remote get-url --push`). */
  pushUrls?: Record<string, string>;
  /** `branch.<head>.remote`; absent when the head has no configured remote. */
  configured?: string;
  /** False makes the project directory not a git repository. */
  inRepo?: boolean;
}

function fakeGit(repo: FakeRepo): GitRunner {
  return async (_cwd, args) => {
    if (args[0] === "rev-parse" && args[1] === "--show-toplevel") {
      if (repo.inRepo === false) throw new Error("not a git repository");
      return "/repo\n";
    }
    if (args[0] === "config" && args[1] === "--get") return `${repo.configured ?? ""}\n`;
    if (args[0] === "remote" && args[1] === "get-url") {
      const name = args.at(-1)!;
      const override = args.includes("--push") ? repo.pushUrls?.[name] : undefined;
      const url = override ?? repo.remotes[name];
      if (url === undefined) throw new Error(`No such remote: ${name}`);
      return `${url}\n`;
    }
    if (args[0] === "remote") return `${Object.keys(repo.remotes).join("\n")}\n`;
    throw new Error(`Unexpected git invocation: ${args.join(" ")}`);
  };
}

const GITHUB = "git@github.com:owner/repo.git";

describe("parseRemoteWebUrl", () => {
  it("rewrites every host-bearing remote form to one https origin", () => {
    expect(parseRemoteWebUrl("git@github.com:owner/repo.git")).toBe("https://github.com/owner/repo");
    expect(parseRemoteWebUrl("git@github.com:owner/repo")).toBe("https://github.com/owner/repo");
    // A non-standard ssh port belongs to the transport, never to the web link.
    expect(parseRemoteWebUrl("ssh://git@host:7999/owner/repo.git")).toBe("https://host/owner/repo");
    expect(parseRemoteWebUrl("git://host/owner/repo")).toBe("https://host/owner/repo");
    expect(parseRemoteWebUrl("github.com:owner/repo")).toBe("https://github.com/owner/repo");
  });

  it("keeps subgroup depth", () => {
    expect(parseRemoteWebUrl("git@gitlab.example.com:group/subgroup/repo.git")).toBe(
      "https://gitlab.example.com/group/subgroup/repo",
    );
  });

  it("never echoes credentials", () => {
    expect(parseRemoteWebUrl("https://user:token@github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo",
    );
    expect(parseRemoteWebUrl("https://token@github.com/owner/repo.git")).toBe(
      "https://github.com/owner/repo",
    );
  });

  it("normalizes trailing slashes and the .git suffix in either order", () => {
    expect(parseRemoteWebUrl("https://host/owner/repo/")).toBe("https://host/owner/repo");
    expect(parseRemoteWebUrl("https://host/owner/repo.git/")).toBe("https://host/owner/repo");
  });

  it("returns null for a remote with no web face", () => {
    expect(parseRemoteWebUrl("")).toBeNull();
    expect(parseRemoteWebUrl("   ")).toBeNull();
    expect(parseRemoteWebUrl("repo")).toBeNull();
    expect(parseRemoteWebUrl("/srv/git/repo.git")).toBeNull();
    expect(parseRemoteWebUrl("file:///srv/git/repo.git")).toBeNull();
    // A Windows share path is a path, not `host:path`.
    expect(parseRemoteWebUrl("server:c:\\repos\\proj")).toBeNull();
  });
});

describe("pullRequestUrl", () => {
  it("builds github's compare link with both refs percent-encoded", async () => {
    const url = await pullRequestUrl("/repo", "main", "feature/x", fakeGit({ remotes: { origin: GITHUB } }));
    expect(url).toBe("https://github.com/owner/repo/compare/main...feature%2Fx");
  });

  it("drops the ssh port instead of copying it into the link", async () => {
    const remotes = { origin: "ssh://git@build.example.com:7999/acme/repo.git" };
    expect(await pullRequestUrl("/repo", "release/2.0", "feature/x", fakeGit({ remotes }))).toBe(
      "https://build.example.com/acme/repo/compare/release%2F2.0...feature%2Fx",
    );
  });

  it("uses gitlab's new-merge-request form for a gitlab-labelled host", async () => {
    expect(
      await pullRequestUrl(
        "/repo",
        "main",
        "feature/x",
        fakeGit({ remotes: { origin: "https://gitlab.com/acme/repo.git" } }),
      ),
    ).toBe(
      "https://gitlab.com/-/merge_requests/new" +
        "?merge_request%5Bsource_branch%5D=feature%2Fx&merge_request%5Btarget_branch%5D=main",
    );
    // Self-hosted gitlab is labelled by its first host label, port included.
    expect(
      await pullRequestUrl(
        "/repo",
        "main",
        "dev",
        fakeGit({ remotes: { origin: "ssh://git@gitlab.corp.example:2222/team/repo.git" } }),
      ),
    ).toBe(
      "https://gitlab.corp.example/-/merge_requests/new" +
        "?merge_request%5Bsource_branch%5D=dev&merge_request%5Btarget_branch%5D=main",
    );
  });

  it("guesses github for a host it does not recognise", async () => {
    // Wrong guesses land on a browser error page, so the GitHub form stays the
    // default: it is right for github.com and every Enterprise install.
    expect(
      await pullRequestUrl(
        "/repo",
        "main",
        "feature/x",
        fakeGit({ remotes: { origin: "git@code.example.com:acme/repo.git" } }),
      ),
    ).toBe("https://code.example.com/acme/repo/compare/main...feature%2Fx");
  });

  it("reads the remote's push url when the remote pushes somewhere else", async () => {
    const repo: FakeRepo = {
      remotes: { origin: "git@github.com:my-fork/repo.git" },
      pushUrls: { origin: "git@github.com:acme/repo.git" },
    };
    expect(await pullRequestUrl("/repo", "main", "feature/x", fakeGit(repo))).toBe(
      "https://github.com/acme/repo/compare/main...feature%2Fx",
    );
  });

  it("prefers the head branch's configured remote over origin", async () => {
    const repo: FakeRepo = {
      configured: "upstream",
      remotes: { origin: "git@github.com:my-fork/repo.git", upstream: "git@github.com:acme/repo.git" },
    };
    expect(await pullRequestUrl("/repo", "main", "feature/x", fakeGit(repo))).toBe(
      "https://github.com/acme/repo/compare/main...feature%2Fx",
    );
  });

  it("ignores a configured remote that no longer exists", async () => {
    const repo: FakeRepo = { configured: "gone", remotes: { origin: GITHUB } };
    expect(await pullRequestUrl("/repo", "main", "feature/x", fakeGit(repo))).toBe(
      "https://github.com/owner/repo/compare/main...feature%2Fx",
    );
  });

  it("falls back to the sole remote when there is no origin", async () => {
    const repo: FakeRepo = { remotes: { team: "git@github.com:acme/widgets.git" } };
    expect(await pullRequestUrl("/repo", "main", "dev", fakeGit(repo))).toBe(
      "https://github.com/acme/widgets/compare/main...dev",
    );
  });

  it("refuses to guess between remotes no rule names", async () => {
    const repo: FakeRepo = { remotes: { team: GITHUB, mirror: "git@host:other/repo.git" } };
    expect(await pullRequestUrl("/repo", "main", "dev", fakeGit(repo))).toBeNull();
  });

  it("returns null with no repository or a remote without a web face", async () => {
    expect(
      await pullRequestUrl("/nowhere", "main", "dev", fakeGit({ remotes: { origin: GITHUB }, inRepo: false })),
    ).toBeNull();
    expect(await pullRequestUrl("/repo", "main", "dev", fakeGit({ remotes: {} }))).toBeNull();
    expect(
      await pullRequestUrl("/repo", "main", "dev", fakeGit({ remotes: { origin: "/srv/git/repo.git" } })),
    ).toBeNull();
  });
});
