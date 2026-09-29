import {
  HOST_NOTIFY_TOOL_NAME,
  HOST_URI_SCHEME,
  hostToolErrorResult,
  hostToolTextResult,
  hostUriErrorResult,
  hostUriReadResult,
  normalizeControlFrame,
  parseHostToolCall,
  parseHostToolCancel,
  parseHostUriCancel,
  parseHostUriRequest,
  parseHostUrl,
  parsePlanReviewTitle,
  parsePlanStatus,
  PLAN_STATUS_KEY,
  type HostUriContentType,
  type RpcFrame,
} from "@omp-ui/core";
import type { ConfinedPlanRead } from "./plan-file";

/**
 * How long one host request may stay unanswered before the bridge answers a
 * generic error itself. omp's host-tool timeout defaults to 120s; halving it
 * guarantees the agent never sits past its own deadline waiting on a stuck
 * answerer. omp ignores a result for an id it has abandoned, so a watchdog
 * answer racing a real one is harmless — the pending map makes the pair
 * mutually exclusive regardless.
 */
export const HOST_ANSWER_WATCHDOG_MS = 60_000;

/** Cap on remembered answered ids per tab (FIFO). The set fences the renderer's fallback stub out of double-answering; the cap keeps a long-lived process from growing it without bound. */
const ANSWERED_ID_CAP = 512;

export interface HostBridgeDeps {
  /** Confined read of one plan artifact under the tab's lineage root. */
  readPlanFile: (root: string, absPath: string) => Promise<ConfinedPlanRead>;
  /** The validated snapshot while an HTML gate holds the plan (§5.4); null when no snapshot is held. */
  planSnapshot: (tabId: string, absPath: string) => { text: string; sourceHash: string } | null;
  /** The lineage confinement root for one tab; null when its record is gone. */
  planRoot: (tabId: string) => string | null;
  /** Posts one OS notification; returns the text the tool result reports back to the model. */
  notify: (tabId: string, title: string | null, message: string) => string;
  /** The tab's last capability-roster session id; null while no roster was published. */
  capabilitySessionId: (tabId: string) => string | null;
  log: (message: string) => void;
}

interface PendingHostAnswer {
  tabId: string;
  timer: NodeJS.Timeout;
  /** Builds the kind's error result: a watchdog answer must pass omp's matching result guard. */
  buildError: (message: string) => RpcFrame;
}

/**
 * The main-process answerer for host frames (issue #688, ADR-0043). omp
 * routes `host_tool_call` / `host_uri_request` frames to the RPC client's
 * stdin reader, so whoever owns that process — main, never the renderer —
 * must answer each request exactly once. The bridge keeps the per-tab
 * answer bookkeeping: the pending map with its watchdog, the answered-id
 * set that fences the renderer's fallback stub, and the last observed plan
 * path `omp-ui://plan` resolves against.
 */
export class HostBridge {
  private readonly pending = new Map<string, PendingHostAnswer>();
  private readonly answered = new Map<string, Set<string>>();
  private readonly answeredOrder = new Map<string, string[]>();
  /** The plan path the tab last proposed, captured from its frames; absent until one does. */
  private readonly planPaths = new Map<string, string>();

  constructor(private readonly deps: HostBridgeDeps) {}

  /** Captures per-tab answer context from a frame BEFORE it is delivered or claimed. */
  noteFrame(tabId: string, frame: RpcFrame): void {
    if (frame.type === "response" && typeof frame.id === "string") {
      // A rejected registration means the model never sees the tool/scheme —
      // surface it once per spawn instead of letting the silence read as
      // success (the commands ride initialCommands, so this lands early).
      if (
        (frame.id === "omp-ui-host-tools-1" || frame.id === "omp-ui-host-uri-1") &&
        frame.success === false
      ) {
        this.deps.log(
          `host registration "${frame.id}" rejected: ${
            typeof frame.error === "string" ? frame.error : "unknown error"
          }`,
        );
      }
      return;
    }
    if (frame.type === "session_info_update" || frame.type === "config_update") {
      // The live session changed identity in place (`/new`, `/switch`,
      // `/branch`): the plan this tab proposed belongs to the predecessor,
      // exactly the roster-retirement rule of issue #374 — same frames, same
      // comparison, so the two can never disagree about what "changed" means.
      const observed = typeof frame.sessionId === "string" ? frame.sessionId : null;
      const retained = this.deps.capabilitySessionId(tabId);
      if (observed !== null && retained !== null && retained !== observed) {
        this.planPaths.delete(tabId);
      }
      return;
    }
    const control = normalizeControlFrame(frame);
    if (control === null || control.kind !== "ext_request") return;
    if (control.method === "setStatus" && control.frame.statusKey === PLAN_STATUS_KEY) {
      // The arm's status publish carries the CURRENT plan path — the capture
      // that survives hibernate/resume, where no review frame replays.
      const status = parsePlanStatus(
        typeof control.frame.statusText === "string" ? control.frame.statusText : undefined,
      );
      if (status !== null && status.planAbsPath !== null) this.planPaths.set(tabId, status.planAbsPath);
      return;
    }
    if (control.method !== "select") return;
    const title = control.frame.title;
    if (typeof title !== "string") return;
    const review = parsePlanReviewTitle(title);
    if (review === null || review.planAbsPath === null) return;
    this.planPaths.set(tabId, review.planAbsPath);
  }

