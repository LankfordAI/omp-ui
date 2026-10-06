import * as path from "node:path";
import {
  HOST_NOTIFY_TOOL_NAME,
  HOST_URI_SCHEME,
  hostToolErrorResult,
  hostToolTextResult,
  hostToolResult,
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
  obsidianIdFor,
  scanSecrets,
  validateVaultRoot,
  vaultAppend,
  vaultCreate,
  vaultEdit,
  vaultLink,
  vaultList,
  vaultRead,
  vaultSearch,
  VAULT_WRITE_TOOLS,
  type ObsidianListEntry,
  type RootGuard,
  type VaultAction,
  type VaultCallContext,
  type VaultOutcome,
  type VaultRegistry,
  type VaultRegistryEntry,
  type VaultToolDetails,
  type HostUriContentType,
  type RpcFrame,
} from "@omp-ui/core";
import type { ConfinedPlanRead } from "./plan-file";

/**
 * omp 18.6.1 has no host-tool timer of its own: a request settles on a result,
 * abort, or stdin EOF. This watchdog is the UI's 60-second bound on a stuck
 * answerer. The pending map makes the watchdog and real answer exclusive.
 */
export const HOST_ANSWER_WATCHDOG_MS = 60_000;

/** Cap on remembered answered ids per tab (FIFO). The set fences the renderer's fallback stub out of double-answering; the cap keeps a long-lived process from growing it without bound. */
const ANSWERED_ID_CAP = 512;

export interface VaultTabContext {
  projectName: string | null;
  projectFolder: string;
  pinnedVault: string | null;
  lineage: string;
}

