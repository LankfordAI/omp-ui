import { describe, expect, it } from "vitest";
import type { StoredThemeDraft } from "./theme-file";
import {
  fetchRepositoryThemeFile,
  fetchThemeRepositoryListing,
  gitBlobSha,
  repositoryThemeMismatch,
  type ThemeRepositoryFetch,
  type ThemeRepositoryResponse,
} from "./theme-repository";
import type { ThemeIndexEntry } from "./theme-repository-format";

const REPO = "owner/themes";
const COMMIT = "c".repeat(40);
const NOW = 1_700_000_000_000;
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

interface Served {
  status?: number;
  headers?: Record<string, string>;
  /** Body chunks; one chunk when given as a string. */
  body?: string | Uint8Array[];
}

interface Call {
  url: string;
  init: Parameters<ThemeRepositoryFetch>[1];
}

/** A fake fetch serving `routes` by exact URL; it records every call and every reader cancel. */
function fakeFetch(routes: Record<string, Served | (() => never)>): {
  fetch: ThemeRepositoryFetch;
  calls: Call[];
  cancelled: string[];
} {
  const calls: Call[] = [];
  const cancelled: string[] = [];
  const fetch: ThemeRepositoryFetch = async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (route === undefined) return response(url, { status: 404 }, cancelled);
    if (typeof route === "function") return route();
    return response(url, route, cancelled);
  };
  return { fetch, calls, cancelled };
}

function response(url: string, served: Served, cancelled: string[]): ThemeRepositoryResponse {
  const status = served.status ?? 200;
  const chunks = typeof served.body === "string" ? [encode(served.body)] : (served.body ?? []);
  const headers = new Map(Object.entries(served.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  let at = 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    body: {
      getReader: () => ({
        read: async () => (at < chunks.length ? { done: false, value: chunks[at++] } : { done: true }),
        cancel: async () => {
          cancelled.push(url);
        },
      }),
    },
  };
}

const INDEX_ENTRY = { path: "themes/dusk.json", label: "Dusk", seeds: { canvas: "#1a1b26" }, backdrop: null };
const indexText = (themes: unknown[] = [INDEX_ENTRY]): string =>
  JSON.stringify({ format: "omp-ui-theme-index", version: 1, themes });
const themeText = JSON.stringify({ format: "omp-ui-theme", version: 1, label: "Dusk", seeds: { canvas: "#1a1b26" } });

const headUrl = `https://api.github.com/repos/${REPO}/commits/HEAD`;
const treeUrl = (commit = COMMIT): string => `https://api.github.com/repos/${REPO}/git/trees/${commit}?recursive=1`;
const rawUrl = (path: string, commit = COMMIT): string => `https://raw.githubusercontent.com/${REPO}/${commit}/${path}`;

/** A repository whose tree names `files` with their real blob SHAs and sizes. */
function repository(files: Record<string, string>, tree: Record<string, { sha?: string; size?: number }> = {}) {
  const rows = Object.entries(files).map(([path, text]) => ({
    path,
    type: "blob",
    sha: tree[path]?.sha ?? gitBlobSha(encode(text)),
    size: tree[path]?.size ?? encode(text).length,
  }));
  const routes: Record<string, Served> = {
    [headUrl]: { body: COMMIT },
    [treeUrl()]: { body: JSON.stringify({ sha: COMMIT, tree: rows, truncated: false }) },
  };
  for (const [path, text] of Object.entries(files)) routes[rawUrl(path)] = { body: text };
  return routes;
}

describe("gitBlobSha", () => {
  it("matches git's blob id", () => {
    // `printf 'hello\n' | git hash-object --stdin`
    expect(gitBlobSha(encode("hello\n"))).toBe("ce013625030ba8dba906f756967f9e9ca394464a");
  });
});

describe("fetchThemeRepositoryListing", () => {
  it("lists the index at HEAD through the fixed URLs, with no redirects and no credentials", async () => {
    const { fetch, calls } = fakeFetch(repository({ "omp-ui-themes.json": indexText(), "themes/dusk.json": themeText }));
    const result = await fetchThemeRepositoryListing(REPO, null, fetch, () => NOW);
    expect(result).toEqual({
      ok: true,
      listing: {
        repository: REPO,
        commit: COMMIT,
        themes: [{ ...INDEX_ENTRY, blob: gitBlobSha(encode(themeText)), size: encode(themeText).length }],
        skipped: 0,
      },
    });
    expect(calls.map((c) => c.url)).toEqual([headUrl, treeUrl(), rawUrl("omp-ui-themes.json")]);
    for (const call of calls) {
      expect(call.init.redirect).toBe("error");
      expect(Object.keys(call.init.headers).map((k) => k.toLowerCase())).not.toContain("authorization");
    }
  });

  it("skips the HEAD lookup for a pinned commit", async () => {
    const { fetch, calls } = fakeFetch(repository({ "omp-ui-themes.json": indexText(), "themes/dusk.json": themeText }));
    expect((await fetchThemeRepositoryListing(REPO, COMMIT, fetch, () => NOW)).ok).toBe(true);
    expect(calls.map((c) => c.url)).not.toContain(headUrl);
  });

  it("names the minutes until GitHub's anonymous limit resets", async () => {
    const reset = String(Math.floor(NOW / 1000) + 125);
    const { fetch } = fakeFetch({
      [headUrl]: { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": reset } },
    });
    expect(await fetchThemeRepositoryListing(REPO, null, fetch, () => NOW)).toEqual({
      ok: false,
      message: "GitHub's limit for anonymous requests from this network is used up; try again in 3 minutes",
    });
  });

  it("answers a missing or private repository with the public-repository rule", async () => {
    const { fetch } = fakeFetch({});
    expect(await fetchThemeRepositoryListing(REPO, null, fetch, () => NOW)).toEqual({
      ok: false,
      message: "repository not found; it must be a public GitHub repository",
    });
  });

  it("refuses a redirect and points at a rename", async () => {
    const { fetch } = fakeFetch({
      [headUrl]: () => {
        throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
      },
    });
    const result = await fetchThemeRepositoryListing(REPO, null, fetch, () => NOW);
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining("add it under its new name") });
  });

  it("refuses an index over 64 KiB by content-length and by streaming, cancelling the body", async () => {
    const big = " ".repeat(64 * 1024 + 1);
    for (const served of [
      { headers: { "content-length": String(big.length) }, body: big },
      { body: [encode(big.slice(0, 40_000)), encode(big.slice(40_000))] },
    ]) {
      const routes = repository({ "omp-ui-themes.json": big });
      routes[rawUrl("omp-ui-themes.json")] = served;
      const { fetch, cancelled } = fakeFetch(routes);
      expect(await fetchThemeRepositoryListing(REPO, null, fetch, () => NOW)).toEqual({
        ok: false,
        message: "omp-ui-themes.json is larger than 64 KiB",
      });
      expect(cancelled).toContain(rawUrl("omp-ui-themes.json"));
    }
  });

  it("refuses an index whose bytes do not match the tree's blob", async () => {
    const routes = repository({ "omp-ui-themes.json": indexText() });
    routes[rawUrl("omp-ui-themes.json")] = { body: indexText([]) };
    const { fetch } = fakeFetch(routes);
    expect(await fetchThemeRepositoryListing(REPO, null, fetch, () => NOW)).toEqual({
      ok: false,
      message: "a file GitHub served does not match the repository's commit",
    });
  });

  it("refuses a truncated tree", async () => {
    const routes = repository({ "omp-ui-themes.json": indexText() });
    routes[treeUrl()] = { body: JSON.stringify({ sha: COMMIT, tree: [], truncated: true }) };
    const { fetch } = fakeFetch(routes);
    expect(await fetchThemeRepositoryListing(REPO, null, fetch, () => NOW)).toEqual({
      ok: false,
      message: "the repository has too many files to list",
    });
  });

  it("reports a repository without a theme index", async () => {
    const { fetch } = fakeFetch(repository({ "README.md": "# hi" }));
    expect(await fetchThemeRepositoryListing(REPO, null, fetch, () => NOW)).toEqual({
      ok: false,
      message: "no omp-ui-themes.json at the repository root",
    });
  });

  it("counts entries missing from the tree or over 6 MiB as skipped", async () => {
    const themes = [INDEX_ENTRY, { ...INDEX_ENTRY, path: "gone.json" }, { ...INDEX_ENTRY, path: "huge.json" }];
    const { fetch } = fakeFetch(
      repository(
        { "omp-ui-themes.json": indexText(themes), "themes/dusk.json": themeText, "huge.json": "{}" },
        { "huge.json": { size: 6 * 1024 * 1024 + 1 } },
      ),
    );
    const result = await fetchThemeRepositoryListing(REPO, null, fetch, () => NOW);
    expect(result.ok && result.listing.themes.map((t) => t.path)).toEqual(["themes/dusk.json"]);
    expect(result.ok && result.listing.skipped).toBe(2);
  });
});

