import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const RE = {
  keyword:
    /\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?|ref[s]?)\b\s*:?\s*((?:#[0-9]+|https?:\/\/\S+\/(?:issues|pull)\/[0-9]+)(?:[,\s]+(?:#[0-9]+|https?:\/\/\S+\/(?:issues|pull)\/[0-9]+))*)/gi,
  closer: /\b(?:fix(?:es|ed)?|close[sd]?|resolve[sd]?)\b/i,
  token: /#([0-9]+)|(?:issues|pull)\/([0-9]+)/g,
  bare: /(^|[\s(])#([0-9]+)/g,
  prMerge: /Merge pull request #([0-9]+)/i,
  conventional: /^([a-z]+)(?:\(([^)]*)\))?(!)?:\s*(.*)$/,
  refTail: /\s*\((?:(?:[A-Za-z]+\s+)?#\d+[,)?\s]*)+\)\s*$/,
  unreleased: /## Unreleased\n([\s\S]*?)(?=\n## |\s*$)/,
  bullet: /^\s*[-*]\s+(.*)$/,
  // Markdown link syntax with the target isolated: group 2 is the <…> form,
  // group 3 the bare form, which cannot contain a space or a ")".
  link: /(!?\[(?:[^[\]]|\[[^\]]*\])*\]\(\s*)(?:<([^>]*)>|([^)\s]*))/g,
  scheme: /^[a-z][a-z0-9+.-]*:/i,
};

const CONVENTIONAL = new Set([
  "feat",
  "fix",
  "perf",
  "docs",
  "chore",
  "test",
  "build",
  "ci",
  "refactor",
  "style",
  "revert",
]);
const SEMANTIC = {
  feat: "Features",
  fix: "Fixes",
  perf: "Performance",
  docs: "Docs",
  revert: "Fixes",
};
const HOUSEKEEPING = new Set(["chore", "test", "build", "ci", "refactor", "style"]);
const LABEL_GROUP = { enhancement: "Features", bug: "Fixes" };
export const GROUP_ORDER = ["Features", "Fixes", "Performance", "Docs", "Internal", "Other changes"];
export const BODY_LIMIT = 120_000;
export const RELEASES_DOC = "docs/releases.md";

function run(command, args) {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      maxBuffer: 1 << 26,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const detail = String(error.stderr ?? error.message).trim().split("\n")[0];
    const target = args.filter((arg) => !arg.startsWith("-")).slice(0, 2).join(" ");
    throw new Error(`${command} ${target} failed: ${detail}`, { cause: error });
  }
}

const git = (...args) => run("git", args);
const ghApi = (...args) => run("gh", ["api", ...args]);

// R1: the first release has no ancestor tag, and a tag missing from docs/releases.md
// simply has no curated prose. Both are empty results, not release failures.
function gitOrEmpty(...args) {
  try {
    return git(...args);
  } catch {
    return "";
  }
}

function ghSearch(query, perPage) {
  // `gh api -f` takes key=value in one argument, and any field switches gh to
  // POST — which the search API answers with a 404. Pin the method to GET.
  return JSON.parse(ghApi("search/issues", "-X", "GET", "-f", `q=${query}`, "-F", `per_page=${perPage}`));
}

export function parseRefs(text) {
  const refs = new Map();
  const merge = RE.prMerge.exec(text);
  if (merge) refs.set(Number(merge[1]), { kind: "pr", closer: true });
  for (const match of text.matchAll(RE.keyword)) {
    const closer = RE.closer.test(match[0]);
    for (const tok of match[1].matchAll(RE.token)) {
      const number = Number(tok[1] ?? tok[2]);
      if (number && !refs.has(number)) {
        refs.set(number, { kind: /pull\//.test(tok[0]) ? "pr" : "issue", closer });
      }
    }
  }
  if (!refs.size) {
    for (const tok of text.matchAll(RE.bare)) {
      const number = Number(tok[2]);
      if (!refs.has(number)) refs.set(number, { kind: "issue", closer: false });
    }
  }
  return refs;
}

function conventionalType(subject) {
  const match = RE.conventional.exec(subject ?? "");
  return match && CONVENTIONAL.has(match[1]) ? match[1] : null;
}

export function cleanSubject(subject) {
  let text = (subject ?? "")
    .replace(/^Merge pull request #[0-9]+ from \S+\s*:\s*/, "")
    .replace(/^Merge [^:]+:\s*/, "")
    .replace(/\s+\([0-9a-f]{7,40}\)\s*$/, "");
  text = text.replace(RE.refTail, "").trim();
  const match = RE.conventional.exec(text);
  if (match && CONVENTIONAL.has(match[1])) {
    const description = match[4].replace(RE.refTail, "").trim();
    return description.charAt(0).toLowerCase() + description.slice(1);
  }
  return text;
}

function cleanTitle(title) {
  return (title ?? "").replace(/^\[(Feature|Bug|Chore)\]:\s*/i, "").trim();
}

function bareNumbers(text) {
  return [...text.matchAll(RE.bare)].map((match) => Number(match[2]));
}

export function groupCommits(commits, { branchChildren }) {
  const entries = new Map();
  const untracked = [];
  const hit = (number, commit, meta) => {
    if (!entries.has(number)) entries.set(number, { number, hits: [] });
    entries.get(number).hits.push({ ...commit, ...meta });
  };
  for (const commit of commits) {
    const type = conventionalType(commit.subject);
    const refs = parseRefs(commit.subject);
    if (refs.size) {
      for (const [number, meta] of refs) {
        hit(number, commit, { type, ...meta, text: cleanSubject(commit.subject) });
      }
      continue;
    }
    if (commit.merge) {
      let covered = false;
      for (const child of branchChildren(commit)) {
        const childType = conventionalType(child.subject);
        for (const [number, meta] of parseRefs(child.subject)) {
          covered = true;
          hit(number, { ...commit, subject: child.subject }, { type: childType, ...meta, text: cleanSubject(child.subject) });
        }
      }
      if (covered) continue;
    }
    untracked.push({ ...commit, type });
  }
  const deduped = [];
  const seenText = new Set();
  for (const commit of untracked) {
    const key = cleanSubject(commit.subject);
    if (seenText.has(key)) continue;
    seenText.add(key);
    deduped.push({ ...commit, text: key });
  }
  return { entries, untracked: deduped };
}

export function attachPullRequests(entries, items) {
  for (const item of items) {
    const linked = [...parseRefs(`${item.title ?? ""} ${item.body ?? ""}`).keys()].filter((number) =>
      entries.has(number),
    );
    if (linked.length) {
      for (const number of linked) {
        const entry = entries.get(number);
        entry.prs = [...new Set([...(entry.prs ?? []), item.number])];
      }
      continue;
    }
    entries.set(item.number, {
      number: item.number,
      keyedBy: "pr",
      hits: [],
      pr: {
        title: cleanTitle(item.title),
        author: item.user?.login,
        url: item.html_url,
        labels: item.labels?.map((label) => label.name) ?? [],
      },
    });
  }
}

export function collectWorkItems({ commits, prItems, branchChildren, firstParent }) {
  const { entries, untracked } = groupCommits(commits, { branchChildren });
  attachPullRequests(entries, prItems);
  for (const entry of entries.values()) {
    const onMain = entry.hits
      .filter((candidate) => firstParent.has(candidate.sha))
      .sort((left, right) => right.index - left.index)[0];
    entry.landing = { sha: onMain?.sha ?? entry.hits.at(-1)?.sha ?? "" };
  }
  return { entries, untracked };
}

// A lifted bullet's relative link is correct in docs/releases.md and dead on a
// release page, which has no document tree to resolve it against. Rewrite each
// such target to the same file at the tag. Anything unresolvable is left
// verbatim: a highlight with one imperfect link still beats a lost highlight.
function absolutizeLinks(text, baseDir, blobUrl) {
  return text.replace(RE.link, (match, lead, bracketed, bare, offset, source) => {
    const raw = (bracketed ?? bare ?? "").trim();
    const odd = (source.slice(0, offset).match(/`/g) ?? []).length % 2;
    if (
      !raw ||
      /[()]/.test(raw) ||
      raw.startsWith("#") ||
      raw.startsWith("//") ||
      RE.scheme.test(raw) ||
      odd
    ) {
      return match;
    }
    const [, target = "", suffix = ""] = /^([^?#]*)([\s\S]*)$/.exec(raw);
    const resolved = path.posix.join(baseDir, target);
    if (resolved.startsWith("..")) return match; // escapes the repository root
    const href = resolved
      .split("/")
      .map((segment) => segment.replace(/[^\w.\-~]/g, (ch) => encodeURIComponent(ch)))
      .join("/");
    return `${lead}${blobUrl(href)}${suffix}`;
  });
}

export function liftHighlights(markdown, previousRefs, url) {
  const block = RE.unreleased.exec(markdown ?? "");
  const baseDir = path.posix.dirname(RELEASES_DOC);
  const out = [];
  for (const line of (block?.[1] ?? "").split("\n")) {
    const bullet = RE.bullet.exec(line);
    if (!bullet) continue;
    const refs = [...parseRefs(bullet[1]).keys()];
    if (refs.length && refs.every((number) => previousRefs.has(number))) continue;
    const linked = bullet[1].replace(
      RE.bare,
      (_match, before, number) => `${before}[#${number}](${url.issue(number)})`,
    );
    out.push(absolutizeLinks(linked, baseDir, url.blob));
  }
  return out;
}

export function finalizeNotes({ entries, untracked, issueMeta, releasesDoc, prevBody, url }) {
  const previousRefs = new Set(bareNumbers(prevBody ?? ""));
  const highlights = liftHighlights(releasesDoc, previousRefs, url);
  const planned = [];
  for (const entry of entries.values()) {
    const isPR = entry.keyedBy === "pr";
    const meta = isPR ? entry.pr : issueMeta.get(entry.number);
    if (!meta && !isPR) {
      for (const hit of entry.hits) untracked.push({ ...hit, text: cleanSubject(hit.subject) });
      continue;
    }
    const closers = entry.hits.filter((candidate) => candidate.closer);
    const pool = closers.length ? closers : entry.hits;
    const rank = (candidate) => ["feat", "fix", "perf", "docs"].indexOf(candidate.type ?? "zz");
    const primary = [...pool].sort((left, right) => rank(left) - rank(right) || right.index - left.index)[0];
    const type = primary?.type ?? conventionalType(isPR ? meta.title : "");
    const byLabel = (meta.labels ?? []).map((label) => LABEL_GROUP[label]).find(Boolean);
    planned.push({
      number: entry.number,
      keyedBy: isPR ? "pr" : "issue",
      group:
        (type ? (SEMANTIC[type] ?? (HOUSEKEEPING.has(type) ? "Internal" : null)) : null) ??
        byLabel ??
        "Other changes",
      text: primary?.text || cleanTitle(meta.title) || `untitled #${entry.number}`,
      // PR-keyed entries carry their own search item; issue entries use the API payload.
      url: isPR ? meta.url : meta.html_url,
      author: meta.author ?? primary?.author,
      prs: entry.prs ?? [],
      landing: entry.landing,
    });
  }
  planned.sort((left, right) => right.number - left.number);
  return { entries: planned, untracked, highlights };
}

function renderRow(row, model) {
  if (row.number === undefined) {
    return `- ${row.text} ([${row.sha.slice(0, 7)}](${model.url.commit(row.sha)}))`;
  }
  const refs = [`[#${row.number}](${row.url})`, ...row.prs.map((pr) => `[#${pr}](${model.url.pull(pr)})`)];
  const by = row.author ? ` by @${row.author}` : "";
  const landed = row.landing?.sha ? ` in [${row.landing.sha.slice(0, 7)}](${model.url.commit(row.landing.sha)})` : "";
  return `- ${row.text} (${refs.join(", ")})${by}${landed}`;
}

function groupRows(model, group) {
  const keyed = model.entries.filter((entry) => entry.group === group);
  if (group !== "Other changes") return keyed;
  return [...keyed, ...model.untracked];
}

function renderLines(model, collapseOtherChanges) {
  const lines = [];
  lines.push("## Highlights", "");
  const contributors = model.contributors.length;
  lines.push(
    `This release ships ${model.entries.length} changes in ${model.commits} commits from ${contributors} contributor${contributors === 1 ? "" : "s"}.`,
  );
  for (const highlight of model.highlights) lines.push("", "* " + highlight);
  lines.push("", "## What's Changed", "");
  for (const group of GROUP_ORDER) {
    const rows = groupRows(model, group);
    if (!rows.length) continue;
    lines.push(`### ${group}`, "");
    if (collapseOtherChanges && group === "Other changes") {
      lines.push(`- ${rows.length} further commits, see the full diff`, "");
      continue;
    }
    for (const row of rows) lines.push(renderRow(row, model));
    lines.push("");
  }
  if (model.newContributors.length) {
    lines.push("## New Contributors", "");
    for (const contributor of model.newContributors) {
      lines.push(`* @${contributor.login} made their first contribution in ${contributor.url}`);
    }
    lines.push("");
  }
  if (model.compareUrl) {
    lines.push(`**Full diff:** [\`${model.previousTag}...${model.tag}\`](${model.compareUrl})`);
  }
  return lines.join("\n");
}

function wrapChangeListInDetails(body) {
  const opened = body.replace(/^### /m, "<details>\n<summary>Full change list</summary>\n\n### ");
  if (opened === body) return body;
  const closed = opened.replace(/\n(?=## New Contributors|\*\*Full diff)/, "\n</details>\n\n");
  return closed === opened ? `${opened.trimEnd()}\n\n</details>\n` : closed;
}

export function renderReleaseNotes(model) {
  let body = renderLines(model, false);
  if (body.length > BODY_LIMIT) body = wrapChangeListInDetails(body);
  if (body.length > BODY_LIMIT) {
    body = wrapChangeListInDetails(renderLines(model, true));
  }
  return body.endsWith("\n") ? body : body + "\n";
}

function parseArguments(argv) {
  const options = {
    tag: undefined,
    out: undefined,
    stdout: false,
    repo: process.env.GITHUB_REPOSITORY ?? "LankfordAI/omp-ui",
    noHighlights: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--tag") options.tag = argv[++index];
    else if (arg === "--out") options.out = argv[++index];
    else if (arg === "--stdout") options.stdout = true;
    else if (arg === "--repo") options.repo = argv[++index];
    else if (arg === "--no-highlights") options.noHighlights = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.tag) throw new Error("--tag is required");
  return options;
}

export async function runCli(argv) {
  const { tag, repo, out, noHighlights } = parseArguments(argv);
  const url = {
    commit: (sha) => `https://github.com/${repo}/commit/${sha}`,
    pull: (number) => `https://github.com/${repo}/pull/${number}`,
    issue: (number) => `https://github.com/${repo}/issues/${number}`,
    compare: (left, right) => `https://github.com/${repo}/compare/${left}...${right}`,
    blob: (target) => `https://github.com/${repo}/blob/${tag}/${target}`,
  };

  const previousTag = gitOrEmpty("describe", "--tags", "--abbrev=0", `${tag}^`).trim();
  const range = previousTag ? `${previousTag}..${tag}` : tag;

  const records = git("log", "--format=%H%x1f%an%x1f%s%x1f%P%x1e", range).split("\x1e");
  const commits = records
    .filter((record) => record.trim())
    .map((record, index) => {
      const [sha, author, subject, parents] = record.split("\x1f").map((field) => field.trim());
      return { index, sha, author, subject, merge: parents.split(/\s+/).filter(Boolean).length > 1 };
    });
  const firstParent = new Set(git("rev-list", "--first-parent", range).split("\n"));
  const fromDate = previousTag ? git("log", "-1", "--format=%cI", previousTag).slice(0, 10) : "2000-01-01";
  const toDate = git("log", "-1", "--format=%cI", tag).slice(0, 10);

  const prItems = ghSearch(`repo:${repo} is:pr is:merged base:main merged:${fromDate}..${toDate}`, 100).items ?? [];

  const { entries, untracked } = collectWorkItems({
    commits,
    prItems,
    firstParent,
    branchChildren: (merge) =>
      git("log", "--format=%H%x1f%s%x1e", `${merge.sha}^1..${merge.sha}`)
        .split("\x1e")
        .filter((record) => record.trim())
        .map((record) => {
          const [sha, subject] = record.split("\x1f").map((field) => field.trim());
          return { sha, subject };
        }),
  });

  const issueMeta = new Map();
  for (const entry of entries.values()) {
    if (entry.keyedBy === "pr") continue;
    try {
      issueMeta.set(
        entry.number,
        JSON.parse(
          ghApi(`repos/${repo}/issues/${entry.number}`, "--jq", "{number,title,html_url,author:.user.login,labels:[.labels[].name]}"),
        ),
      );
    } catch {
      issueMeta.set(entry.number, null);
    }
  }

  const releasesDoc = gitOrEmpty("show", `${tag}:${RELEASES_DOC}`);
  let prevBody = "";
  if (previousTag) {
    try {
      prevBody = ghApi(`repos/${repo}/releases/tags/${previousTag}`, "--jq", ".body");
    } catch {
      prevBody = "";
    }
  }

  const finalized = finalizeNotes({ entries, untracked, issueMeta, releasesDoc, prevBody, url });

  const newContributors = [];
  const authors = [...new Set(prItems.map((item) => item.user?.login).filter(Boolean))].sort().slice(0, 20);
  for (const login of authors) {
    try {
      const prior = ghSearch(`repo:${repo} is:pr is:merged author:${login} merged:<${fromDate}`, 1).total_count;
      if (prior === 0) {
        newContributors.push({ login, url: prItems.find((item) => item.user?.login === login).html_url });
      }
    } catch {
      // Rate limited: omit the section rather than fail the release.
    }
  }

  const model = {
    tag,
    previousTag,
    version: tag.replace(/^v/, ""),
    commits: commits.length,
    contributors: [...new Set(commits.map((commit) => commit.author))].sort(),
    highlights: noHighlights ? [] : finalized.highlights,
    entries: finalized.entries,
    untracked: finalized.untracked,
    newContributors,
    compareUrl: previousTag ? url.compare(previousTag, tag) : "",
    url,
  };

  const body = renderReleaseNotes(model);
  if (out) await writeFile(path.resolve(out), body, "utf8");
  else process.stdout.write(body);
  return 0;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runCli(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    return 1;
  });
}