  /** Drops every trace of one tab (exit, hibernate, delete). Pending answers are abandoned, never sent: the pipe is already gone. */
  forget(tabId: string): void {
    for (const [id, answer] of this.pending) {
      if (answer.tabId !== tabId) continue;
      clearTimeout(answer.timer);
      this.pending.delete(id);
    }
    this.answered.delete(tabId);
    this.answeredOrder.delete(tabId);
    this.planPaths.delete(tabId);
  }

  /** The ids already answered on this tab — the renderer fence's source. */
  answeredIds(tabId: string): ReadonlySet<string> {
    return this.answered.get(tabId) ?? new Set();
  }

  /** The last plan path observed for the tab; null when the tab never proposed one. */
  planPath(tabId: string): string | null {
    return this.planPaths.get(tabId) ?? null;
  }

  /**
   * Routes one inbound frame. Returns true when it was host traffic; every
   * branch answers, settles, or deliberately ignores exactly once. `send`
   * writes to THIS process's stdin — never the generic rpcSend seam, which
   * carries the renderer fence this bridge feeds.
   */
  route(tabId: string, frame: RpcFrame, send: (frame: RpcFrame) => void): boolean {
    const toolCall = parseHostToolCall(frame);
    if (toolCall !== null) {
      this.track(tabId, toolCall.id, send, (message) => hostToolErrorResult(toolCall.id, message));
      void this.answerTool(tabId, toolCall, send);
      return true;
    }
    const uriRequest = parseHostUriRequest(frame);
    if (uriRequest !== null) {
      this.track(tabId, uriRequest.id, send, (message) => hostUriErrorResult(uriRequest.id, message));
      void this.answerUri(tabId, uriRequest, send);
      return true;
    }
    const cancelId = parseHostToolCancel(frame) ?? parseHostUriCancel(frame);
    if (cancelId !== null) {
      this.settle(cancelId);
      return true;
    }
    return false;
  }

  /**
   * Marks the request main-owned and arms its watchdog. The ownership mark
   * is SYNCHRONOUS and precedes any await: the renderer's fallback stub
   * answers the instant the frame reaches it, so the rpcSend fence must see
   * the id before the stub's send can arrive — never only after main's real
   * (possibly file-reading) answer lands.
   */
  private track(
    tabId: string,
    id: string,
    send: (frame: RpcFrame) => void,
    buildError: (message: string) => RpcFrame,
  ): void {
    this.rememberAnswered(tabId, id);
    const timer = setTimeout(() => {
      this.pending.delete(id);
      // The watchdog answers on the SAME send seam as every real answer, so
      // "exactly one result" holds even when a real answerer is stuck.
      send(buildError("omp-ui could not answer this request in time"));
    }, HOST_ANSWER_WATCHDOG_MS);
    timer.unref();
    this.pending.set(id, { tabId, timer, buildError });
  }

  /** Settles a pending request with its answer frame — once, by construction: the map entry is gone first, and only the taker reaches it. */
  private answer(id: string, frame: RpcFrame, send: (frame: RpcFrame) => void): void {
    const answer = this.pending.get(id);
    if (answer === undefined) return;
    clearTimeout(answer.timer);
    this.pending.delete(id);
    send(frame);
  }

  private settle(id: string): void {
    const answer = this.pending.get(id);
    if (answer === undefined) return;
    clearTimeout(answer.timer);
    this.pending.delete(id);
    // A cancelled request is NOT answered — omp already stopped waiting.
    // The ownership mark from `track` still fences the renderer stub out.
  }

