import * as path from "node:path";
import {
  COMPOSER_PREDICTION_MAX_CHARS,
  COMPOSER_PREDICTION_MAX_CHOICES,
  COMPOSER_PREDICTIONS_COMMAND,
  COMPOSER_PREDICTIONS_REQUEST_PREFIX,
  COMPOSER_PREDICTIONS_STATUS_BYTE_LIMIT,
  COMPOSER_PREDICTIONS_STATUS_KEY,
  COMPOSER_PREDICTION_USAGE_PURPOSE,
} from "./composer-predictions";
import { writeLineageArtifact } from "./lineage-artifact";
import {
  generatedAsRecordSource,
  generatedOmpSettingReaderSource,
  generatedPollTimerSource,
  generatedRootBindingSource,
} from "./generated-extension-source";

/**
 * The composer next-message prediction bridge (issue #1239). OMP's TUI
 * predicts the user's next message after a completed turn with one ephemeral
 * side turn (`composer-prediction-controller.ts`); docs/rpc.md has no
 * command or event for it, so the only host-reachable route is an extension's
 * `ctx.runEphemeralTurn` — present on both harness floors (18.22.x and
 * 19.0.0). This generated bridge takes that route:
 *
 * - Bare arm: binds the command context's `ui`, captures the root session via
 *   the patched `AgentSession.prototype.prompt` (the established pattern), and
 *   publishes availability — side turns reachable AND omp's EFFECTIVE
 *   `composer.predictions` reads true (ADR-0036 registry read; an off or
 *   unreadable value never bills).
 * - `request <json>`: re-checks every gate (setting, side turn, model, not
 *   streaming/compacting), then runs the prediction side turn with upstream's
 *   own deadline and reply-shaping rules. The billed request's usage is
 *   journaled as a `model_usage` entry with purpose `composer-prediction`
 *   against the journal session id and leaf — 18.22.x does NOT journal
 *   extension side turns on its own (the auto-journal landed in 19.0.0), so
 *   the bridge journals it itself on every harness, never invisible spend.
 *   The handler acks immediately; the result rides the next publish.
 * - A turn starting mid-request aborts the side turn and retires the result
 *   as `stale` (mirrors upstream's `#isCurrent` invalidation).
 *
 * Word completion (`predict_word`) is a different upstream feature; nothing
 * here touches it.
 */

/** The extension file lives beside the transcript so it dies with the lineage. */
const EXTENSION_NAME = "omp-ui-composer-predictions.ts";

export function composerPredictionsExtensionPath(lineageDir: string): string {
  return path.join(lineageDir, EXTENSION_NAME);
}

/** Upstream's prompt template (composer-prediction-user.md), rendered for one reply. */
const PREDICTION_PROMPT_SINGLE = JSON.stringify(
  "Predict the user's next message in this conversation. Reply with that message only, exactly as the user would type it.\n" +
    "- Write as the user: their voice, language, tone, and typical length, judged only from messages they typed themselves. Mirror how they phrase requests.\n" +
    "- Follow up on the latest assistant reply: approve, redirect, ask for the next step, or report a result.\n" +
    "- One line. No quotes, preamble, or markdown.\n" +
    "- Keep it short; usually under 20 words.\n" +
    '- The user is the person at the keyboard. Messages attributed to another agent, session, or tool are relayed, not theirs: <irc> blocks, and pasted notes headed with a sender (e.g. "Note from the build session: …", "From LEAD: …"). Never predict a relay or write in its sender\'s voice.\n' +
    "- No confident guess: reply exactly NO_PREDICTION",
);

/** The same template rendered with alternatives on: up to N lines, most likely first. */
function predictionPromptChoices(count: number): string {
  return JSON.stringify(
    "Predict the user's next message in this conversation. Reply with up to " +
      count +
      " different messages they might send next, one per line, most likely first, each exactly as the user would type it.\n" +
      "- Write as the user: their voice, language, tone, and typical length, judged only from messages they typed themselves. Mirror how they phrase requests.\n" +
      "- Follow up on the latest assistant reply: approve, redirect, ask for the next step, or report a result.\n" +
      "- Make each line a different next step or intent, never a rewording of another line. Include only plausible ones; fewer lines is fine.\n" +
      "- One message per line. No numbering, bullets, quotes, preamble, or markdown.\n" +
      "- Keep each short; usually under 20 words.\n" +
      '- The user is the person at the keyboard. Messages attributed to another agent, session, or tool are relayed, not theirs: <irc> blocks, and pasted notes headed with a sender (e.g. "Note from the build session: …", "From LEAD: …"). Never predict a relay or write in its sender\'s voice.\n' +
      "- No confident guess: reply exactly NO_PREDICTION",
  );
}

