import { git } from "./git";
import { isNamedRemote, listRemoteNames, resolveDefaultRemote, type GitRunner } from "./branches";

/**
 * The host's new-pull-request page for `base...head` (issue #414): a link, not
 * an API call. omp-ui holds no token and opens no GitHub session — the URL is
 * built from the remote's own web origin, so it works for github.com, a GitHub
 * Enterprise install, and GitLab alike, and degrades to a browser error page
 * (never a wrong write) when the host-label heuristic guesses wrong.
 */

/** A remote path as the web wants it: no leading/trailing slashes, no `.git`. */
function webPath(raw: string): string {
  return raw.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/, "");
}

/**
 * Any git remote URL to its web origin (`https://host/owner/repo`), or null
 * when the remote has no web face at all — a local path, `file://`, or
 * something unparseable. Credentials are dropped here and never echoed
 * onward: an `https://user:token@host/…` remote must not leak its token into a
 * URL the user is about to read and copy.
 */
export function parseRemoteWebUrl(raw: string): string | null {
  const url = raw.trim();
  if (url === "") return null;

  if (url.includes("://")) {
    const scheme = url.slice(0, url.indexOf("://")).toLowerCase();
    // ssh/http/https/git have a web face; file:// and friends do not.
    if (!["ssh", "https", "http", "git"].includes(scheme)) return null;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const path = webPath(parsed.pathname);
    if (parsed.hostname === "" || path === "") return null;
    return `https://${parsed.hostname}/${path}`;
  }

  // scp-style `[user@]host:path`, the form `git@github.com:owner/repo.git`
  // prints. The colon must come before any slash, else it is a plain path.
  const scp = /^(?:[^/@]+@)?([^/:]+):(.+)$/.exec(url);
  if (scp === null) return null;
  const host = (scp[1] ?? "").trim();
  const path = webPath(scp[2] ?? "");
  if (host === "" || path === "" || path.includes("\\")) return null;
  return `https://${host}/${path}`;
}

/**
 * The remote whose URL names the web host: `head`'s configured remote when it
 * is a real named remote, else the repo's default push target — issue #414's
 * chain minus the caller's override, since a link builder has none.
 */
async function resolveWebRemote(
  root: string,
  head: string,
  runGit: GitRunner,
): Promise<string | null> {
  const configured = (
    await runGit(root, ["config", "--get", `branch.${head}.remote`], {
      allowExit: [1],
    }).catch(() => "")
  ).trim();
  if (isNamedRemote(configured)) {
    try {
      if ((await listRemoteNames(root, runGit)).includes(configured)) return configured;
    } catch {
      return null;
    }
  }
  return resolveDefaultRemote(root, runGit);
}

/**
 * The host's new-PR URL for `base...head`, or null when the remote cannot be
 * read or has no web face. The three-dot separator stays literal: that is
 * GitHub's merge-base compare view, which is exactly what a PR proposes.
 */
export async function pullRequestUrl(
  projectCwd: string,
  base: string,
  head: string,
  runGit: GitRunner = git,
): Promise<string | null> {
  let root: string;
  try {
    root = (await runGit(projectCwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch {
    return null;
  }
  const remote = await resolveWebRemote(root, head, runGit);
  if (remote === null) return null;

  let raw: string;
  try {
    raw = await runGit(root, ["remote", "get-url", "--push", remote]);
  } catch {
    return null;
  }
  const web = parseRemoteWebUrl(raw);
  if (web === null) return null;

  const origin = new URL(web);
  const host = origin.hostname;
  const path = webPath(origin.pathname);
  const source = encodeURIComponent(head);
  const target = encodeURIComponent(base);

  // Host-label heuristic (issue #414), no probing and no config: a
  // gitlab-labelled host gets the new-MR form, everything else the GitHub
  // compare form — right for github.com and every GHE install. A wrong guess
  // lands on a browser error page, never on a write.
  if (host === "gitlab.com" || host.split(".")[0]!.includes("gitlab")) {
    return (
      `https://${host}/-/merge_requests/new` +
      `?merge_request%5Bsource_branch%5D=${source}` +
      `&merge_request%5Btarget_branch%5D=${target}`
    );
  }
  return `https://${host}/${path}/compare/${target}...${source}`;
}