  private rememberAnswered(tabId: string, id: string): void {
    let ids = this.answered.get(tabId);
    if (ids === undefined) {
      ids = new Set();
      this.answered.set(tabId, ids);
      this.answeredOrder.set(tabId, []);
    }
    if (ids.has(id)) return;
    ids.add(id);
    const order = this.answeredOrder.get(tabId);
    if (order === undefined) return; // unreachable: every set has its order list
    order.push(id);
    while (order.length > ANSWERED_ID_CAP) {
      const oldest = order.shift();
      if (oldest !== undefined) ids.delete(oldest);
    }
  }

  private async answerTool(
    tabId: string,
    call: { id: string; toolName: string; args: unknown },
    send: (frame: RpcFrame) => void,
  ): Promise<void> {
    if (call.toolName !== HOST_NOTIFY_TOOL_NAME) {
      this.answer(call.id, hostToolErrorResult(call.id, `unknown host tool "${call.toolName}"`), send);
      return;
    }
    const record: Record<string, unknown> =
      call.args !== null && typeof call.args === "object" ? (call.args as Record<string, unknown>) : {};
    const message = typeof record.message === "string" ? record.message : "";
    if (message.trim() === "") {
      this.answer(call.id, hostToolErrorResult(call.id, "notify requires a non-empty message"), send);
      return;
    }
    const title = typeof record.title === "string" && record.title.trim() !== "" ? record.title : null;
    let text: string;
    try {
      text = this.deps.notify(tabId, title, message);
    } catch (error) {
      this.deps.log(`host notify failed: ${String(error)}`);
      this.answer(call.id, hostToolErrorResult(call.id, "omp-ui could not post the notification"), send);
      return;
    }
    this.answer(call.id, hostToolTextResult(call.id, text), send);
  }

  private async answerUri(
    tabId: string,
    request: { id: string; operation: "read" | "write"; url: string },
    send: (frame: RpcFrame) => void,
  ): Promise<void> {
    if (request.operation === "write") {
      this.answer(
        request.id,
        hostUriErrorResult(request.id, `the ${HOST_URI_SCHEME}:// scheme is read-only`),
        send,
      );
      return;
    }
    const parsed = parseHostUrl(request.url);
    if (parsed === null || parsed.scheme !== HOST_URI_SCHEME) {
      const scheme = parsed !== null ? parsed.scheme : request.url;
      this.answer(
        request.id,
        hostUriErrorResult(request.id, `omp-ui registers no scheme "${scheme}://"`),
        send,
      );
      return;
    }
    if (parsed.resource !== "plan") {
      this.answer(
        request.id,
        hostUriErrorResult(
          request.id,
          `unknown ${HOST_URI_SCHEME} resource "${parsed.resource}"; available: plan`,
        ),
        send,
      );
      return;
    }
    const absPath = this.planPaths.get(tabId);
    if (absPath === undefined) {
      this.answer(
        request.id,
        hostUriErrorResult(request.id, "no plan has been proposed for this session yet"),
        send,
      );
      return;
    }
    // While an HTML gate holds the plan, the VALIDATED bytes answer — the
    // same §5.4 rule the review pane follows, so model and user read one doc.
    const snapshot = this.deps.planSnapshot(tabId, absPath);
    if (snapshot !== null) {
      this.answer(request.id, hostUriReadResult(request.id, snapshot.text, planContentType(absPath)), send);
      return;
    }
    const root = this.deps.planRoot(tabId);
    if (root === null) {
      this.answer(
        request.id,
        hostUriErrorResult(request.id, "the plan file could not be read (unreadable)"),
        send,
      );
      return;
    }
    const read = await this.deps.readPlanFile(root, absPath);
    if (!read.ok) {
      this.answer(
        request.id,
        hostUriErrorResult(request.id, `the plan file could not be read (${read.reason})`),
        send,
      );
      return;
    }
    this.answer(request.id, hostUriReadResult(request.id, read.text, planContentType(absPath)), send);
  }
}

/** The plan's content type follows its file extension. HTML plans serve as markdown here: omp's InternalResource contentType has no html member (verified against omp 18.4.3), and the document's own markup rides through as text. */
function planContentType(absPath: string): HostUriContentType {
  const ext = absPath.slice(absPath.lastIndexOf(".")).toLowerCase();
  return ext === ".json" ? "application/json" : "text/markdown";
}
