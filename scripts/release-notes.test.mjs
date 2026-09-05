import assert from "node:assert/strict";
import test from "node:test";

import {
  BODY_LIMIT,
  GROUP_ORDER,
  attachPullRequests,
  cleanSubject,
  collectWorkItems,
  finalizeNotes,
  groupCommits,
  liftHighlights,
  parseRefs,
  renderReleaseNotes,
} from "./release-notes.mjs";

const repo = "octo/widgets";

const url = {
  commit: (sha) => `https://github.com/${repo}/commit/${sha}`,
  pull: (number) => `https://github.com/${repo}/pull/${number}`,
  issue: (number) => `https://github.com/${repo}/issues/${number}`,
  compare: (left, right) => `https://github.com/${repo}/compare/${left}...${right}`,
};

function commit(index, sha, subject, extra = {}) {
  return { index, sha, author: `author-${index}`, subject, merge: false, ...extra };
}

function hit(index, sha, subject, meta) {
  return { ...commit(index, sha, subject), ...meta, text: cleanSubject(subject) };
}

function entry(number, hits) {
  return { number, hits, landing: { sha: hits.at(-1)?.sha ?? "" } };
}

function issue(number, overrides = {}) {
  return { number, title: `Issue ${number}`, html_url: url.issue(number), labels: [], ...overrides };
}

function model(overrides) {
  return {
    tag: "v1.2.3",
    previousTag: "v1.2.2",
    version: "1.2.3",
    commits: 1,
    contributors: ["author-0"],
    highlights: [],
    entries: [],
    untracked: [],
    newContributors: [],
    compareUrl: url.compare("v1.2.2", "v1.2.3"),
    url,
    ...overrides,
  };
}

function keyedRow(number, group, seed, text = `change ${number}`) {
  return {
    number,
    keyedBy: "issue",
    group,
    text,
    url: url.issue(number),
    author: "octo",
    prs: [],
    landing: { sha: `landing${seed}` },
  };
}

function untrackedRow(sha, text) {
  return { index: 0, sha, author: "author-0", subject: text, merge: false, text };
}

function render({ entries = [], untracked = [], ...overrides } = {}) {
  return renderReleaseNotes(model({ entries, untracked, ...overrides }));
}

test("keyword refs win over bare numbers in prose", () => {
  const refs = parseRefs("fix: bar (see #99) (Fixes #12, #13)");

  assert.deepEqual(
    [...refs.entries()].sort((left, right) => left[0] - right[0]),
    [
      [12, { kind: "issue", closer: true }],
      [13, { kind: "issue", closer: true }],
    ],
  );
  assert.equal(refs.has(99), false);
});

test("parseRefs reads multi-ref lists, URL forms, and merge subjects", () => {
  assert.deepEqual(parseRefs("Refs #7").get(7), { kind: "issue", closer: false });
  assert.deepEqual(parseRefs("fixes https://github.com/octo/widgets/pull/44").get(44), {
    kind: "pr",
    closer: true,
  });
  assert.deepEqual(parseRefs("Merge pull request #376 from octo/topic").get(376), {
    kind: "pr",
    closer: true,
  });
});

test("a branch merge files each child ref with the merge as landing", () => {
  const merge = commit(0, "m0", "Merge b into main (2 commits)", { merge: true });
  const children = [
    { sha: "c1", subject: "fix: guard the composer (Fixes #372)" },
    { sha: "c2", subject: "fix: repaint the inspector rail (Fixes #373)" },
  ];
  const { entries, untracked } = collectWorkItems({
    commits: [merge],
    prItems: [],
    firstParent: new Set(["m0"]),
    branchChildren: () => children,
  });

  assert.deepEqual([...entries.keys()].sort((left, right) => left - right), [372, 373]);
  assert.deepEqual(untracked, []);
  assert.equal(entries.get(372).landing.sha, "m0");
  assert.equal(entries.get(373).landing.sha, "m0");

  const finalized = finalizeNotes({
    entries,
    untracked,
    issueMeta: new Map([
      [373, issue(373, { title: "Inspector repaint", labels: ["bug"] })],
      [372, issue(372, { title: "Composer guard", labels: ["enhancement"] })],
    ]),
    releasesDoc: "",
    prevBody: "",
    url,
  });

  assert.deepEqual(
    finalized.entries.map((row) => [row.number, row.group, row.text]),
    [
      [373, "Fixes", "repaint the inspector rail"],
      [372, "Fixes", "guard the composer"],
    ],
  );
});

test("the closing commit supplies the bullet text", () => {
  const commits = [commit(0, "s1", "feat: add X (Closes #5)"), commit(1, "s0", "fix: polish X (Refs #5)")];
  const { entries, untracked } = groupCommits(commits, { branchChildren: () => [] });

  const finalized = finalizeNotes({
    entries,
    untracked,
    issueMeta: new Map([[5, issue(5, { title: "X" })]]),
    releasesDoc: "",
    prevBody: "",
    url,
  });

  assert.equal(finalized.entries.length, 1);
  assert.equal(finalized.entries[0].text, "add X");
  assert.equal(finalized.entries[0].group, "Features");
});

