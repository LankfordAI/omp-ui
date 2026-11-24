// Theme repositories over the network (#1178, ADR-0096). Node only: the owning
// host's main process reads public GitHub repositories with it; the renderer
// never imports it. Every URL is built here from a canonical owner/repo, a
// 40-hex commit and a validated path, against two fixed https hosts, with
// redirects refused, no Authorization header, size caps and a timeout.
import { createHash } from "node:crypto";
import { checkBackdropBytes, type ThemeBackdropKind } from "./theme-backdrop";
import type { StoredThemeDraft } from "./theme-file";
import { GIT_SHA } from "./theme-origin";
import {
  REPOSITORY_THEME_FILE_BYTES_MAX,
  THEME_INDEX_BYTES_MAX,
  THEME_INDEX_FILE,
  THEME_INDEX_V2_BYTES_MAX,
  THEME_INDEX_V2_FILE,
  THEME_INDEX_V3_BYTES_MAX,
  THEME_INDEX_V3_FILE,
  parseThemeIndex,
  parseThemeIndexV2,
  parseThemeIndexV3,
  sameThemeSeeds,
  type ThemeIndexEntry,
  type ThemeRepositoryEntry,
  type ThemeRepositoryListingResult,
} from "./theme-repository-format";
import { isObject } from "./guards";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";
const TIMEOUT_MS = 10_000;
const SHA_BYTES_MAX = 64;
const TREE_BYTES_MAX = 1024 * 1024;
const API_HEADERS = { "User-Agent": "omp-ui", "X-GitHub-Api-Version": "2022-11-28" };
const RAW_HEADERS = { "User-Agent": "omp-ui" };
const INTEGRITY = "a file GitHub served does not match the repository's commit";

export interface ThemeRepositoryResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  body: {
    getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> };
  } | null;
}

export type ThemeRepositoryFetch = (
  url: string,
  init: { signal: AbortSignal; redirect: "error"; headers: Record<string, string> },
) => Promise<ThemeRepositoryResponse>;

export const defaultThemeRepositoryFetch = fetch as unknown as ThemeRepositoryFetch;

/** git's blob id: SHA-1 over "blob <length>\0" + bytes (verified against GitHub's tree API). */
export function gitBlobSha(bytes: Uint8Array): string {
  return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

type GetResult = { ok: true; bytes: Uint8Array } | { ok: false; message: string };
const NOT_FOUND = "not-found";
const TOO_LARGE = "too-large";

/** One GET against a fixed host: no redirects, no credentials, capped body, 10 s. */
async function get(
  url: string,
  headers: Record<string, string>,
  max: number,
  now: () => number,
  fetchImpl: ThemeRepositoryFetch,
): Promise<GetResult> {
  let res: ThemeRepositoryResponse;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS), redirect: "error", headers });
  } catch (err) {
    const cause = err instanceof TypeError ? (err as TypeError & { cause?: unknown }).cause : undefined;
    if (cause instanceof Error && cause.message === "unexpected redirect") {
      return {
        ok: false,
        message:
          "GitHub redirected the request and omp-ui follows no redirects; if the repository was renamed, add it under its new name",
      };
    }
    return { ok: false, message: "could not reach GitHub" };
  }
  if (!res.ok) {
    await res.body?.getReader().cancel().catch(() => {});
    if ((res.status === 403 || res.status === 429) && res.headers.get("x-ratelimit-remaining") === "0") {
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const m = Math.max(1, Math.ceil((reset * 1000 - now()) / 60_000) || 1);
      return {
        ok: false,
        message: `GitHub's limit for anonymous requests from this network is used up; try again in ${m} ${m === 1 ? "minute" : "minutes"}`,
      };
    }
    if (res.status === 404) return { ok: false, message: NOT_FOUND };
    return { ok: false, message: `GitHub answered HTTP ${res.status}` };
  }
  if (res.body === null) return { ok: true, bytes: new Uint8Array(0) };
  const reader = res.body.getReader();
  const declared = Number(res.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > max) {
    await reader.cancel().catch(() => {});
    return { ok: false, message: TOO_LARGE };
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.length;
      if (total > max) {
        await reader.cancel().catch(() => {});
        return { ok: false, message: TOO_LARGE };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, message: "could not reach GitHub" };
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.length;
  }
  return { ok: true, bytes };
}

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

/**
 * The repository's themes at `commit`, or at HEAD when `commit` is null.
 * `repository` must already be canonical.
 */
