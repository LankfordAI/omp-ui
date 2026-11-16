// The agent's issue tools (ADR-0095): `omp-ui_issue_draft` recommends and
// `omp-ui_issue_file` creates; the host's issue bridge binds what the user
// approved to what gets filed by fingerprinting the rendered body. Pure module
// mirroring theme-tool.ts — the renderer reaches it through host-bridge, so it
// imports nothing from node (#1179): definitions, strict-object schemas, a
// parser that refuses one line naming the field, a body renderer whose
// headings match the repo's issue templates verbatim, and the duplicate-search
// helpers. One flat object schema per tool — no root unions (#1135); per-kind
// requirements live in the parser.
import { isObject } from "./guards";
import type { RpcHostToolDefinition } from "./host-bridge";

export const ISSUE_DRAFT_TOOL_NAME = "omp-ui_issue_draft";
export const ISSUE_FILE_TOOL_NAME = "omp-ui_issue_file";

/** Where filings go unless the caller names another repository. */
export const DEFAULT_ISSUE_REPOSITORY = "LankfordAI/omp-ui";

export type IssueKind = "bug" | "feature";

/** The exact `bug_report.yml` "Tab mode" dropdown strings. */
export const BUG_TAB_MODES = [
  "PTY / terminal tab (xterm.js)",
  "rpc-ui / native transcript",
  "Both",
  "N/A (sidebar, launcher, session scanning, other)",
] as const;
export type BugTabMode = (typeof BUG_TAB_MODES)[number];

/** The exact `feature_request.yml` "Area" dropdown strings. */
export const ISSUE_AREAS = [
  "Sidebar / projects / sessions",
  "Terminal tab (PTY / xterm.js)",
  "Native transcript (rpc-ui)",
  "Composer",
  "Session HUD",
  "Inspector rail",
  "Plan mode / plan review",
  "packages/core (PTY manager, rpc-ui client, session scanner)",
  "Packaging / distribution",
  "Other",
] as const;
export type IssueArea = (typeof ISSUE_AREAS)[number];

export interface IssueToolArgs {
  kind: IssueKind;
  /** WITHOUT the "[Bug]: "/"[Feature]: " prefix; the renderer adds it. */
  title: string;
  /** bug: Description — feature: Problem / motivation. */
  description: string;
  /** bug required. */
  steps?: string;
  /** bug required. */
  expected?: string;
  /** bug required. */
  actual?: string;
  /** bug required, exact template dropdown option. */
  tabMode?: BugTabMode;
  /** bug optional → "Logs / output" as a fenced shell block. */
  logs?: string;
  /** feature required ("Proposed solution"). */
  proposal?: string;
  /** feature required, exact template dropdown option. */
  area?: IssueArea;
  /** feature optional. */
  alternatives?: string;
  /** feature optional → "Additional context", plain markdown. */
  context?: string;
  /** default {@link DEFAULT_ISSUE_REPOSITORY}; owner/repo pattern only. */
  repository?: string;
}