export interface VaultBridgeDeps {
  context(tabId: string): VaultTabContext | null;
  registry(): VaultRegistry;
  guard(): RootGuard;
  obsidianList(): Promise<ObsidianListEntry[]>;
  appVersion: string;
  now(): Date;
  mainLog(line: string): void;
}

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
  vault?: VaultBridgeDeps;
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
  private readonly vaultTokens = new Map<string, Map<string, string>>();
  private readonly vaultWrites = new Map<string, number>();
  private readonly vaultCalls = new Map<string, Partial<Record<VaultAction, number>>>();

  constructor(private readonly deps: HostBridgeDeps) {}

  /** Captures per-tab answer context from a frame BEFORE it is delivered or claimed. */
  noteFrame(tabId: string, frame: RpcFrame): void {
    if (frame.type === "turn_start") this.vaultWrites.delete(tabId);
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
    this.vaultTokens.delete(tabId);
    this.vaultWrites.delete(tabId);
    this.vaultCalls.delete(tabId);
  }

  /** The ids already answered on this tab — the renderer fence's source. */
  answeredIds(tabId: string): ReadonlySet<string> {
    return this.answered.get(tabId) ?? new Set();
  }

  /** The last plan path observed for the tab; null when the tab never proposed one. */
  planPath(tabId: string): string | null {
    return this.planPaths.get(tabId) ?? null;
  }

  /** Detached lifetime action counts, safe for diagnostics consumers to mutate. */
  vaultCallCounts(): Record<string, Partial<Record<VaultAction, number>>> {
    return Object.fromEntries(Array.from(this.vaultCalls, ([tabId, counts]) => [tabId, { ...counts }]));
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
    if (call.toolName.startsWith("omp-ui_vault_")) {
      const action = vaultAction(call.toolName);
      if (action === null) {
        this.answer(call.id, hostToolErrorResult(call.id, `unknown host tool "${call.toolName}"`), send);
        return;
      }
      await this.answerVault(tabId, call, action, send);
      return;
    }
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

  private async answerVault(
    tabId: string,
    call: { id: string; toolName: string; args: unknown },
    action: VaultAction,
    send: (frame: RpcFrame) => void,
  ): Promise<void> {
    let counts = this.vaultCalls.get(tabId);
    if (counts === undefined) {
      counts = {};
      this.vaultCalls.set(tabId, counts);
    }
    counts[action] = (counts[action] ?? 0) + 1;
    let tokens = this.vaultTokens.get(tabId);
    if (tokens === undefined) {
      tokens = new Map();
      this.vaultTokens.set(tabId, tokens);
    }
    const pending = this.pending.get(call.id);
    const retained = (): boolean => pending !== undefined && this.pending.get(call.id) === pending &&
      this.vaultCalls.get(tabId) === counts && this.vaultTokens.get(tabId) === tokens;
    const deps = this.deps.vault;
    const isWrite = VAULT_WRITE_TOOLS.some((name) => name === call.toolName);
    let selectedName = isArgumentRecord(call.args) && typeof call.args.vault === "string" ? call.args.vault : "(unselected)";
    let entry: VaultRegistryEntry | undefined;
    let rel: string | null = null;
    let obsidianId: string | null = null;
    const refusal = (reason: string): void => {
      if (!retained()) return;
      const details: VaultToolDetails | undefined = entry === undefined ? undefined : {
        vaultName: entry.name, vaultId: obsidianId, path: rel, action, createdByOmpUi: null,
      };
      const text = entry === undefined ? reason : `Vault ${entry.name}${rel === null ? "" : ` · ${rel}`}\n\n${reason}`;
      if (isWrite) deps?.mainLog(vaultLog(selectedName, action, `refused: ${reason}`));
      this.answer(call.id, hostToolResult(call.id, [{ type: "text", text }], details === undefined ? {} : { ...details }, true), send);
    };
    if (deps === undefined) {
      refusal("the knowledge vault is not available in this session");
      return;
    }
    const parsed = parseVaultArguments(call.toolName, action, call.args);
    if (!parsed.ok) {
      refusal(parsed.reason);
      return;
    }
    const args = parsed.args;
    try {
      const context = deps.context(tabId);
      if (context === null) {
        refusal("this session's record is gone");
        return;
      }
      const tabContext = { ...context };
      const currentRegistry = deps.registry();
      const registry = { vaults: currentRegistry.vaults.map((row) => ({ ...row })), defaultWriteVault: currentRegistry.defaultWriteVault };
      if (registry.vaults.length === 0) {
        refusal("no vault is registered; add one in Settings, Knowledge vault");
        return;
      }
      const selected = args.vault ?? tabContext.pinnedVault ?? registry.defaultWriteVault;
      selectedName = selected ?? "(unselected)";
      entry = registry.vaults.find((row) => row.name === selected);
      if (entry === undefined) {
        const registered = registry.vaults.map((row) => row.name).join(", ");
        refusal(args.vault === undefined && tabContext.pinnedVault !== null
          ? `this project's knowledge home names vault "${selected}", which is no longer registered; registered: ${registered}`
          : `unknown vault "${selected}"; registered: ${registered}`);
        return;
      }
      const guard = { ...deps.guard() };
      const root = await validateVaultRoot(entry.path, guard);
      if (!retained()) return;
      if (!root.ok) {
        refusal(root.code === "unreachable"
          ? `vault ${entry.name} is unreachable at its registered folder; check that the drive is mounted`
          : root.reason.replace(/^omp-ui cannot use [\s\S]* as a vault: /, "omp-ui cannot use this vault: "));
        return;
      }
      if (isWrite) {
        const writes = this.vaultWrites.get(tabId) ?? 0;
        if (writes >= 25) {
          refusal("vault write limit reached for this turn (25); continue in the next turn");
          return;
        }
        // Reserve before the token gate and without yielding. Refusals after
        // this point consume one slot; concurrent calls cannot overbook it.
        this.vaultWrites.set(tabId, writes + 1);
      }
      if (args.action === "edit" || args.action === "link") {
        const source = normalizeTokenPath(args.path);
        if (!source.ok) {
          refusal(source.reason);
          return;
        }
        rel = source.rel;
        const latest = tokens.get(`${entry.name}\0${rel}`);
        if (args.baseHash === undefined || latest === undefined) {
          refusal(`read ${rel} first; omp-ui_vault_edit needs the baseHash from your latest omp-ui_vault_read of that path`);
          return;
        }
        if (args.baseHash !== latest) {
          refusal(`baseHash is not from your latest read of ${rel}; read it again`);
          return;
        }
      } else if ("path" in args) {
        const source = normalizeTokenPath(args.path);
        if (source.ok) rel = source.rel;
      } else if (args.action === "list") {
        const folder = args.folder ?? entry.homeFolder;
        if (!/^[/\\]|^[A-Za-z]:/.test(folder) && folder.split(/[/\\]+/).every((segment) => !segment.startsWith("."))) {
          rel = folder.split(/[/\\]+/).filter(Boolean).join("/");
        }
      }
      const list = await deps.obsidianList();
      if (!retained()) return;
      obsidianId = obsidianIdFor(root.real, list);
      const withoutProject = args.action === "create" && args.project === false;
      const ctx: VaultCallContext = {
        entry, obsidianId, projectFolder: withoutProject ? null : tabContext.projectFolder,
        projectName: withoutProject ? null : tabContext.projectName, lineage: tabContext.lineage,
        appVersion: deps.appVersion, now: () => deps.now(), guard,
      };
      // All awaited setup is complete. Cancellation here must not start I/O.
      if (!retained()) return;
      const outcome = await dispatchVault(ctx, args);
      if (!retained()) return;
      if (outcome.ok && outcome.details.baseHash !== undefined && outcome.details.path !== null &&
          (action === "read" || isWrite)) {
        tokens.set(`${entry.name}\0${outcome.details.path}`, outcome.details.baseHash);
      }
      if (isWrite) {
        deps.mainLog(vaultLog(entry.name, action, outcome.ok
          ? outcome.details.path ?? "(unknown path)"
          : `refused: ${vaultRefusalReason(outcome.text)}`));
      }
      const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
        { type: "text", text: outcome.text },
      ];
      if (outcome.image !== undefined) content.push({ type: "image", ...outcome.image });
      this.answer(call.id, hostToolResult(call.id, content, { ...outcome.details }, !outcome.ok), send);
    } catch (error) {
      refusal(`omp-ui could not complete the vault call (${vaultExceptionReason(error, rel)})`);
    }
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

type VaultArguments = { vault?: string } & (
  | { action: "search"; query: string; limit?: number }
  | { action: "read"; path: string }
  | { action: "list"; folder?: string }
  | { action: "create"; title: string; body: string; tags?: string[]; project?: boolean }
  | { action: "append"; path: string; text: string }
  | { action: "edit"; path: string; content: string; baseHash?: string }
  | { action: "link"; path: string; to: string; baseHash?: string }
);

function vaultAction(name: string): VaultAction | null {
  switch (name) {
    case "omp-ui_vault_search": return "search";
    case "omp-ui_vault_read": return "read";
    case "omp-ui_vault_list": return "list";
    case "omp-ui_vault_create": return "create";
    case "omp-ui_vault_append": return "append";
    case "omp-ui_vault_edit": return "edit";
    case "omp-ui_vault_link": return "link";
    default: return null;
  }
}

function isArgumentRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function parseVaultArguments(tool: string, action: VaultAction, raw: unknown):
  { ok: true; args: VaultArguments } | { ok: false; reason: string } {
  const fail = (field: string, type: string): { ok: false; reason: string } => ({
    ok: false, reason: `${tool} requires ${field} (${type})`,
  });
  if (!isArgumentRecord(raw)) return fail("arguments", "object");
  const vault = raw.vault;
  if ("vault" in raw && typeof vault !== "string") return fail("vault", "string");
  const chosen = typeof vault === "string" ? { vault } : {};
  if (action === "search") {
    const query = raw.query;
    const limit = raw.limit;
    if (typeof query !== "string" || query.trim() === "") return fail("query", "non-empty string");
    if ("limit" in raw && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 50)) {
      return fail("limit", "integer 1..50");
    }
    return { ok: true, args: { action, ...chosen, query, ...(typeof limit === "number" ? { limit } : {}) } };
  }
  if (action === "list") {
    const folder = raw.folder;
    if ("folder" in raw && typeof folder !== "string") return fail("folder", "string");
    return { ok: true, args: { action, ...chosen, ...(typeof folder === "string" ? { folder } : {}) } };
  }
  if (action === "create") {
    const title = raw.title;
    const body = raw.body;
    let tags: string[] | undefined;
    const project = raw.project;
    if (typeof title !== "string" || title.trim() === "") return fail("title", "non-empty string");
    if (typeof body !== "string") return fail("body", "string");
    if ("tags" in raw) {
      if (!isStringArray(raw.tags)) return fail("tags", "string array");
      tags = raw.tags;
    }
    if ("project" in raw && typeof project !== "boolean") return fail("project", "boolean");
    return { ok: true, args: { action, ...chosen, title, body,
      ...(tags === undefined ? {} : { tags }),
      ...(typeof project === "boolean" ? { project } : {}),
    } };
  }
  const sourcePath = raw.path;
  if (typeof sourcePath !== "string" || sourcePath.trim() === "") return fail("path", "non-empty string");
  if (action === "read") return { ok: true, args: { action, ...chosen, path: sourcePath } };
  if (action === "append") {
    const text = raw.text;
    if (typeof text !== "string") return fail("text", "string");
    return { ok: true, args: { action, ...chosen, path: sourcePath, text } };
  }
  const baseHash = raw.baseHash;
  if ("baseHash" in raw && typeof baseHash !== "string") return fail("baseHash", "string");
  const hash = typeof baseHash === "string" ? { baseHash } : {};
  if (action === "edit") {
    const content = raw.content;
    if (typeof content !== "string") return fail("content", "string");
    return { ok: true, args: { action, ...chosen, ...hash, path: sourcePath, content } };
  }
  const to = raw.to;
  if (typeof to !== "string" || to.trim() === "") return fail("to", "non-empty string");
  return { ok: true, args: { action, ...chosen, ...hash, path: sourcePath, to } };
}

