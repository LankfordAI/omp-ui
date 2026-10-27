import assert from "node:assert/strict";
import test from "node:test";

import { checkCommitMessage } from "./check-commit-refs.mjs";

test("a bare citation is unmarked", () => {
  assert.deepEqual(checkCommitMessage("test(core): retry teardown (#948)\n"), [948]);
});

test("an autosquash message is exempt", () => {
  assert.deepEqual(checkCommitMessage("fixup! fix: x (#948)\n"), []);
});

test("the diff below a commit -v scissors line is ignored", () => {
  const text = "fix: x\n\nFixes #5\n# ------------------------ >8 ------------------------\n+see #77\n";
  assert.deepEqual(checkCommitMessage(text), []);
});