test("case survives when no conventional prefix matched", () => {
  assert.equal(
    cleanSubject("Fix leading blank table header alignment (fixes #365)"),
    "Fix leading blank table header alignment",
  );

  const { entries, untracked } = groupCommits(
    [commit(0, "s0", "Fix leading blank table header alignment (fixes #365)")],
    { branchChildren: () => [] },
  );
  const finalized = finalizeNotes({
    entries,
    untracked,
    issueMeta: new Map([[365, issue(365, { title: "Table header", labels: ["bug"] })]]),
    releasesDoc: "",
    prevBody: "",
    url,
  });

  assert.equal(finalized.entries[0].text, "Fix leading blank table header alignment");
  assert.equal(finalized.entries[0].group, "Fixes");
});

test("grouping prefers the commit type, then housekeeping, then labels", () => {
  const cases = [
    { type: "chore", labels: ["bug"], group: "Internal" },
    { type: "feat", labels: ["bug"], group: "Features" },
    { type: null, labels: ["enhancement"], group: "Features" },
    { type: null, labels: [], group: "Other changes" },
  ];

  const entries = new Map();
  const issueMeta = new Map();
  cases.forEach((testCase, index) => {
    const number = 100 + index;
    const subject = testCase.type ? `${testCase.type}: work ${index} (#${number})` : `untitled work ${index} (#${number})`;
    entries.set(number, entry(number, [hit(index, `s${index}`, subject, { closer: true, type: testCase.type })]));
    issueMeta.set(number, issue(number, { labels: testCase.labels }));
  });

  const finalized = finalizeNotes({ entries, untracked: [], issueMeta, releasesDoc: "", prevBody: "", url });

  const expected = cases
    .map((testCase, index) => [100 + index, testCase.group])
    .sort((left, right) => right[0] - left[0]);
  assert.deepEqual(finalized.entries.map((row) => [row.number, row.group]), expected);
});

test("a merged PR attaches to the issues it references", () => {
  const commits = [
    commit(0, "s1", "feat: show the spawn gate's resolved models (Fixes #372)"),
    commit(1, "s0", "fix: replace window.alert with dialogs (Fixes #373)"),
  ];
  const { entries, untracked } = groupCommits(commits, { branchChildren: () => [] });

  attachPullRequests(entries, [
    {
      number: 376,
      title: "DOM feedback dialogs + spawn-gate advisor display (#372, #373)",
      body: "",
      html_url: url.pull(376),
      user: { login: "octo" },
      labels: [],
    },
  ]);

  assert.deepEqual([...entries.keys()].sort((left, right) => left - right), [372, 373]);
  assert.deepEqual(entries.get(372).prs, [376]);
  assert.deepEqual(entries.get(373).prs, [376]);
  assert.equal(untracked.length, 0);
});

