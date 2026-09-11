import assert from "node:assert/strict";
import test from "node:test";

import { closeComment, collectClosers, trainFor } from "./close-landed-issues.mjs";

function commit(sha, subject, body = "") {
  return { sha, subject, text: body ? `${subject}\n\n${body}` : subject };
}

test("collectClosers keeps only issue references with a closing keyword", () => {
  const commits = [
    commit("aaaa1111deadbeef", "fix(renderer): stop the crash (fixes #481)"),
    commit("bbbb2222deadbeef", "docs: mention #500 in the changelog"),
    commit("cccc3333deadbeef", "feat: add the thing", "Closes #12."),
    commit("dddd4444deadbeef", "chore: bump", "Addresses #99, ref #100"),
    commit("eeee5555deadbeef", "Merge pull request #7 from someone/branch", "Related: #8"),
  ];
  const numbers = collectClosers(commits).map((entry) => entry.number);
  assert.deepEqual(numbers, [481, 12]);
});

test("a ref appears once and records every commit that claimed it", () => {
  const commits = [
    commit("aaaa1111", "fix: part one (fixes #42)"),
    commit("bbbb2222", "fix: part two (fixes #42)"),
  ];
  const [entry] = collectClosers(commits);
  assert.equal(entry.number, 42);
  assert.deepEqual(
    entry.landings.map((l) => l.sha),
    ["aaaa1111", "bbbb2222"],
  );
});

test("refs to pull requests are not treated as closable issues", () => {
  // A merge subject "Merge pull request #7 ..." is a PR reference; and an
  // explicit "Fixes https://.../pull/8" is a PR, not an issue.
  const commits = [
    commit("aaaa1111", "Merge pull request #7 from x/y"),
    commit("bbbb2222", "fix: see it", "Fixes https://github.com/o/r/pull/8"),
  ];
  assert.deepEqual(collectClosers(commits), []);
});

test("closing keywords in a commit body count, not only the subject", () => {
  const [entry] = collectClosers([commit("aaaa1111", "fix(renderer): cap commits", "Long prose.\n\nFixes #481")]);
  assert.equal(entry.number, 481);
});

test("train names the update train a branch feeds", () => {
  assert.equal(trainFor("main"), "stable");
  assert.equal(trainFor("develop"), "nightly");
  assert.equal(trainFor("feature/x"), "feature/x");
});

test("the close comment names branch, commit, and train", () => {
  const text = closeComment({
    branch: "develop",
    landing: { sha: "cac4e75f9a1b2c3d", subject: "fix(renderer): cap commits (fixes #481)" },
  });
  assert.match(text, /landed on `develop` as `cac4e75f`/);
  assert.match(text, /nightly/);
  assert.match(text, /reaches stable at the next release/);
});

test("a main landing is described as stable without the nightly promise", () => {
  const text = closeComment({ branch: "main", landing: { sha: "deadbeefcafe", subject: "fix: x" } });
  assert.match(text, /stable/);
  assert.doesNotMatch(text, /nightly/);
});
