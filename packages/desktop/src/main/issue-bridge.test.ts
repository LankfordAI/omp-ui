// The answerer's consent machinery (ADR-0095): a filing must reproduce the
// last draft byte-for-byte, secrets refuse before ANY gh call, failures map to
// honest lines, and the per-tab cap resets only with the tab's process.
import { describe, expect, it } from "vitest";
import { IssueBridge, ISSUE_FILE_CAP_PER_TAB, issueDraftFingerprint } from "./issue-bridge";
import {
  BUG_TAB_MODES,
  parseIssueToolArgs,
  type GhResult,
  type GhRunner,
} from "@omp-ui/core";

const FACTS = { appVersion: "0.9.9", ompVersion: "18.4.3" };

interface Call {
  cwd: string;
  args: string[];
}

function harness(gh: GhRunner) {
  const calls: Call[] = [];
  const runner: GhRunner = async (cwd, args) => {
    calls.push({ cwd, args });
    return gh(cwd, args);
  };
  const bridge = new IssueBridge({ cwd: () => "/tmp/session", versions: async () => FACTS, log: () => {}, runGh: runner });
  return { bridge, calls };
}

const ok = (stdout = ""): GhResult => ({ code: 0, stdout, stderr: "" });

function bugArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "bug",
    title: "Sidebar drops a session on rename",
    description: "Renaming removes the row.",
    steps: "1. rename",
    expected: "row stays",
    actual: "row vanishes",
    tabMode: BUG_TAB_MODES[1],
    ...overrides,
  };
}

describe("issueDraftFingerprint", () => {
  it("fingerprints the exact (title, repository, body) triple", () => {
    const a = issueDraftFingerprint("[Bug]: t", "r/x", "body");
    expect(a).toBe(issueDraftFingerprint("[Bug]: t", "r/x", "body"));
    expect(issueDraftFingerprint("[Bug]: t", "r/x", "body ")).not.toBe(a);
    expect(issueDraftFingerprint("[Bug]: T", "r/x", "body")).not.toBe(a);
    expect(issueDraftFingerprint("[Bug]: t", "r/y", "body")).not.toBe(a);
  });
});

function featureArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "feature",
    title: "Group sessions by worktree",
    description: "Cannot see shared worktrees.",
    proposal: "Nest them in the sidebar.",
    area: "Sidebar / projects / sessions",
    ...overrides,
  };
}

describe("IssueBridge.draft", () => {
  it("renders the body, searches duplicates, and files nothing", async () => {
    const { bridge, calls } = harness(async () => ok(JSON.stringify([{ number: 42, title: "dup", state: "OPEN", url: "https://gh/42" }])));
    const outcome = await bridge.draft("tab-a", bugArgs());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("nothing was filed");
    expect(outcome.text).toContain("#42 [OPEN] dup — https://gh/42");
    expect(outcome.text).toContain("## omp-ui version / commit");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args.slice(0, 2)).toEqual(["issue", "list"]);
  });

  it("omits the duplicates section with one honest line when the search fails, and still renders the body", async () => {
    const { bridge } = harness(async () => ({ code: 4, stdout: "", stderr: "gh auth login" }));
    const outcome = await bridge.draft("tab-a", bugArgs());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("duplicate search unavailable (gh is not authenticated");
    expect(outcome.text).toContain("## Description");
  });

  it("refuses a secret-shaped title or body before ANY gh call", async () => {
    const { bridge, calls } = harness(async () => ok("[]"));
    const token = `ghp_${"a".repeat(36)}`;
    const badTitle = await bridge.draft("tab-a", bugArgs({ title: `Crash with ${token} leaked` }));
    expect(badTitle.ok).toBe(false);
    const badBody = await bridge.draft("tab-a", bugArgs({ logs: `env token=${token}` }));
    expect(badBody.ok).toBe(false);
    if (!badBody.ok) expect(badBody.reason).toContain("secret-shaped");
    expect(calls).toHaveLength(0);
  });

  it("refuses an invalid parse without touching gh", async () => {
    const { bridge, calls } = harness(async () => ok("[]"));
    const outcome = await bridge.draft("tab-a", { kind: "bug", title: "x" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.reason).toContain("description is required");
    expect(calls).toHaveLength(0);
  });
});

