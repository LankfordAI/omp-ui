// Close issues whose closing keywords land on a branch GitHub would ignore.
// Native keyword auto-close (fixes #501) fires only for the repository's
// default branch, so work merged to `develop` — the nightly train — leaves
// its issues open. This script replays the closing semantics for any pushed
// range: it reads the same keyword grammar as release-notes.mjs (one
// definition of what a closer is), skips PRs and already-closed issues, and
// leaves a comment naming the landing commit and update train. Second duty:
// an issue the range cites ("#N") but never marks with Fixes or Refs gets a
// one-time comment naming the landing, so a fix that forgot its keyword is
// not silently left open.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { markedRefs, parseRefs, unmarkedRefs } from "./release-notes.mjs";

const TRAINS = { main: "stable", develop: "nightly" };

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

/**
 * Issue numbers the range's commits close, newest commit first per number
 * (git log order), so the recorded landing is the most recent commit that
 * claimed it. PR references are dropped: a merged PR needs no closer, and a
 * "Fixes #<pr>" is a mistake GitHub would silently obey on main only.
 */
export function collectClosers(commits) {
  const closers = new Map();
  for (const commit of commits) {
    for (const [number, ref] of parseRefs(commit.text)) {
      if (ref.kind !== "issue" || !ref.closer) continue;
      const found = closers.get(number);
      if (found) found.landings.push(commit);
      else closers.set(number, { number, landings: [commit] });
    }
  }
  return [...closers.values()];
}

export function trainFor(branch) {
  return TRAINS[branch] ?? branch;
}

export function closeComment({ branch, landing }) {
  const train = trainFor(branch);
  const suffix =
    branch === "develop"
      ? " It is in the next nightly build and reaches stable at the next release."
      : "";
  return [
    `Closed automatically — landed on \`${branch}\` as \`${landing.sha.slice(0, 8)}\`: ${landing.subject}`,
    "",
    `This change rides the **${train}** update train.${suffix}`,
  ].join("\n");
}

/**
 * Issues the range cites but never marks: no commit in the range says Fixes or
 * Refs for them. Newest citing commit wins (git log order). A merge-back
 * commit's Refs lines mark its folded commits' bare citations.
 */
export function collectUnmarked(commits) {
  const marked = new Set();
  for (const commit of commits) for (const number of markedRefs(commit.text)) marked.add(number);
  const found = new Map();
  for (const commit of commits) {
    for (const number of unmarkedRefs(commit.text)) {
      if (!marked.has(number) && !found.has(number)) found.set(number, { number, landing: commit });
    }
  }
  return [...found.values()];
}

export const unmarkedMarker = (sha) => `<!-- close-landed-issues:unmarked ${sha} -->`;

export function unmarkedComment({ branch, landing }) {
  return [
    `Landed on \`${branch}\` as \`${landing.sha.slice(0, 8)}\`: ${landing.subject}`,
    "",
    "That commit cites this issue without `Fixes` or `Refs`, so it was left open. Close it if this landing completes the work.",
    "",
    unmarkedMarker(landing.sha),
  ].join("\n");
}

export function commitsInRange(range) {
  // %B carries subject plus body: keywords live in either place, exactly as
  // GitHub's own parser reads them.
  return git("log", "--format=%H%x1f%B%x1e", range)
    .split("\x1e")
    .filter((record) => record.trim())
    .map((record) => {
      const [sha, text] = record.split("\x1f");
      return { sha: sha.trim(), subject: text.split("\n")[0].trim(), text };
    });
}

function parseArguments(argv) {
  const options = {
    range: undefined,
    branch: process.env.GITHUB_REF_NAME ?? "HEAD",
    repo: process.env.GITHUB_REPOSITORY ?? "LankfordAI/omp-ui",
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--range") options.range = argv[++index];
    else if (arg === "--branch") options.branch = argv[++index];
    else if (arg === "--repo") options.repo = argv[++index];
    else if (arg === "--dry-run") options.dryRun = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!options.range) throw new Error("--range is required");
  return options;
}

// One read carries everything the decision needs; `has(pull_request)` covers
// shared numbering, where a bare "#N" can name a PR whose state is merge, not
// issue close. Returns undefined (after a warning) when the read fails.
function readMeta(repo, number) {
  try {
    return JSON.parse(
      ghApi(`repos/${repo}/issues/${number}`, "--jq", `{number,state,title,isPr:has("pull_request")}`),
    );
  } catch (error) {
    console.log(`::warning::#${number} unreadable: ${error.message}`);
    return undefined;
  }
}

export function runCli(argv) {
  const { range, branch, repo, dryRun } = parseArguments(argv);
  const commits = commitsInRange(range);
  const closers = collectClosers(commits);
  const unmarked = collectUnmarked(commits);
  if (!closers.length && !unmarked.length) {
    console.log(`no closing keywords in ${range} — nothing to do`);
    return 0;
  }
  let failures = 0;
  for (const { number, landings } of closers) {
    const landing = landings[0];
    const meta = readMeta(repo, number);
    if (!meta) {
      failures += 1;
      continue;
    }
    if (meta.isPr) {
      console.log(`#${number} is a pull request — no issue to close`);
      continue;
    }
    if (meta.state === "closed") {
      console.log(`#${number} already closed — skipped`);
      continue;
    }
    const comment = closeComment({ branch, landing });
    if (dryRun) {
      console.log(
        `DRY-RUN would close #${number} (${meta.title}) landing ${landing.sha.slice(0, 8)} on ${branch}`,
      );
      continue;
    }
    try {
      ghApi(`repos/${repo}/issues/${number}/comments`, "-f", `body=${comment}`);
      ghApi("-X", "PATCH", `repos/${repo}/issues/${number}`, "-f", "state=closed");
      console.log(`closed #${number} (${meta.title}) via ${landing.sha.slice(0, 8)} on ${branch}`);
    } catch (error) {
      console.log(`::warning::#${number} close failed: ${error.message}`);
      failures += 1;
    }
  }
  for (const { number, landing } of unmarked) {
    const meta = readMeta(repo, number);
    if (!meta) {
      failures += 1;
      continue;
    }
    if (meta.isPr) {
      console.log(`#${number} is a pull request — no issue to note`);
      continue;
    }
    if (meta.state === "closed") {
      console.log(`#${number} already closed — skipped`);
      continue;
    }
    const sha8 = landing.sha.slice(0, 8);
    try {
      const bodies = ghApi(`repos/${repo}/issues/${number}/comments`, "--paginate", "--jq", ".[].body");
      if (bodies.includes(unmarkedMarker(landing.sha))) {
        console.log(`#${number} already noted for ${sha8} — skipped`);
        continue;
      }
      if (dryRun) {
        console.log(`DRY-RUN would note #${number} (${meta.title}) landing ${sha8} on ${branch}`);
        continue;
      }
      ghApi(`repos/${repo}/issues/${number}/comments`, "-f", `body=${unmarkedComment({ branch, landing })}`);
      console.log(`noted #${number} (${meta.title}) landing ${sha8} on ${branch}`);
    } catch (error) {
      console.log(`::warning::#${number} note failed: ${error.message}`);
      failures += 1;
    }
  }
  return failures === 0 ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = runCli(process.argv.slice(2));
}