export async function fetchThemeRepositoryListing(
  repository: string,
  commit: string | null,
  fetchImpl: ThemeRepositoryFetch = defaultThemeRepositoryFetch,
  now: () => number = Date.now,
): Promise<ThemeRepositoryListingResult> {
  let sha = commit;
  if (sha === null) {
    const head = await get(
      `${API}/repos/${repository}/commits/HEAD`,
      { ...API_HEADERS, Accept: "application/vnd.github.sha" },
      SHA_BYTES_MAX,
      now,
      fetchImpl,
    );
    if (!head.ok) {
      if (head.message === NOT_FOUND) {
        return { ok: false, message: "repository not found; it must be a public GitHub repository" };
      }
      if (head.message === TOO_LARGE) return { ok: false, message: "GitHub answered with an unexpected commit" };
      return head;
    }
    sha = decode(head.bytes).trim();
    if (!GIT_SHA.test(sha)) return { ok: false, message: "GitHub answered with an unexpected commit" };
  }

  const treeRes = await get(
    `${API}/repos/${repository}/git/trees/${sha}?recursive=1`,
    { ...API_HEADERS, Accept: "application/vnd.github+json" },
    TREE_BYTES_MAX,
    now,
    fetchImpl,
  );
  if (!treeRes.ok) {
    if (treeRes.message === TOO_LARGE) return { ok: false, message: "the repository has too many files to list" };
    if (treeRes.message === NOT_FOUND) {
      return { ok: false, message: "repository not found; it must be a public GitHub repository" };
    }
    return treeRes;
  }
  let tree: unknown;
  try {
    tree = JSON.parse(decode(treeRes.bytes));
  } catch {
    return { ok: false, message: "GitHub answered with an unreadable tree" };
  }
  if (!isObject(tree) || !Array.isArray(tree.tree)) {
    return { ok: false, message: "GitHub answered with an unreadable tree" };
  }
  if (tree.truncated === true) return { ok: false, message: "the repository has too many files to list" };
  const files = new Map<string, { sha: string; size: number }>();
  for (const row of tree.tree) {
    if (!isObject(row) || row.type !== "blob") continue;
    if (typeof row.path !== "string" || typeof row.sha !== "string" || !GIT_SHA.test(row.sha)) continue;
    const size = typeof row.size === "number" && Number.isFinite(row.size) ? row.size : Number.POSITIVE_INFINITY;
    files.set(row.path, { sha: row.sha, size });
  }

  // Prefer v3 (#1320), then v2 (#1210), then v1; a present index that fails to parse is an error, never a fallback.
  const v3 = files.get(THEME_INDEX_V3_FILE);
  const v2 = v3 === undefined ? files.get(THEME_INDEX_V2_FILE) : undefined;
  const indexName =
    v3 !== undefined ? THEME_INDEX_V3_FILE : v2 !== undefined ? THEME_INDEX_V2_FILE : THEME_INDEX_FILE;
  const indexFile = v3 ?? v2 ?? files.get(THEME_INDEX_FILE);
  const indexMax =
    v3 !== undefined ? THEME_INDEX_V3_BYTES_MAX : v2 !== undefined ? THEME_INDEX_V2_BYTES_MAX : THEME_INDEX_BYTES_MAX;
  if (indexFile === undefined) return { ok: false, message: `no ${THEME_INDEX_FILE} at the repository root` };
  const indexRes = await get(`${RAW}/${repository}/${sha}/${indexName}`, RAW_HEADERS, indexMax, now, fetchImpl);
  if (!indexRes.ok) {
    if (indexRes.message === TOO_LARGE) {
      const limitKiB = Math.round(indexMax / 1024);
      return { ok: false, message: `${indexName} is larger than ${limitKiB} KiB` };
    }
    if (indexRes.message === NOT_FOUND) return { ok: false, message: `no ${indexName} at the repository root` };
    return indexRes;
  }
  if (gitBlobSha(indexRes.bytes) !== indexFile.sha) return { ok: false, message: INTEGRITY };
  const indexText = decode(indexRes.bytes);
  const index =
    v3 !== undefined
      ? parseThemeIndexV3(indexText)
      : v2 !== undefined
        ? parseThemeIndexV2(indexText)
        : parseThemeIndex(indexText);
  if (!index.ok) return index;
  const themes: ThemeRepositoryEntry[] = [];
  let skipped = 0;
  for (const entry of index.entries) {
    const file = files.get(entry.path);
    if (file === undefined || file.size > REPOSITORY_THEME_FILE_BYTES_MAX) {
      skipped += 1;
      continue;
    }
    themes.push({ ...entry, blob: file.sha, size: file.size });
  }
  return { ok: true, listing: { repository, commit: sha, themes, skipped } };
}

/** The theme file an entry names, at `commit`, checked against the entry's blob. */
export async function fetchRepositoryThemeFile(
  repository: string,
  commit: string,
  entry: ThemeRepositoryEntry,
  fetchImpl: ThemeRepositoryFetch = defaultThemeRepositoryFetch,
  now: () => number = Date.now,
): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  const res = await get(`${RAW}/${repository}/${commit}/${entry.path}`, RAW_HEADERS, REPOSITORY_THEME_FILE_BYTES_MAX, now, fetchImpl);
  if (!res.ok) {
    if (res.message === NOT_FOUND) return { ok: false, message: "the theme file is missing at that commit" };
    if (res.message === TOO_LARGE) return { ok: false, message: "the theme file is larger than 24 MiB" };
    return res;
  }
  if (gitBlobSha(res.bytes) !== entry.blob) return { ok: false, message: INTEGRITY };
  return { ok: true, text: decode(res.bytes) };
}

const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** True when the parsed file's trimmed label, seeds (sameThemeSeeds) or sniffed backdrop kind differ from the entry. */
export function repositoryThemeMismatch(entry: ThemeIndexEntry, draft: StoredThemeDraft): boolean {
  let kind: ThemeBackdropKind | "invalid" | null = null;
  if (draft.backdrop !== null) {
    if (draft.backdrop.from !== "bytes" || !STRICT_BASE64.test(draft.backdrop.data)) {
      kind = "invalid";
    } else {
      const check = checkBackdropBytes(Buffer.from(draft.backdrop.data, "base64"));
      kind = check.ok ? check.kind : "invalid";
    }
  }
  return draft.label.trim() !== entry.label || !sameThemeSeeds(draft.seeds, entry.seeds) || kind !== entry.backdrop;
}