function normalizeTokenPath(value: string): { ok: true; rel: string } | { ok: false; reason: string } {
  value = value.trim();
  if (/^[/\\]/.test(value) || /^[A-Za-z]:/.test(value)) return { ok: false, reason: "absolute paths are refused" };
  const segments = value.split(/[/\\]+/).filter((segment) => segment !== "");
  if (segments.length === 0) return { ok: false, reason: "empty path" };
  if (segments.some((segment) => segment === "..")) return { ok: false, reason: '".." segments are refused' };
  if (segments.some((segment) => segment.startsWith("."))) return { ok: false, reason: 'hidden segments (starting with ".") are refused' };
  const rel = segments.join("/");
  return { ok: true, rel: path.posix.extname(rel) === "" ? `${rel}.md` : rel };
}

function dispatchVault(ctx: VaultCallContext, args: VaultArguments): Promise<VaultOutcome> {
  switch (args.action) {
    case "search": return vaultSearch(ctx, args.query, args.limit);
    case "read": return vaultRead(ctx, args.path);
    case "list": return vaultList(ctx, args.folder);
    case "create": return vaultCreate(ctx, { title: args.title, body: args.body, ...(args.tags === undefined ? {} : { tags: args.tags }) });
    case "append": return vaultAppend(ctx, args.path, args.text);
    // The caller has already checked presence and latest-read authorization.
    case "edit": return vaultEdit(ctx, args.path, args.content, args.baseHash!);
    case "link": return vaultLink(ctx, args.path, args.to, args.baseHash!);
  }
}

function vaultRefusalReason(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.startsWith("Vault ")) lines.shift();
  return lines.filter((line) => line.trim() !== "").join("; ");
}

function vaultLog(name: string, action: VaultAction, message: string): string {
  const line = `[vault] ${name} ${action} ${message}`.replace(/\r/g, "\\r").replace(/\n/g, "\\n");
  return scanSecrets(line) === null ? line : `[vault] (redacted) ${action} refused: secret-shaped metadata`;
}

function vaultExceptionReason(error: unknown, rel: string | null): string {
  if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string" && /^E[A-Z0-9]+$/.test(error.code)) {
    return `${error.code}${rel === null ? "" : `: ${rel}`}`;
  }
  // Unexpected dependency errors can contain arguments or arbitrary note
  // bytes. Never forward their message or retain unknown argument fields.
  return "unexpected error";
}