describe("fetchRepositoryThemeFile", () => {
  const listed = { ...INDEX_ENTRY, blob: gitBlobSha(encode(themeText)), size: encode(themeText).length };

  it("returns the file at the pinned commit when its blob matches", async () => {
    const { fetch } = fakeFetch({ [rawUrl("themes/dusk.json")]: { body: themeText } });
    expect(await fetchRepositoryThemeFile(REPO, COMMIT, listed, fetch, () => NOW)).toEqual({ ok: true, text: themeText });
  });

  it("refuses bytes that differ from the listed blob", async () => {
    const { fetch } = fakeFetch({ [rawUrl("themes/dusk.json")]: { body: `${themeText} ` } });
    expect(await fetchRepositoryThemeFile(REPO, COMMIT, listed, fetch, () => NOW)).toEqual({
      ok: false,
      message: "a file GitHub served does not match the repository's commit",
    });
  });
});

describe("repositoryThemeMismatch", () => {
  const indexEntry: ThemeIndexEntry = { path: "a.json", label: "Dusk", seeds: { canvas: "#1a1b26" }, backdrop: "scene" };
  const scene = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString("base64");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]).toString("base64");
  const draft = (patch: Partial<StoredThemeDraft> = {}): StoredThemeDraft => ({
    label: " Dusk ",
    seeds: { canvas: "#1A1B26" },
    backdrop: { from: "bytes", data: scene, dim: 40, blur: 12 },
    ...patch,
  });

  it("matches a file that agrees with its entry", () => {
    expect(repositoryThemeMismatch(indexEntry, draft())).toBe(false);
  });

  it.each([
    ["label", draft({ label: "Dawn" })],
    ["seeds", draft({ seeds: { canvas: "#1a1b27" } })],
    ["backdrop kind", draft({ backdrop: { from: "bytes", data: png, dim: 40, blur: 12 } })],
    ["missing backdrop", draft({ backdrop: null })],
  ])("trips on a different %s", (_name, file) => {
    expect(repositoryThemeMismatch(indexEntry, file)).toBe(true);
  });
});
