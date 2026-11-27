/**
 * Project requests (#1228, ADR-0099): an agent's request to register or clone
 * a project on this computer, held until the user answers its card in the
 * session. Only an Allow on that card adds the project. This module holds the
 * pure, shared pieces: the prompt shape the summary publishes, the clone
 * source parser, and the repository name rule the member clone paths share.
 */

export type ProjectRequestVerb = "register" | "clone";

/** Published on SessionSummary while a request waits for the user; ephemeral, never persisted. */
export interface ProjectRequestPrompt {
  /** randomUUID per request. */
  promptId: string;
  verb: ProjectRequestVerb;
  /** register: canonical checkout path. clone: the credential-free URL as validated. */
  source: string;
  /** clone: directory name derived from the URL; register: null. */
  name: string | null;
  /** clone: proposed parent folder; register: null. */
  defaultParent: string | null;
  /** register: `git remote get-url origin`, or null. */
  origin: string | null;
  /** Relative paths found in the checkout that run code or carry config in sessions there. */
  executableConfig: string[];
  /** ISO timestamp. */
  requestedAt: string;
}

export type ProjectRequestDecision = { kind: "allow"; parent: string | null } | { kind: "deny" };

/** Paths that run code or carry secrets/config in every session started in a project. */
export const EXECUTABLE_CONFIG_PATHS: readonly string[] = [
  ".omp/extensions",
  ".omp/hooks",
  ".omp/tools",
  ".omp/mcp.json",
  ".omp/config.yml",
  ".omp/settings.json",
  ".cursor/mcp.json",
  ".env",
  ".env.local",
];

/** The local clone's absolute wall-clock cap; the host call's watchdog is rearmed a little past it. */
export const LOCAL_CLONE_TIMEOUT_MS = 3_600_000;
/** Kill a local clone whose stderr has been silent this long: a stalled transport, not a slow clone. */
export const LOCAL_CLONE_INACTIVITY_MS = 180_000;
/** Project requests one agent run may raise; the count resets on agent_start. */
export const PROJECT_REQUESTS_PER_RUN = 3;

/**
 * The directory name a clone of `pathname` lands in: the last non-empty
 * segment, `.git` stripped, every character outside [A-Za-z0-9._-] removed.
 * Null when nothing usable remains.
 */
export function cloneRepositoryName(pathname: string): string | null {
  const segments = pathname.split("/").filter((s) => s !== "");
  const name = (segments[segments.length - 1] ?? "").replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]/g, "");
  return name === "" || name === "." || name === ".." ? null : name;
}

export type CloneSource =
  | { ok: true; url: string; name: string; transport: "https" | "ssh" }
  | { ok: false; reason: string };

const SCP_LIKE = /^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:(?!\/\/)[^\s]+$/;

/**
 * The clone sources a local project request accepts: https without
 * credentials, `ssh://`, and scp-like `user@host:path`. Everything else —
 * other schemes (http, file, git, ext::), local paths, option-shaped input —
 * is refused with a reason the agent can read.
 */
export function parseCloneSource(raw: string): CloneSource {
  const input = raw.trim();
  if (input === "") return { ok: false, reason: "repositoryUrl is empty" };
  if (input.startsWith("-")) return { ok: false, reason: "repositoryUrl must not start with -" };
  if (/\s/.test(input)) return { ok: false, reason: "repositoryUrl must not contain whitespace" };
  if (SCP_LIKE.test(input)) {
    const name = cloneRepositoryName(input.slice(input.indexOf(":") + 1));
    if (name === null) return { ok: false, reason: "repositoryUrl has no usable repository name" };
    return { ok: true, url: input, name, transport: "ssh" };
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: "repositoryUrl must be an https or SSH URL, not a local path" };
  }
  if (url.protocol === "https:") {
    if (url.username !== "" || url.password !== "") return { ok: false, reason: "repositoryUrl must not carry credentials" };
  } else if (url.protocol === "ssh:") {
    if (url.password !== "") return { ok: false, reason: "repositoryUrl must not carry credentials" };
    if (url.hostname === "") return { ok: false, reason: "repositoryUrl has no host" };
  } else {
    return { ok: false, reason: `clone accepts https or SSH URLs only, not ${url.protocol}` };
  }
  const name = cloneRepositoryName(url.pathname);
  if (name === null) return { ok: false, reason: "repositoryUrl has no usable repository name" };
  return { ok: true, url: url.toString(), name, transport: url.protocol === "https:" ? "https" : "ssh" };
}