test("a PR without refs becomes its own entry", () => {
  const { entries, untracked } = groupCommits([], { branchChildren: () => [] });

  attachPullRequests(entries, [
    {
      number: 400,
      title: "stream the native transcript live",
      body: "nothing referencing an issue",
      html_url: url.pull(400),
      user: { login: "newbie" },
      labels: [],
    },
    {
      number: 401,
      title: "feat: grow the Capabilities viewer",
      body: "nothing referencing an issue",
      html_url: url.pull(401),
      user: { login: "newbie" },
      labels: [],
    },
  ]);

  assert.equal(entries.get(400).keyedBy, "pr");
  const finalized = finalizeNotes({ entries, untracked, issueMeta: new Map(), releasesDoc: "", prevBody: "", url });

  assert.deepEqual(
    finalized.entries.map((row) => [row.number, row.group]),
    [
      [401, "Features"],
      [400, "Other changes"],
    ],
  );
  assert.deepEqual(
    finalized.entries.map((row) => row.url),
    [url.pull(401), url.pull(400)],
  );

  const body = render({ entries: finalized.entries });
  assert.match(
    body,
    /^- stream the native transcript live \(\[#400\]\(https:\/\/github\.com\/octo\/widgets\/pull\/400\)\) by @newbie$/m,
  );
});

test("highlights lift verbatim, linkify refs, and drop stale bullets", () => {
  const releasesDoc = [
    "# Release notes",
    "",
    "## Unreleased",
    "",
    "- Settings → Providers gains a **Subscriptions** group (issue #368).",
    "- Already announced work (#360).",
    "- Prose with no issue reference at all.",
    "",
    "## v0.9.10",
    "",
    "- old bullet",
  ].join("\n");

  const highlights = liftHighlights(releasesDoc, new Set([360]), url.issue);

  assert.deepEqual(highlights, [
    "Settings → Providers gains a **Subscriptions** group (issue [#368](https://github.com/octo/widgets/issues/368)).",
    "Prose with no issue reference at all.",
  ]);
});

test("render follows GROUP_ORDER, skips empty groups, and orders entries descending", () => {
  const entries = [
    keyedRow(9, "Features", 0),
    keyedRow(8, "Fixes", 1),
    keyedRow(7, "Features", 2),
    keyedRow(6, "Other changes", 3),
    keyedRow(5, "Internal", 4),
  ];
  const untracked = [untrackedRow("a1b2c3d4e5f6a7", "disarm watchdog on agent end")];
  const body = render({
    entries,
    untracked,
    commits: 6,
    contributors: ["author-0", "author-1"],
    highlights: ["Curated prose (issue #9)."],
    newContributors: [{ login: "newbie", url: url.pull(1) }],
  });

  assert.deepEqual(
    [...body.matchAll(/^### (.+)$/gm)].map((match) => match[1]),
    GROUP_ORDER.filter((group) => group !== "Performance" && group !== "Docs"),
  );
  assert.deepEqual(
    [...body.matchAll(/^- .*\[#(\d+)\]/gm)].map((match) => Number(match[1])),
    [9, 7, 8, 5, 6],
  );
  assert.match(
    body,
    /^- disarm watchdog on agent end \(\[a1b2c3d\]\(https:\/\/github\.com\/octo\/widgets\/commit\/a1b2c3d4e5f6a7\)\)$/m,
  );
  assert.match(body, /^## Highlights$/m);
  assert.match(body, /^\* Curated prose \(issue #9\)\.$/m);
  assert.match(body, /This release ships 5 changes in 6 commits from 2 contributors\./);
  assert.match(body, /^## New Contributors$/m);
  assert.match(
    body,
    /^\*\*Full diff:\*\* \[`v1\.2\.2\.\.\.v1\.2\.3`\]\(https:\/\/github\.com\/octo\/widgets\/compare\/v1\.2\.2\.\.\.v1\.2\.3\)$/m,
  );
  assert.ok(body.endsWith("\n"));

  const firstRelease = render({ entries, previousTag: "", compareUrl: "" });
  assert.equal(firstRelease.includes("**Full diff:**"), false);
});

test("an oversized body wraps the change list then collapses Other changes", () => {
  const padding = "x".repeat(200);
  const features = Array.from({ length: 1000 }, (_unused, index) =>
    keyedRow(1000 + index, "Features", index, `feature ${index} ${padding}`),
  );
  const other = Array.from({ length: 1500 }, (_unused, index) =>
    untrackedRow(`f${index}sha`, `untracked ${index} ${padding}`),
  );

  const keyedOnly = render({ entries: features });
  assert.ok(keyedOnly.length > BODY_LIMIT, "fixture must overflow the body limit");
  assert.match(keyedOnly, /^<details>\n<summary>Full change list<\/summary>\n\n### Features$/m);
  assert.ok(keyedOnly.indexOf("</details>") > keyedOnly.lastIndexOf("### "));

  const collapsed = render({ untracked: other });
  assert.match(collapsed, /^<details>\n<summary>Full change list<\/summary>\n\n### Other changes$/m);
  assert.match(collapsed, /^- 1500 further commits, see the full diff$/m);
  assert.equal(collapsed.includes("untracked 1499 "), false);
  assert.ok(collapsed.length < BODY_LIMIT, "collapsing Other changes must fit the body under the limit");

  const mixed = render({ entries: features, untracked: other.slice(0, 4) });
  assert.equal(mixed.indexOf("<details>") < mixed.indexOf("### Features"), true);
  assert.ok(mixed.indexOf("</details>") > mixed.lastIndexOf("### "));
  assert.ok(mixed.indexOf("</details>") < mixed.indexOf("**Full diff:**"));
  assert.match(mixed, /^- 4 further commits, see the full diff$/m);
  assert.equal(mixed.includes("untracked 3 "), false);
});

test("a vanished issue still shows its commit once under Other changes", () => {
  const subject = "fix: stop the session HUD from thrashing (Fixes #313)";
  const { entries, untracked } = groupCommits([commit(0, "deadbeefcafe", subject)], { branchChildren: () => [] });

  const finalized = finalizeNotes({
    entries,
    untracked,
    issueMeta: new Map([[313, null]]),
    releasesDoc: "",
    prevBody: "",
    url,
  });

  assert.deepEqual(finalized.entries, []);
  const body = render({ entries: finalized.entries, untracked: finalized.untracked });

  assert.match(body, /^### Other changes$/m);
  assert.match(
    body,
    /^- stop the session HUD from thrashing \(\[deadbee\]\(https:\/\/github\.com\/octo\/widgets\/commit\/deadbeefcafe\)\)$/m,
  );
  assert.equal(body.split("stop the session HUD").length - 1, 1);
});