const TITLE_MAX = 200;
const SECTION_MAX = 16_000;
/** Total rendered-body cap; the bridge refuses a body over it. */
export const ISSUE_BODY_MAX = 64_000;
const REPOSITORY_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** Single-line fields reject EVERY control char, newline included (fleet's CONTROL_CHARS shape). */
const SINGLE_LINE_CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
/** Multi-line free text allows \n and \t but nothing else in the C0/C1 ranges. */
const MULTI_LINE_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
/** A leading template prefix on the agent's title is stripped before re-adding. */
const LEADING_PREFIX = /^\[(?:bug|feature)\]:\s*/i;

const ALL_FIELDS = [
  "kind", "title", "description", "steps", "expected", "actual", "tabMode", "logs",
  "proposal", "area", "alternatives", "context", "repository",
] as const;
const BUG_ONLY = ["steps", "expected", "actual", "tabMode"] as const;
const FEATURE_ONLY = ["proposal", "area", "alternatives", "context"] as const;

const DRAFT_CONSENT =
  " Filing requires the user's explicit request for it in this session: show this draft, ask, and call omp-ui_issue_file with these exact arguments only after they ask for the filing. ";

function issueToolParameters(): Record<string, unknown> {
  return {
    type: "object",
    additionalProperties: false,
    required: ["kind", "title", "description"],
    properties: {
      kind: { type: "string", enum: ["bug", "feature"] },
      title: {
        type: "string",
        minLength: 1,
        maxLength: TITLE_MAX,
        description: `Issue title WITHOUT the "[Bug]: "/"[Feature]: " prefix (the host adds it); single line, at most ${TITLE_MAX} characters.`,
      },
      description: {
        type: "string",
        description: "bug: what went wrong (Description) — feature: the problem, not just the solution (Problem / motivation). Use omp-ui vocabulary (session, tab, lineage, inspector rail, ...).",
      },
      steps: { type: "string", description: "bug only, required: numbered steps to reproduce." },
      expected: { type: "string", description: "bug only, required: expected behavior." },
      actual: { type: "string", description: "bug only, required: actual behavior." },
      tabMode: { type: "string", enum: [...BUG_TAB_MODES], description: "bug only, required: the affected rendering mode; one of these exact strings." },
      logs: { type: "string", description: "bug only, optional: main-process or devtools console output; rendered as a fenced shell block." },
      proposal: { type: "string", description: "feature only, required: what should omp-ui do (Proposed solution)." },
      area: { type: "string", enum: [...ISSUE_AREAS], description: "feature only, required: the affected area; one of these exact strings." },
      alternatives: { type: "string", description: "feature only, optional: other approaches and why they fall short (Alternatives considered)." },
      context: { type: "string", description: "feature only, optional: screenshots, links, related issues (Additional context)." },
      repository: {
        type: "string",
        pattern: REPOSITORY_PATTERN.source,
        description: `owner/repo to file against; defaults to "${DEFAULT_ISSUE_REPOSITORY}".`,
      },
    },
  };
}

export function issueDraftTool(): RpcHostToolDefinition {
  return {
    name: ISSUE_DRAFT_TOOL_NAME,
    loadMode: "essential",
    description:
      "Recommend a GitHub issue for omp-ui without filing it: validates the fields against the repo's issue templates, refuses a title or body carrying secret shapes before anything is shown, renders the exact markdown body the web form would produce (with the host's own omp-ui / omp / OS facts for bugs), and searches existing issues for duplicates. Files nothing. " +
      "A duplicate means report it and stop — commenting on an existing issue is the user's own path, not this tool's. Set the field values exactly as you would file them:" +
      DRAFT_CONSENT +
      "This tool exists only in native-transcript (rpc-ui) sessions; terminal tabs have no host tools.",
    parameters: issueToolParameters(),
  };
}

export function issueFileTool(): RpcHostToolDefinition {
  return {
    name: ISSUE_FILE_TOOL_NAME,
    loadMode: "essential",
    description:
      "File a GitHub issue with the user's own gh CLI — the only write verb. Call it ONLY after the user explicitly asked for this filing in this session; never file on your own. Refused unless these arguments re-render byte-for-byte the body of the last omp-ui_issue_draft this session produced: change anything and you must draft again so what the user approved is exactly what gets filed. " +
      "A duplicate found at file time is reported in the answer; filing proceeds only because the user asked. At most three filings per tab per app run. " +
      "A failed answer does not prove nothing was created: gh can finish after the host's answer window closed — check for the issue before ever retrying." +
      DRAFT_CONSENT.slice(1),
    parameters: issueToolParameters(),
  };
}

type Parsed<T> = { ok: true; value: T } | { ok: false, reason: string };

/** The first key of `value` outside `keys`, named by its bare field name. */
function unknownKey(value: Record<string, unknown>, keys: readonly string[]): string | null {
  const extra = Object.keys(value).find((key) => !keys.includes(key));
  return extra === undefined ? null : `unknown field ${extra}`;
}

function parseTitleField(value: unknown): Parsed<string> {
  if (typeof value !== "string") return { ok: false, reason: "title must be a string" };
  if (SINGLE_LINE_CONTROL.test(value)) return { ok: false, reason: "title must be a single line without control characters" };
  const title = value.trim();
  if (title === "") return { ok: false, reason: "title must not be empty" };
  if (title.length > TITLE_MAX) return { ok: false, reason: `title must be at most ${TITLE_MAX} characters` };
  return { ok: true, value: title.replace(LEADING_PREFIX, "").trim() };
}

function parseRepositoryField(value: unknown): Parsed<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string" || SINGLE_LINE_CONTROL.test(value)) {
    return { ok: false, reason: "repository must be a single-line owner/repo string" };
  }
  if (!REPOSITORY_PATTERN.test(value)) return { ok: false, reason: "repository must match owner/repo" };
  return { ok: true, value };
}

