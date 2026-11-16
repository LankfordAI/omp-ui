// The issue host tools' answerer (ADR-0095): main owns the user's `gh`
// exactly like linked pull requests do (#414 — omp-ui holds no token), and
// binds what the user approved to what gets filed: `_file` re-renders the
// body from its arguments and refuses unless the (title, repository, body)
// triple hashes equal the last draft this tab produced. The per-tab draft
// fingerprint and the three-per-tab filing cap die with the tab's process
// through `forget`.
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  ISSUE_BODY_MAX,
  duplicateSearchCommand,
  formatIssueDraftAnswer,
  issueDraftFingerprint,
  issueRepositoryOf,
  parseDuplicateRows,
  parseIssueToolArgs,
  renderIssueBody,
  renderIssueTitle,
  runGh,
  scanSecrets,
  type GhResult,
  type GhRunner,
  type IssueDuplicate,
  type IssueToolArgs,
  type IssueVersionFacts,
} from "@omp-ui/core";

export type IssueDraftOutcome = { ok: true; text: string } | { ok: false; reason: string };
export type IssueFileOutcome = { ok: true; text: string } | { ok: false; reason: string };

/** What one tab must reproduce byte-for-byte to file its approved draft. */
interface DraftRecord {
  fingerprint: string;
  /** Duplicates the draft saw; reported again at file time, never a block. */
  duplicates: IssueDuplicate[] | null;
}

/** At most this many filings per tab per process (ADR-0095 runaway cap). */
export const ISSUE_FILE_CAP_PER_TAB = 3;

export interface IssueBridgeDeps {
  draft(tabId: string, args: unknown): Promise<IssueDraftOutcome>;
  file(tabId: string, args: unknown): Promise<IssueFileOutcome>;
  /** Drops the tab's fingerprint and filing counter (exit, hibernate, delete). */
  forget?(tabId: string): void;
}

/** One honest line for a failed gh run, mapped from its exit shape. */
function ghFailureLine(result: GhResult): string {
  if (result.missing === true || (result.code === null && result.stderr.includes("ENOENT"))) {
    return "the GitHub CLI (gh) is not installed on this host";
  }
  if (result.code === 4) return "gh is not authenticated — run `gh auth login`";
  if (result.code === null) return "gh timed out or was killed";
  const firstLine = result.stderr.split("\n").find((line) => line.trim() !== "");
  return firstLine ?? `gh exited with code ${result.code}`;
}

/** The created issue URL: the last non-empty http(s) line gh printed. */
function createdIssueUrl(stdout: string): string | null {
  const lines = stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^https?:\/\//.test(lines[index]!)) return lines[index]!;
  }
  return null;
}

export class IssueBridge implements IssueBridgeDeps {
  private readonly drafts = new Map<string, DraftRecord>();
  private readonly filed = new Map<string, number>();

  constructor(private readonly deps: {
    /** The session working directory; only feeds the gh env — `--repo` is always explicit. */
    cwd(tabId: string): string | null;
    versions(): Promise<{ appVersion: string; ompVersion: string | null }>;
    log(message: string): void;
    runGh?: GhRunner;
  }) {}

  forget(tabId: string): void {
    this.drafts.delete(tabId);
    this.filed.delete(tabId);
  }

  private async render(
    args: unknown,
  ): Promise<
    | { ok: true; parsed: IssueToolArgs; title: string; repository: string; body: string }
    | { ok: false; reason: string }
  > {
    const parsed = parseIssueToolArgs(args);
    if (!parsed.ok) return { ok: false, reason: parsed.reason };
    const facts = await this.deps.versions();
    const versionFacts: IssueVersionFacts = {
      appVersion: facts.appVersion,
      ompVersion: facts.ompVersion,
      os: `${os.type()} ${os.release()}`,
    };
    const title = renderIssueTitle(parsed.args);
    const body = renderIssueBody(parsed.args, versionFacts);
    if (body.length > ISSUE_BODY_MAX) {
      return { ok: false, reason: `rendered body is over ${ISSUE_BODY_MAX} characters` };
    }
    // The guard runs before the duplicate search (whose words leave for
    // GitHub) and before anything reaches the transcript, so a redraft
    // happens before the user ever sees — let alone approves — the draft.
    const shape = scanSecrets(`${title}\n${body}`);
    if (shape !== null) {
      return { ok: false, reason: `refused: the title or body carries a secret-shaped string (${shape}); redraft without it` };
    }
    return { ok: true, parsed: parsed.args, title, repository: issueRepositoryOf(parsed.args), body };
  }