describe("IssueBridge.file", () => {
  it("files after a matching draft and answers with the created URL", async () => {
    const { bridge, calls } = harness(async (_cwd, args) =>
      args[0] === "issue" && args[1] === "list" ? ok("[]") : ok("https://github.com/LankfordAI/omp-ui/issues/77\n"));
    const args = bugArgs();
    expect((await bridge.draft("tab-a", args)).ok).toBe(true);
    const outcome = await bridge.file("tab-a", args);
    expect(outcome).toEqual({ ok: true, text: "Filed https://github.com/LankfordAI/omp-ui/issues/77." });
    const create = calls.find((call) => call.args[1] === "create")!;
    expect(create.args.slice(0, 2)).toEqual(["issue", "create"]);
    expect(create.args).toContain("--repo");
    expect(create.args).toContain("LankfordAI/omp-ui");
    expect(create.args).toContain("--label");
    expect(create.args[create.args.indexOf("--label") + 1]).toBe("bug");
    const bodyFile = create.args[create.args.indexOf("--body-file") + 1];
    expect(bodyFile).toContain("body.md");
  });

  it("labels a feature request enhancement", async () => {
    const { bridge, calls } = harness(async (_cwd, args) => (args[1] === "list" ? ok("[]") : ok("https://x/1")));
    const args = featureArgs();
    await bridge.draft("tab-a", args);
    expect((await bridge.file("tab-a", args)).ok).toBe(true);
    const create = calls.find((call) => call.args[1] === "create")!;
    expect(create.args[create.args.indexOf("--label") + 1]).toBe("enhancement");
  });

  it("refuses a mismatch without any create call, and a re-draft of the changed arguments files", async () => {
    const { bridge, calls } = harness(async (_cwd, args) => (args[1] === "list" ? ok("[]") : ok("https://x/2")));
    await bridge.draft("tab-a", bugArgs());
    const drifted = bugArgs({ actual: "row vanishes sometimes" });
    const refused = await bridge.file("tab-a", drifted);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.reason).toContain("omp-ui_issue_draft");
    expect(calls.some((call) => call.args[1] === "create")).toBe(false);
    expect((await bridge.file("tab-a", drifted)).ok).toBe(false);
    expect(calls.some((call) => call.args[1] === "create")).toBe(false);
    await bridge.draft("tab-a", drifted);
    expect((await bridge.file("tab-a", drifted)).ok).toBe(true);
  });

  it("refuses a file with no draft at all", async () => {
    const { bridge, calls } = harness(async () => ok("[]"));
    expect((await bridge.file("tab-a", bugArgs())).ok).toBe(false);
    expect(calls.some((call) => call.args[1] === "create")).toBe(false);
  });

  it("secrets in the file arguments refuse before gh", async () => {
    const { bridge, calls } = harness(async () => ok("[]"));
    const args = bugArgs();
    await bridge.draft("tab-a", args);
    const token = `ghp_${"b".repeat(36)}`;
    expect((await bridge.file("tab-a", bugArgs({ logs: token }))).ok).toBe(false);
    expect(calls.every((call) => call.args[1] !== "create")).toBe(true);
  });

  it("caps filings per tab and resets through forget", async () => {
    const { bridge, calls } = harness(async (_cwd, args) => (args[1] === "list" ? ok("[]") : ok("https://x/ok")));
    for (let index = 0; index < ISSUE_FILE_CAP_PER_TAB; index += 1) {
      const args = bugArgs({ title: `Bug number ${index}` });
      await bridge.draft("tab-a", args);
      expect((await bridge.file("tab-a", args)).ok).toBe(true);
    }
    const fourth = bugArgs({ title: "Bug number fourth" });
    await bridge.draft("tab-a", fourth);
    const capped = await bridge.file("tab-a", fourth);
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.reason).toContain(`${ISSUE_FILE_CAP_PER_TAB} issues`);
    bridge.forget("tab-a");
    await bridge.draft("tab-a", fourth);
    expect((await bridge.file("tab-a", fourth)).ok).toBe(true);
    expect(calls.filter((call) => call.args[1] === "create")).toHaveLength(ISSUE_FILE_CAP_PER_TAB + 1);
  });

  it("the cap counts a create even when gh then fails (count precedes the run)", async () => {
    const { bridge } = harness(async (_cwd, args) => (args[1] === "list" ? ok("[]") : { code: 1, stdout: "", stderr: "no permission to submit" }));
    for (let index = 0; index < ISSUE_FILE_CAP_PER_TAB; index += 1) {
      const args = bugArgs({ title: `Failing ${index}` });
      await bridge.draft("tab-a", args);
      const outcome = await bridge.file("tab-a", args);
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect(outcome.reason).toContain("no permission to submit");
    }
    const last = bugArgs({ title: "Failing cap" });
    await bridge.draft("tab-a", last);
    const capped = await bridge.file("tab-a", last);
    expect(capped.ok).toBe(false);
    if (!capped.ok) expect(capped.reason).toContain(`${ISSUE_FILE_CAP_PER_TAB} issues`);
  });

  it("maps gh failure shapes to the four honest lines", async () => {
    const missing = harness(async (): Promise<GhResult> => ({ code: null, missing: true, stdout: "", stderr: "spawn gh ENOENT" }));
    await missing.bridge.draft("t", bugArgs());
    const r1 = await missing.bridge.file("t", bugArgs());
    expect(!r1.ok && r1.reason).toContain("the GitHub CLI (gh) is not installed on this host");

    const unauth = harness(async (_cwd, args): Promise<GhResult> => (args[1] === "list" ? { code: 4, stdout: "", stderr: "gh: To use GitHub..." } : { code: 4, stdout: "", stderr: "gh: To use GitHub..." }));
    await unauth.bridge.draft("t", bugArgs());
    const r2 = await unauth.bridge.file("t", bugArgs());
    expect(!r2.ok && r2.reason).toContain("gh is not authenticated");

    const killed = harness(async (_cwd, args): Promise<GhResult> => (args[1] === "list" ? ok("[]") : { code: null, stdout: "", stderr: "killed" }));
    await killed.bridge.draft("t", bugArgs());
    const r3 = await killed.bridge.file("t", bugArgs());
    expect(!r3.ok && r3.reason).toContain("gh timed out or was killed");

    const generic = harness(async (_cwd, args): Promise<GhResult> => (args[1] === "list" ? ok("[]") : { code: 1, stdout: "", stderr: "first gh line\nsecond" }));
    await generic.bridge.draft("t", bugArgs());
    const r4 = await generic.bridge.file("t", bugArgs());
    expect(!r4.ok && r4.reason).toContain("first gh line");
  });

  it("answers honestly when gh creates but prints no URL", async () => {
    const { bridge } = harness(async (_cwd, args) => (args[1] === "list" ? ok("[]") : ok("Creating issue...\n")));
    const args = bugArgs();
    await bridge.draft("tab-a", args);
    const outcome = await bridge.file("tab-a", args);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("gh did not print a URL");
  });

  it("reports the known duplicates alongside the created URL", async () => {
    const { bridge } = harness(async (_cwd, args) =>
      args[1] === "list" ? ok(JSON.stringify([{ number: 5, title: "same", state: "OPEN", url: "u" }])) : ok("https://x/9"));
    const args = bugArgs();
    await bridge.draft("tab-a", args);
    const outcome = await bridge.file("tab-a", args);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.text).toContain("duplicates");
  });

  it("drafts are per-tab: one tab's draft never authorizes another tab's file", async () => {
    const { bridge, calls } = harness(async (_cwd, args) => (args[1] === "list" ? ok("[]") : ok("https://x/3")));
    const args = bugArgs();
    await bridge.draft("tab-a", args);
    expect((await bridge.file("tab-b", args)).ok).toBe(false);
    expect(calls.some((call) => call.args[1] === "create")).toBe(false);
  });
});

describe("IssueBridge argument surface", () => {
  it("the fingerprint path parses through the shared parser only", async () => {
    // Draft and file agree by construction: both go through parseIssueToolArgs.
    const parsed = parseIssueToolArgs(bugArgs());
    expect(parsed.ok).toBe(true);
  });
});