/**
 * The generated source imports nothing outside node builtins and omp's own
 * literal specifiers; the wire constants are interpolated from
 * composer-predictions.ts so the publishing side can never drift from the
 * parser the renderer shares.
 */
function extensionSource(): string {
  return `// Generated by omp-ui. Rewritten on every spawn; edits are not preserved.
const STATUS_KEY = ${JSON.stringify(COMPOSER_PREDICTIONS_STATUS_KEY)};
const COMMAND = ${JSON.stringify(COMPOSER_PREDICTIONS_COMMAND)};
const REQUEST_PREFIX = ${JSON.stringify(COMPOSER_PREDICTIONS_REQUEST_PREFIX)};
const MAX_CHARS = ${COMPOSER_PREDICTION_MAX_CHARS};
const MAX_CHOICES = ${COMPOSER_PREDICTION_MAX_CHOICES};
const BYTE_LIMIT = ${COMPOSER_PREDICTIONS_STATUS_BYTE_LIMIT};
const USAGE_PURPOSE = ${JSON.stringify(COMPOSER_PREDICTION_USAGE_PURPOSE)};
/** Upstream PREDICTION_DEADLINE_MS: a later reply is no longer worth paying for or showing. */
const DEADLINE_MS = 15000;
/** Upstream PREDICTION_MAX_TOKENS, sent only where the cap leaves reasoning unchanged. */
const PREDICTION_MAX_TOKENS = 1024;
const SKIP_REPLY = "NO_PREDICTION";
const PREDICT_PROMPT_SINGLE = ${PREDICTION_PROMPT_SINGLE};
const PREDICT_PROMPT_CHOICES = ${predictionPromptChoices(4)};
/** Cap on one correlation id carried over the wire. */
const REQUEST_ID_LIMIT = 128;

${generatedAsRecordSource()}

${generatedOmpSettingReaderSource()}

interface PredictionSession {
  settings?: unknown;
  model?: unknown;
  isStreaming?: unknown;
  isCompacting?: unknown;
  ephemeralMaxTokensPreservesRequest?: () => boolean;
}

interface StatusUi {
  setStatus: (key: string, text: string | undefined) => void;
}

interface ManagerLike {
  getSessionId?: () => unknown;
  getLeafId?: () => unknown;
  getEntry?: (id: string) => unknown;
  appendModelUsage?: (usage: Record<string, unknown>, owner: { sessionId: string; parentId: string | null }) => unknown;
}

interface UsageMessage {
  api?: unknown;
  provider?: unknown;
  model?: unknown;
  usage?: unknown;
  stopReason?: unknown;
  errorMessage?: unknown;
}

interface SideTurnOptions {
  promptText: string;
  maxTokens?: number;
  minimizeEffort?: boolean;
  signal?: AbortSignal;
  onUsage?: (message: UsageMessage) => void;
}

interface PredictionContext {
  ui: StatusUi;
  sessionManager?: ManagerLike;
  runEphemeralTurn?: (options: SideTurnOptions) => Promise<{ replyText?: unknown }>;
}

interface ExtensionApi {
  pi?: { AgentSession?: { prototype?: Record<string, unknown> } };
  on?: (event: string, handler: () => void) => void;
  registerCommand: (
    name: string,
    options: {
      description?: string;
      handler: (args: string, ctx: PredictionContext) => Promise<void> | void;
    },
  ) => void;
}

type DraftResult =
  | { requestId: string; ok: true; choices: string[] }
  | { requestId: string; ok: false; reason: string };

${generatedPollTimerSource()}

interface Inflight {
  requestId: string;
  controller: AbortController;
  /** True once the deadline (not a new turn) cancelled the side turn. */
  timedOut: boolean;
  timer: PollTimer;
  /**
   * Ids this request journaled as model_usage entries. appendModelUsage parents
   * its entry to the request's leaf and may move the leaf onto it, so the
   * staleness check must read that move as the bridge's own bookkeeping —
   * upstream keys staleness on the conversation's last message for exactly
   * this reason (its journaling rides the same journal).
   */
  journaled: Set<string>;
}

const PROCESS_KEY = "omp-ui-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2);

let rootSession: PredictionSession | null = null;
${generatedRootBindingSource("PredictionSession")}
let ui: StatusUi | null = null;
let revision = 0;
/** Latest request outcome, republished with every snapshot until replaced. */
let result: DraftResult | null = null;
/** False once a command context is seen without ctx.runEphemeralTurn. */
let sideTurnsMissing = false;
let inflight: Inflight | null = null;

// ── Reply shaping: upstream's parse of the prediction reply ────────────────

/** One pair of double quotes or backticks around the whole reply. */
const WRAPPING_QUOTES = /^(?:"([^"]*)"|\u201c([^\u201c\u201d]*)\u201d|\`([^\`]*)\`)$/;
/** A list marker some models put before each alternative despite the prompt. */
const LIST_MARKER = /^\\s*(?:[-*\u2022]|\\d{1,2}[.)])\\s+/;
/** Everything but letters and digits, so case/punctuation-only variants fold together. */
const NON_WORD = /[^\\p{L}\\p{N}]+/gu;

/** Normalize one reply line, or undefined for a skip, a ramble, or nothing usable. */
function parsePredictionLine(reply: string): string | undefined {
  let text = reply.replace(/\\s+/g, " ").trim();
  const quoted = WRAPPING_QUOTES.exec(text);
  if (quoted !== null) text = (quoted[1] ?? quoted[2] ?? quoted[3] ?? "").trim();
  if (!text || text.indexOf(SKIP_REPLY) >= 0 || text.length > MAX_CHARS) return undefined;
  return text;
}

/** Single-reply parse: the whole reply is one message, or nothing usable. */
function parseSingleReply(reply: string): string[] | undefined {
  const text = parsePredictionLine(reply);
  return text === undefined ? undefined : [text];
}

/** Alternatives parse: one per line, most likely first, at most max distinct. */
function parseChoicesReply(reply: string, max: number): string[] | undefined {
  const lines = reply
    .split(/\\r?\\n/)
    .map((raw) => raw.replace(LIST_MARKER, ""))
    .filter((line) => line.trim() !== "");
  const choices: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (choices.length === max) break;
    // A skip in place of the most likely message declines the whole prediction.
    if (choices.length === 0 && lines[i].indexOf(SKIP_REPLY) >= 0) return undefined;
    const text = parsePredictionLine(lines[i]);
    if (text === undefined) continue;
    // "Here are some options:" introducing the alternatives below it, despite the prompt.
    if (i === 0 && i < lines.length - 1 && text.endsWith(":")) continue;
    const folded = text.toLowerCase().replace(NON_WORD, " ").trim();
    const key = folded === "" ? text : folded;
    if (seen.has(key)) continue;
    seen.add(key);
    choices.push(text);
  }
  return choices.length > 0 ? choices : undefined;
}

// ── Snapshot publishing ────────────────────────────────────────────────────

/** omp's effective \`composer.predictions\`; true/false only when truly read. */
function masterSetting(): boolean | null {
  if (rootSession === null) return null;
  const value = readOmpSetting(rootSession.settings, "composer.predictions");
  return typeof value === "boolean" ? value : null;
}

function alternativesSetting(): boolean {
  if (rootSession === null) return false;
  return readOmpSetting(rootSession.settings, "composer.predictionAlternatives") === true;
}

function publish(): void {
  if (ui === null) return;
  const master = masterSetting();
  let unavailable: string | null = null;
  if (rootSession === null) unavailable = "no-session";
  else if (sideTurnsMissing) unavailable = "missing-api";
  else if (master === null) unavailable = "settings-unreadable";
  else if (!master) unavailable = "settings-off";
  const snapshot = {
    version: 1,
    processKey: PROCESS_KEY,
    revision: revision + 1,
    available: unavailable === null,
    unavailable,
    result,
  };
  let json = JSON.stringify(snapshot);
  if (json.length > BYTE_LIMIT) {
    // Choices are capped upstream; an overflow can only come from a hostile
    // shape. Degrade the availability rather than flood the status channel.
    json = JSON.stringify({ ...snapshot, available: false, unavailable: "payload-too-large" });
  }
  revision += 1;
  ui.setStatus(STATUS_KEY, json);
}

// ── Request handling ───────────────────────────────────────────────────────

/** Strict allowlist parse mirroring ComposerPredictionRequest; null on anything else. */
function parseRequest(json: string): { requestId: string } | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  const record = asRecord(value);
  if (record === null) return null;
  const keys = Object.keys(record).sort();
  if (keys.length !== 1 || keys[0] !== "requestId") return null;
  if (typeof record.requestId !== "string") return null;
  if (record.requestId.length === 0 || record.requestId.length > REQUEST_ID_LIMIT) return null;
  return { requestId: record.requestId };
}

function journalUsage(
  manager: ManagerLike | undefined,
  owner: { sessionId: string; parentId: string | null },
  message: UsageMessage,
  journaled: Set<string>,
): void {
  if (manager === undefined || typeof manager.appendModelUsage !== "function") return;
  try {
    const id = manager.appendModelUsage(
      {
        purpose: USAGE_PURPOSE,
        api: message.api,
        provider: message.provider,
        model: message.model,
        usage: message.usage,
        stopReason: message.stopReason,
        errorMessage: message.errorMessage,
      },
      owner,
    );
    if (typeof id === "string") journaled.add(id);
  } catch {
    // Usage journaling must never break the prediction — but a refusal here
    // would mean invisible spend, so keep it visibly narrow to the entry.
  }
}

/** omp's journal entry parentId for \`id\`, or null when unreadable. */
function entryParentId(manager: ManagerLike | undefined, id: string): string | null {
  if (manager === undefined || typeof manager.getEntry !== "function") return null;
  try {
    const entry = asRecord(manager.getEntry(id));
    if (entry === null) return null;
    const parent = entry.parentId;
    return typeof parent === "string" || parent === null ? (parent as string | null) : null;
  } catch {
    return null;
  }
}

/**
 * The request's conversation leaf with this bridge's own bookkeeping undone:
 * appendModelUsage parents its entry to the request's leaf and leaves it as
 * the journal leaf when nothing had moved since, so the walk back over our own
 * composer-prediction entries restores the point the request branched from.
 * Any other move — a real new message — ends the walk short.
 */
function leafExcludingOwnJournal(manager: ManagerLike | undefined, journaled: Set<string>): string | null {
  let leaf = managerString(manager, "getLeafId");
  for (let guard = 0; guard < 64 && leaf !== null && journaled.has(leaf); guard++) {
    leaf = entryParentId(manager, leaf);
  }
  return leaf;
}

function managerString(manager: ManagerLike | undefined, method: "getSessionId" | "getLeafId"): string | null {
  if (manager === undefined) return null;
  const read = manager[method];
  if (typeof read !== "function") return null;
  try {
    const value = read.call(manager);
    return typeof value === "string" || value === null ? (value as string | null) : null;
  } catch {
    return null;
  }
}

function clearDeadline(entry: Inflight): void {
  try {
    clearTimeout(entry.timer as unknown as number);
  } catch {
    /* a runtime that refuses clearTimeout still loses its handle */
  }
}

function cancelInflight(reason: string): void {
  if (inflight === null) return;
  const current = inflight;
  inflight = null;
  clearDeadline(current);
  result = { requestId: current.requestId, ok: false, reason };
  // Publish the retirement (upstream's cancel() re-renders): a late publish
  // would otherwise be the client's first word that its request is gone.
  publish();
  current.controller.abort();
}

function failResult(requestId: string, reason: string): void {
  result = { requestId, ok: false, reason };
  publish();
}

function startPrediction(ctx: PredictionContext, requestId: string): void {
  const session = rootSession;
  // Every gate re-read at request time: the effective setting is the bill
  // gate (live opt-out), and a busy session must never be asked.
  if (masterSetting() !== true) {
    failResult(requestId, masterSetting() === false ? "off" : "unavailable");
    return;
  }
  const run = ctx.runEphemeralTurn;
  if (typeof run !== "function") {
    sideTurnsMissing = true;
    failResult(requestId, "unavailable");
    return;
  }
  if (session === null || session.model === undefined || session.model === null) {
    failResult(requestId, "unavailable");
    return;
  }
  if (session.isStreaming === true || session.isCompacting === true) {
    failResult(requestId, "busy");
    return;
  }
  // The journal owner: the session's own id (not the provider-facing one) and
  // the leaf the request branches from.
  const manager = ctx.sessionManager;
  const sessionId = managerString(manager, "getSessionId");
  if (sessionId === null) {
    failResult(requestId, "unavailable");
    return;
  }
  const leafId = managerString(manager, "getLeafId");
  const owner = { sessionId, parentId: leafId };

  // Supersede any earlier in-flight request: the new ack replaces its result
  // rather than re-publishing the old correlation.
  if (inflight !== null) {
    clearDeadline(inflight);
    inflight.controller.abort();
    inflight = null;
    result = null;
  }
  const controller = new AbortController();
  const entry: Inflight = {
    requestId,
    controller,
    timedOut: false,
    timer: null as unknown as PollTimer,
    journaled: new Set<string>(),
  };
  entry.timer = setTimeout(() => {
    if (inflight !== entry) return;
    entry.timedOut = true;
    inflight = null;
    controller.abort();
    failResult(requestId, "failed");
  }, DEADLINE_MS) as unknown as PollTimer;
  inflight = entry;
  // The ack goes out immediately; the result rides the publish when it lands.
  publish();

  const alternatives = alternativesSetting();
  void run
    .call(ctx, {
      promptText: alternatives ? PREDICT_PROMPT_CHOICES : PREDICT_PROMPT_SINGLE,
      maxTokens:
        typeof session.ephemeralMaxTokensPreservesRequest === "function" &&
        session.ephemeralMaxTokensPreservesRequest() === true
          ? PREDICTION_MAX_TOKENS
          : undefined,
      minimizeEffort: true,
      signal: controller.signal,
      onUsage: (message: UsageMessage) => journalUsage(manager, owner, message, entry.journaled),
    })
    .then((outcome) => {
      if (inflight !== entry) return;
      inflight = null;
      clearDeadline(entry);
      // Staleness, upstream's #isCurrent: a new message moved the leaf, the
      // session changed underneath, or a turn is streaming again. The leaf is
      // read with this request's own journal entries excluded — its journaled
      // usage is bookkeeping, not a new message.
      if (
        managerString(manager, "getSessionId") !== sessionId ||
        leafExcludingOwnJournal(manager, entry.journaled) !== leafId ||
        session.isStreaming === true
      ) {
        failResult(requestId, "stale");
        return;
      }
      const replyText = outcome === null || typeof outcome !== "object" ? undefined : outcome.replyText;
      if (typeof replyText !== "string") {
        failResult(requestId, "skipped");
        return;
      }
      const choices = alternatives ? parseChoicesReply(replyText, MAX_CHOICES) : parseSingleReply(replyText);
      if (choices === undefined) {
        failResult(requestId, "skipped");
        return;
      }
      result = { requestId, ok: true, choices };
      publish();
    })
    .catch(() => {
      if (inflight !== entry) return;
      inflight = null;
      clearDeadline(entry);
      // An abort from a new turn arrives here too; the agent_start handler has
      // already retired the request as stale. Anything else is a failed ask.
      failResult(requestId, entry.timedOut ? "failed" : controller.signal.aborted ? "stale" : "failed");
    });
}

export default function (pi: ExtensionApi) {
  try {
    const prototype = pi.pi?.AgentSession?.prototype;
    const originalPrompt = prototype?.prompt;
    if (prototype && typeof originalPrompt === "function") {
      const call = originalPrompt as (this: PredictionSession, ...a: unknown[]) => unknown;
      prototype.prompt = function (this: PredictionSession, ...args: unknown[]): unknown {
        captureRoot(this);
        return call.apply(this, args);
      };
    }
  } catch {
    /* an unhookable session publishes no-session; it never breaks the agent */
  }

  // A new turn supersedes any in-flight prediction, exactly as upstream's
  // event controller cancels at run start.
  if (typeof pi.on === "function") {
    try {
      pi.on("agent_start", () => cancelInflight("stale"));
    } catch {
      /* a runner without event hooks just keeps the deadline as its backstop */
    }
  }

  pi.registerCommand(COMMAND, {
    description: "omp-ui composer predictions",
    handler: (args: string, ctx: PredictionContext) => {
      ui = ctx.ui;
      if (typeof ctx.runEphemeralTurn !== "function") sideTurnsMissing = true;
      const trimmed = typeof args === "string" ? args.trim() : "";
      if (trimmed === "") {
        publish();
        return;
      }
      if (!trimmed.startsWith(REQUEST_PREFIX)) throw new Error(COMMAND + ": unsupported command args");
      const request = parseRequest(trimmed.slice(REQUEST_PREFIX.length));
      if (request === null) throw new Error(COMMAND + ": malformed prediction request");
      startPrediction(ctx, request.requestId);
    },
  });
}
`;
}

/**
 * Writes the composer-predictions bridge into the lineage dir and returns its
 * path, to be passed to omp as `-e`. Rewritten on every spawn so a stale copy
 * from an older omp-ui build can never outvote the current wire contract.
 */
export function writeComposerPredictionsExtension(lineageDir: string): string {
  return writeLineageArtifact(lineageDir, composerPredictionsExtensionPath(lineageDir), extensionSource());
}
