// Points this clone's git at the versioned hooks in .githooks (commit-msg:
// issue refs must be marked). Runs from `npm install`; never fails it.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const TARGET = ".githooks";

try {
  if (git("rev-parse", "--is-inside-work-tree") !== "true") process.exit(0);
  let current = "";
  try { current = git("config", "--local", "--get", "core.hooksPath"); } catch { /* unset */ }
  if (current === TARGET) process.exit(0);
  if (current) {
    console.warn(`install-git-hooks: core.hooksPath is ${current}; leaving it. Set it to ${TARGET} to enable the commit-msg check.`);
    process.exit(0);
  }
  // Setting hooksPath disables .git/hooks; never do that over hooks someone installed.
  const own = readdirSync(git("rev-parse", "--git-path", "hooks")).filter((f) => !f.endsWith(".sample"));
  if (own.length) {
    console.warn(`install-git-hooks: .git/hooks has ${own.join(", ")}; not switching core.hooksPath to ${TARGET}.`);
    process.exit(0);
  }
  git("config", "--local", "core.hooksPath", TARGET);
} catch {
  // Not a git checkout (tarball install) or git missing: nothing to install.
}