/** Required free-text section: CRLF/CR normalized to \n, \t allowed, other control chars refused; an empty body refuses. */
function parseRequiredSection(value: unknown, field: string): Parsed<string> {
  if (value === undefined) return { ok: false, reason: `${field} is required for this kind of issue` };
  const parsed = parseOptionalSection(value, field);
  if (!parsed.ok) return parsed;
  if (parsed.value === undefined) return { ok: false, reason: `${field} must not be empty` };
  return { ok: true, value: parsed.value };
}

/** Optional free-text section: same rules; whitespace-only collapses to absent. */
function parseOptionalSection(value: unknown, field: string): Parsed<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string") return { ok: false, reason: `${field} must be a string` };
  const text = value.replace(/\r\n?/g, "\n");
  if (MULTI_LINE_CONTROL.test(text)) return { ok: false, reason: `${field} carries control characters` };
  if (text.trim() === "") return { ok: true, value: undefined };
  if (text.length > SECTION_MAX) return { ok: false, reason: `${field} must be at most ${SECTION_MAX} characters` };
  return { ok: true, value: text };
}

/**
 * Validates the agent's arguments for EITHER issue tool — one parser, so draft
 * and file can never disagree about what the same arguments mean. A refusal
 * names the first missing or invalid field, one line (#1168 style).
 */
export function parseIssueToolArgs(args: unknown): { ok: true; args: IssueToolArgs } | { ok: false; reason: string } {
  if (!isObject(args) || Array.isArray(args)) return { ok: false, reason: "arguments must be an object" };
  const extra = unknownKey(args, ALL_FIELDS);
  if (extra !== null) return { ok: false, reason: extra };
  const { kind } = args;
  if (kind !== "bug" && kind !== "feature") return { ok: false, reason: 'kind must be "bug" or "feature"' };
  const title = parseTitleField(args.title);
  if (!title.ok) return title;
  const description = parseRequiredSection(args.description, "description");
  if (!description.ok) return description;

  const forbidden = kind === "bug" ? FEATURE_ONLY : [...BUG_ONLY, "logs"];
  for (const field of forbidden) {
    if (args[field] !== undefined) {
      return { ok: false, reason: `${field} belongs to ${kind === "bug" ? "feature" : "bug"} issues, not ${kind}` };
    }
  }

  const parsed: IssueToolArgs = { kind, title: title.value, description: description.value };
  if (kind === "bug") {
    for (const field of ["steps", "expected", "actual"] as const) {
      const section = parseRequiredSection(args[field], field);
      if (!section.ok) return section;
      parsed[field] = section.value;
    }
    const { tabMode } = args;
    if (tabMode === undefined) return { ok: false, reason: "tabMode is required for this kind of issue" };
    if (typeof tabMode !== "string" || !(BUG_TAB_MODES as readonly string[]).includes(tabMode)) {
      return { ok: false, reason: `tabMode must be one of: ${BUG_TAB_MODES.join(", ")}` };
    }
    parsed.tabMode = tabMode as BugTabMode;
    const logs = parseOptionalSection(args.logs, "logs");
    if (!logs.ok) return logs;
    if (logs.value !== undefined) parsed.logs = logs.value;
  } else {
    const proposal = parseRequiredSection(args.proposal, "proposal");
    if (!proposal.ok) return proposal;
    parsed.proposal = proposal.value;
    const { area } = args;
    if (area === undefined) return { ok: false, reason: "area is required for this kind of issue" };
    if (typeof area !== "string" || !(ISSUE_AREAS as readonly string[]).includes(area)) {
      return { ok: false, reason: `area must be one of: ${ISSUE_AREAS.join(", ")}` };
    }
    parsed.area = area as IssueArea;
    const alternatives = parseOptionalSection(args.alternatives, "alternatives");
    if (!alternatives.ok) return alternatives;
    if (alternatives.value !== undefined) parsed.alternatives = alternatives.value;
    const context = parseOptionalSection(args.context, "context");
    if (!context.ok) return context;
    if (context.value !== undefined) parsed.context = context.value;
  }
  const repository = parseRepositoryField(args.repository);
  if (!repository.ok) return repository;
  if (repository.value !== undefined) parsed.repository = repository.value;
  return { ok: true, args: parsed };
}

/** Host-supplied facts the bug template asks for; never rewritten from agent prose. */
export interface IssueVersionFacts {
  appVersion: string;
  ompVersion: string | null;
  os: string;
}

export function issueRepositoryOf(args: IssueToolArgs): string {
  return args.repository ?? DEFAULT_ISSUE_REPOSITORY;
}

/** The template-prefixed title: a leading [Bug]:/[Feature]: never doubles up. */
export function renderIssueTitle(args: IssueToolArgs): string {
  return `${args.kind === "bug" ? "[Bug]" : "[Feature]"}: ${args.title.replace(LEADING_PREFIX, "").trim()}`;
}

