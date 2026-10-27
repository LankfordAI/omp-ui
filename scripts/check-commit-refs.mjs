// commit-msg check: every "#N" a commit cites must say whether the commit
// closes it ("Fixes #N") or not ("Refs #N"), so a landed fix can never leave
// its issue silently open. Same grammar as release-notes / close-landed-issues.
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { unmarkedRefs } from "./release-notes.mjs";

const SCISSORS = /^# -+ >8 -+$/m;
const AUTOSQUASH = /^(?:fixup|squash|amend)! /;

/** Unmarked issue numbers in a commit-msg file's text; [] when the message is exempt. */
export function checkCommitMessage(text) {
  const cut = SCISSORS.exec(text);
  const message = cut ? text.slice(0, cut.index) : text;
  if (AUTOSQUASH.test(message.trimStart())) return [];
  return unmarkedRefs(message);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const unmarked = checkCommitMessage(readFileSync(process.argv[2], "utf8"));
  if (unmarked.length) {
    const list = unmarked.map((n) => `#${n}`).join(", ");
    console.error(
      [
        `commit-msg: ${list} cited without saying whether this commit closes it.`,
        `  Add "Fixes #N" when this commit completes the issue and the change is verified,`,
        `  or "Refs #N" when it does not. Wrap a "#N" that is not an issue in backticks.`,
      ].join("\n"),
    );
    process.exitCode = 1;
  }
}