  /** Validates, secret-scans, renders, and searches duplicates. Files nothing. */
  async draft(tabId: string, args: unknown): Promise<IssueDraftOutcome> {
    const rendered = await this.render(args);
    if (!rendered.ok) return rendered;
    const gh = this.deps.runGh ?? runGh;
    const cwd = this.deps.cwd(tabId) ?? os.homedir();
    const search = await gh(cwd, duplicateSearchCommand(rendered.repository, rendered.title)).catch(
      (): GhResult => ({ code: null, stdout: "", stderr: "duplicate search threw" }),
    );
    let duplicates: IssueDuplicate[] | null = null;
    let searchFailure: string | null = null;
    if (search.code === 0) {
      duplicates = parseDuplicateRows(search.stdout);
    } else {
      searchFailure = ghFailureLine(search);
    }
    this.drafts.set(tabId, {
      fingerprint: issueDraftFingerprint(rendered.title, rendered.repository, rendered.body),
      duplicates,
    });
    return {
      ok: true,
      text: formatIssueDraftAnswer(rendered.repository, rendered.title, rendered.body, duplicates, searchFailure),
    };
  }

  /** The only write: refuses unless the draft fingerprint matches, then `gh issue create`. */
  async file(tabId: string, args: unknown): Promise<IssueFileOutcome> {
    const rendered = await this.render(args);
    if (!rendered.ok) return rendered;
    const draft = this.drafts.get(tabId);
    const fingerprint = issueDraftFingerprint(rendered.title, rendered.repository, rendered.body);
    if (draft === undefined || draft.fingerprint !== fingerprint) {
      return {
        ok: false,
        reason: "file refused: these arguments do not reproduce the last omp-ui_issue_draft of this session — call omp-ui_issue_draft again with them and ask the user before filing",
      };
    }
    const used = this.filed.get(tabId) ?? 0;
    if (used >= ISSUE_FILE_CAP_PER_TAB) {
      return { ok: false, reason: `file refused: this tab already filed ${ISSUE_FILE_CAP_PER_TAB} issues this app run` };
    }
    // Counted BEFORE the create runs: a late gh success after the watchdog
    // answered still counts against the cap.
    this.filed.set(tabId, used + 1);
    const gh = this.deps.runGh ?? runGh;
    const cwd = this.deps.cwd(tabId) ?? os.homedir();
    const dir = await mkdtemp(path.join(os.tmpdir(), "omp-ui-issue-"));
    const bodyFile = path.join(dir, "body.md");
    let result: GhResult;
    try {
      await writeFile(bodyFile, rendered.body, { mode: 0o600 });
      result = await gh(cwd, [
        "issue", "create",
        "--repo", rendered.repository,
        "--title", rendered.title,
        "--label", rendered.parsed.kind === "feature" ? "enhancement" : "bug",
        "--body-file", bodyFile,
      ]);
    } finally {
      await unlink(bodyFile).catch(() => undefined);
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (result.code !== 0) {
      return { ok: false, reason: `issue create failed: ${ghFailureLine(result)}` };
    }
    const url = createdIssueUrl(result.stdout);
    this.deps.log(`filed issue for tab ${tabId}: ${url ?? "url unparseable from gh output"}`);
    if (url === null) return { ok: true, text: `Filed the issue in ${rendered.repository}; gh did not print a URL.` };
    const note = draft.duplicates !== null && draft.duplicates.length > 0
      ? " Note: the draft search had found possible duplicates; they were reported to the user before filing."
      : "";
    return { ok: true, text: `Filed ${url}.${note}` };
  }
}