function section(heading: string, body: string): string {
  return `## ${heading}\n\n${body.trim()}`;
}

/**
 * The markdown body the GitHub web form would produce for these answers:
 * headings match the template labels verbatim, in template order. The version
 * block (omp-ui version / commit, omp version, OS — the bug template's three
 * inputs) is appended once from host facts; agent prose that repeats versions
 * is ordinary extra text, never rewritten. Feature bodies carry no version
 * fields because the feature template asks for none.
 */
export function renderIssueBody(args: IssueToolArgs, facts: IssueVersionFacts): string {
  const sections: string[] = [];
  if (args.kind === "bug") {
    sections.push(section("Description", args.description));
    sections.push(section("Steps to reproduce", args.steps ?? ""));
    sections.push(section("Expected behavior", args.expected ?? ""));
    sections.push(section("Actual behavior", args.actual ?? ""));
    sections.push(section("Tab mode", args.tabMode ?? ""));
    sections.push(section("omp-ui version / commit", facts.appVersion));
    sections.push(section("omp version", facts.ompVersion ?? "unknown"));
    sections.push(section("OS", facts.os));
    if (args.logs !== undefined && args.logs.trim() !== "") {
      sections.push(section("Logs / output", `\`\`\`shell\n${args.logs.trim()}\n\`\`\``));
    }
  } else {
    sections.push(section("Problem / motivation", args.description));
    sections.push(section("Proposed solution", args.proposal ?? ""));
    sections.push(section("Area", args.area ?? ""));
    if (args.alternatives !== undefined && args.alternatives.trim() !== "") {
      sections.push(section("Alternatives considered", args.alternatives));
    }
    if (args.context !== undefined && args.context.trim() !== "") {
      sections.push(section("Additional context", args.context));
    }
  }
  return `${sections.join("\n\n")}\n`;
}

/** gh args (after "gh") searching up to the 6 longest title words; failure never blocks anything. */
export function duplicateSearchCommand(repository: string, title: string): string[] {
  const tokens = title.split(/[^A-Za-z0-9._-]+/).filter((token) => token.length > 0);
  const seen = new Map<string, { index: number; token: string }>();
  tokens.forEach((token, index) => {
    const key = token.toLowerCase();
    if (!seen.has(key)) seen.set(key, { index, token });
  });
  const picked = Array.from(seen.values())
    .sort((a, b) => b.token.length - a.token.length || a.index - b.index)
    .slice(0, 6)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.token);
  return [
    "issue", "list",
    "--repo", repository,
    "--search", picked.join(" "),
    "--limit", "5",
    "--json", "number,title,state,url",
  ];
}

export interface IssueDuplicate {
  number: number;
  title: string;
  state: string;
  url: string;
}

/** Tolerant gh JSON reader: a malformed row drops only itself; garbage is []. */
export function parseDuplicateRows(raw: string): IssueDuplicate[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const rows: IssueDuplicate[] = [];
  for (const row of parsed) {
    if (!isObject(row)) continue;
    const { number, title, state, url } = row;
    if (typeof number !== "number" || !Number.isInteger(number) || typeof title !== "string" ||
        typeof state !== "string" || typeof url !== "string") {
      continue;
    }
    rows.push({ number, title, state, url });
  }
  return rows;
}

/**
 * The draft answer text: the ready-to-show markdown plus the duplicate
 * section. `duplicates === null` means the search failed — one honest line,
 * never a blocked draft.
 */
export function formatIssueDraftAnswer(
  repository: string,
  title: string,
  body: string,
  duplicates: IssueDuplicate[] | null,
  searchFailure: string | null,
): string {
  const lines = [
    `Draft issue for ${repository} — nothing was filed.`,
    `Title: ${title}`,
    "",
    "Body:",
    body,
    "Duplicates:",
  ];
  if (duplicates === null) {
    lines.push(`duplicate search unavailable (${searchFailure ?? "gh failed"}); the draft stands without it.`);
  } else if (duplicates.length === 0) {
    lines.push("none found.");
  } else {
    for (const row of duplicates) lines.push(`#${row.number} [${row.state}] ${row.title} — ${row.url}`);
    lines.push("A duplicate means report it and stop unless the user explicitly asks for a second issue anyway.");
  }
  lines.push(
    "",
    "Show this draft to the user. File only after they explicitly ask for this filing in this session, by calling omp-ui_issue_file with these exact arguments.",
  );
  return lines.join("\n");
}
