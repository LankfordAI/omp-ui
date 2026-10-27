import * as path from "node:path";
import {
  fleetMachineName,
  fleetToolDispatchRequest,
  formatFleetMachines,
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
  parseFleetToolArguments,
  fleetChoiceText,
  parseHostUrl,
  parseDayParam,
  parsePlanReviewTitle,
  parsePlanStatus,
  PLAN_STATUS_KEY,
  renderDayIndex,
  renderSessionSummary,
  obsidianIdFor,
  scanSecrets,
  validateVaultRoot,
  vaultAppend,
  vaultCreate,
  vaultDelete,
  vaultEdit,
  vaultLink,
  vaultList,
  vaultRead,
  vaultRefactor,
  vaultRename,
  vaultSearch,
  VAULT_WRITE_TOOLS,
  type FleetAgentUpdateAnswer,
  type FleetDispatchRequest,
  type FleetDispatchResult,
  type FleetDetachedExecStartOutcome,
  type FleetExecOutcome,
  type FleetExecPollOutcome,
  type FleetProjectManageOutcome,
  type FleetToolExecArgs,
  type FleetToolExecPollArgs,
  type FleetToolProjectArgs,
  type FleetToolUpdateArgs,
  type FleetMachine,
  type ObsidianListEntry,
  type RootGuard,
  type VaultAction,
  type VaultCallContext,
  type VaultOutcome,
  type VaultRegistry,
  type VaultProjectIdentity,
  type VaultRegistryEntry,
  type VaultToolDetails,
  type SessionsResourceDeps,
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
  project: VaultProjectIdentity;
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

/** The tab-side fleet answerers (issues #899, #901, #905; ADR-0061/0062/0065); SessionManager maps them onto the FleetDispatcher. */
export interface FleetBridgeDeps {
  machines(): Promise<FleetMachine[]>;
  /** Dispatches on behalf of the agent in `tabId`; the caller bounds it inside the answer watchdog. */
  dispatch(tabId: string, req: FleetDispatchRequest): Promise<FleetDispatchResult>;
  status(sel: { batchId: string } | { dispatchId: string }): Promise<string>;
  /** One bounded command on a member (issue #901); refusals ride the outcome. */
  exec(tabId: string, args: FleetToolExecArgs): Promise<FleetExecOutcome>;
  /** Rung-3 clone/register on a member (issue #901). */
  projectManage(tabId: string, args: FleetToolProjectArgs): Promise<FleetProjectManageOutcome>;
  /** Starts a detached exec on a member (issue #905); refusals ride the outcome. */
  execDetach(tabId: string, args: FleetToolExecArgs): Promise<FleetDetachedExecStartOutcome>;
  /** Polls, or cancels, one detached exec this app started (issue #905). */
  execPoll(tabId: string, args: FleetToolExecPollArgs): Promise<FleetExecPollOutcome>;
  /** Fleet maintenance on a member (fleet remote version update); refusals ride the answer. */
  update(tabId: string, args: FleetToolUpdateArgs): Promise<FleetAgentUpdateAnswer>;
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
  /** Owned-session records behind omp-ui://sessions; absent means the index is off. */
  sessions?: SessionsResourceDeps;
  /** The fleet tools' answerers; absent means the fleet tools answer as unavailable. */
  fleet?: FleetBridgeDeps;
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
 * path `omp-ui://plan` resolves against; `omp-ui://sessions` reads the
 * owned-session records through `deps.sessions`.
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
    if (call.toolName.startsWith("omp-ui_fleet_")) {
      await this.answerFleet(tabId, call, send);
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

  private async answerFleet(
    tabId: string,
    call: { id: string; toolName: string; args: unknown },
    send: (frame: RpcFrame) => void,
  ): Promise<void> {
    const pending = this.pending.get(call.id);
    const retained = (): boolean => pending !== undefined && this.pending.get(call.id) === pending;
    const reply = (frame: RpcFrame): void => {
      if (retained()) this.answer(call.id, frame, send);
    };
    const deps = this.deps.fleet;
    if (deps === undefined) {
      reply(hostToolErrorResult(call.id, "fleet tools are not available"));
      return;
    }
    const parsed = parseFleetToolArguments(call.toolName, call.args);
    if (!parsed.ok) {
      reply(hostToolErrorResult(call.id, parsed.reason));
      return;
    }
    try {
      if (parsed.tool === "machines") {
        const machines = await deps.machines();
        reply(hostToolTextResult(call.id, formatFleetMachines(machines)));
        return;
      }
      if (parsed.tool === "status") {
        const text = await deps.status(parsed.selector);
        reply(hostToolTextResult(call.id, text));
        return;
      }
      if (parsed.tool === "exec" && parsed.args.detach) {
        const outcome = await deps.execDetach(tabId, parsed.args);
        const machine = parsed.args.machine;
        // Never the command: it rides the owner's audit log.
        this.deps.log(
          `omp-ui_fleet_exec (detached) from ${tabId}: ${machine} ${outcome.status === "accepted" ? `execId=${outcome.execId}` : `refused (${outcome.reason})`}`,
        );
        if (outcome.status === "refused") {
          reply(hostToolTextResult(call.id, `refused — ${outcome.reason}`));
          return;
        }
        reply(
          hostToolTextResult(
            call.id,
            `detached exec started on ${machine}: execId ${outcome.execId}. Poll omp-ui_fleet_exec_poll with machine "${machine}" and execId "${outcome.execId}"; each poll waits up to 25 s. Do not start the command again.`,
          ),
        );
        return;
      }
      if (parsed.tool === "execPoll") {
        const outcome = await deps.execPoll(tabId, parsed.args);
        this.deps.log(
          `omp-ui_fleet_exec_poll from ${tabId}: ${parsed.args.machine} ${parsed.args.execId} ${outcome.status === "accepted" ? outcome.state : `refused (${outcome.reason})`}`,
        );
        if (outcome.status === "refused") {
          reply(hostToolTextResult(call.id, `refused — ${outcome.reason}`));
          return;
        }
        const s = Math.round(outcome.elapsedMs / 1000);
        const head =
          outcome.state === "running"
            ? `running (${s} s)`
            : outcome.state === "exited"
              ? `exit ${outcome.exitCode ?? "null"} after ${s} s`
              : outcome.state === "timed-out"
                ? `timed out after ${s} s`
                : outcome.state === "cancelled"
                  ? `cancelled after ${s} s`
                  : `revoked by the member's owner after ${s} s`;
        const body: string[] = [head];
        if (outcome.stdout !== "") body.push("", outcome.stdout);
        if (outcome.stderr !== "") body.push("", `stderr:\n${outcome.stderr}`);
        if (outcome.truncated) {
          body.push("", outcome.state === "running" ? "[earlier output not shown]" : "[truncated: earlier output dropped]");
        }
        reply(hostToolTextResult(call.id, body.join("\n")));
        return;
      }
      if (parsed.tool === "exec") {
        const outcome = await deps.exec(tabId, parsed.args);
        // The command text rides the owner's audit log; here only the machine,
        // status, and exit code.
        this.deps.log(
          `omp-ui_fleet_exec from ${tabId}: ${parsed.args.machine} ${outcome.status === "accepted" ? `exit=${outcome.exitCode ?? "null"}${outcome.timedOut ? " timed-out" : ""}` : `refused (${outcome.reason})`}`,
        );
        if (outcome.status === "refused") {
          // A refusal is an answer, not an error frame.
          reply(hostToolTextResult(call.id, `refused — ${outcome.reason}`));
          return;
        }
        const body: string[] = [outcome.timedOut ? "timed out" : `exit ${outcome.exitCode ?? "null"}`];
        if (outcome.stdout !== "") body.push("", outcome.stdout);
        if (outcome.stderr !== "") body.push("", `stderr:\n${outcome.stderr}`);
        if (outcome.truncated) body.push("", "[truncated]");
        reply(hostToolTextResult(call.id, body.join("\n")));
        return;
      }
      if (parsed.tool === "project") {
        const outcome = await deps.projectManage(tabId, parsed.args);
        this.deps.log(
          `omp-ui_fleet_project from ${tabId}: ${parsed.args.machine} ${parsed.args.verb} ${outcome.status}${outcome.status === "refused" ? ` (${outcome.reason})` : ""}`,
        );
        if (outcome.status === "refused") {
          reply(hostToolTextResult(call.id, `refused — ${outcome.reason}`));
          return;
        }
        reply(hostToolTextResult(call.id, `${parsed.args.verb} accepted: ${outcome.path}${outcome.headCommit === null ? "" : ` (HEAD ${outcome.headCommit})`}`));
        return;
      }
      if (parsed.tool === "update") {
        const answer = await deps.update(tabId, parsed.args);
        // Machine, target/action, and answer kind only — versions and refusal
        // reasons stay out of the log; they ride the tool answer.
        this.deps.log(
          `omp-ui_fleet_update from ${tabId}: ${parsed.args.machine} ${parsed.args.target}/${parsed.args.action} ${answer.kind}`,
        );
        reply(hostToolTextResult(call.id, fleetUpdateAnswerText(parsed.args.machine, answer)));
        return;
      }
      const machines = await deps.machines();
      if (!retained()) return;
      const translated = fleetToolDispatchRequest(parsed.args, machines);
      if (!translated.ok) {
        reply(hostToolErrorResult(call.id, translated.reason));
        return;
      }
      const result = await deps.dispatch(tabId, translated.request);
      // Ids and statuses only — the prompt never reaches the log.
      this.deps.log(
        `omp-ui_fleet_dispatch from ${tabId}: ${result.outcomes.map((o) => `${o.machineKey}=${o.status}`).join(", ") || "no targets"}`,
      );
      const lines = result.outcomes.map((o) => {
        const machine = machines.find((m) => m.key === o.machineKey);
        const name = machine === undefined ? o.machineKey : fleetMachineName(machine);
        const detail = o.status === "started" ? `tab ${o.tabId}${fleetChoiceText(o.choice)}` : o.message;
        return `- ${name}: ${o.status} (${detail}); dispatchId ${o.dispatchId}`;
      });
      const poll =
        result.batchId !== null
          ? `Poll omp-ui_fleet_status with batchId ${result.batchId}; do not dispatch again.`
          : "Poll omp-ui_fleet_status with the dispatchId; do not dispatch again.";
      reply(
        hostToolTextResult(
          call.id,
          [`Batch: ${result.batchId ?? "none (single dispatch)"}`, ...lines, "", poll].join("\n"),
        ),
      );
    } catch (error) {
      reply(hostToolErrorResult(call.id, `omp-ui could not complete the fleet call (${error instanceof Error ? error.message : String(error)})`));
    }
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
      // `entry` is a mutable local; TS cannot carry its narrowing into a
      // closure, so the token key prefix is captured once here.
      const vaultKey = `${entry.name}\0`;
      // Latest-read authorization, shared by every gated write (#757, #912-#914).
      const gate = (rawPath: string, baseHash: string | undefined): string | null => {
        const source = normalizeTokenPath(rawPath);
        if (!source.ok) return source.reason;
        const latest = tokens.get(`${vaultKey}${source.rel}`);
        if (baseHash === undefined || latest === undefined) {
          return `read ${source.rel} first; omp-ui_vault_${args.action} needs the baseHash from your latest omp-ui_vault_read of that path`;
        }
        if (baseHash !== latest) return `baseHash is not from your latest read of ${source.rel}; read it again`;
        return null;
      };
      if (args.action === "edit" || args.action === "link" || args.action === "rename" || args.action === "delete") {
        const source = normalizeTokenPath(args.path);
        if (!source.ok) {
          refusal(source.reason);
          return;
        }
        rel = source.rel;
        const gateReason = gate(args.path, args.baseHash);
        if (gateReason !== null) {
          refusal(gateReason);
          return;
        }
      } else if (args.action === "refactor") {
        const target = normalizeTokenPath(args.into);
        if (target.ok) rel = target.rel;
        // into gates when this session holds a token for it — the only
        // on-disk-free signal that it names an existing note — or when the
        // caller supplied a baseHash at all. A brand-new title has no token
        // and is created instead; core re-checks the disk either way.
        if (target.ok && (args.baseHash !== undefined || tokens.has(`${entry.name}\0${target.rel}`))) {
          const gateReason = gate(args.into, args.baseHash);
          if (gateReason !== null) {
            refusal(gateReason);
            return;
          }
        }
        for (const source of args.sources) {
          const gateReason = gate(source.path, source.baseHash);
          if (gateReason !== null) {
            refusal(gateReason);
            return;
          }
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
      const withoutProject = (args.action === "create" || args.action === "refactor") && args.project === false;
      const ctx: VaultCallContext = {
        entry, obsidianId, project: withoutProject ? null : tabContext.project,
        projectName: withoutProject ? null : tabContext.projectName, lineage: tabContext.lineage,
        appVersion: deps.appVersion, now: () => deps.now(), guard,
      };
      // All awaited setup is complete. Cancellation here must not start I/O.
      if (!retained()) return;
      const outcome = await dispatchVault(ctx, args);
      if (!retained()) return;
      if (outcome.ok) {
        // A renamed note's old-path token must not authorize a path that no
        // longer exists; deleted paths lose their tokens the same way.
        if (outcome.details.movedFrom !== undefined) tokens.delete(`${entry.name}\0${outcome.details.movedFrom}`);
        if (outcome.details.deletedPath !== undefined) tokens.delete(`${entry.name}\0${outcome.details.deletedPath}`);
        for (const deleted of outcome.details.deletedSources ?? []) tokens.delete(`${entry.name}\0${deleted}`);
      }
      if (outcome.ok && outcome.details.baseHash !== undefined && outcome.details.path !== null &&
          (action === "read" || isWrite)) {
        tokens.set(`${entry.name}\0${outcome.details.path}`, outcome.details.baseHash);
      }
      if (isWrite) {
        deps.mainLog(vaultLog(entry.name, action, outcome.ok
          ? outcome.details.path ?? "(unknown path)"
          : `refused: ${vaultRefusalReason(outcome.text)}`));
        const adopted = outcome.details.adopted;
        if (adopted !== undefined && adopted.length > 0) {
          deps.mainLog(vaultLog(entry.name, action, `adopted ${adopted.length} notes into ${path.posix.dirname(adopted[0]!)}`));
        }
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
    const queryAt = parsed.resource.indexOf("?");
    const resourcePath = queryAt === -1 ? parsed.resource : parsed.resource.slice(0, queryAt);
    const query = queryAt === -1 ? "" : parsed.resource.slice(queryAt + 1);
    if (resourcePath === "sessions" || SESSION_SUMMARY_RESOURCE.test(resourcePath)) {
      await this.answerSessions(request.id, resourcePath, query, send);
      return;
    }
    if (resourcePath !== "plan") {
      this.answer(
        request.id,
        hostUriErrorResult(
          request.id,
          `unknown ${HOST_URI_SCHEME} resource "${parsed.resource}"; available: plan, sessions`,
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

  private async answerSessions(
    id: string,
    resourcePath: string,
    query: string,
    send: (frame: RpcFrame) => void,
  ): Promise<void> {
    const sessions = this.deps.sessions;
    if (sessions === undefined) {
      this.answer(id, hostUriErrorResult(id, "the session index is not available in this session"), send);
      return;
    }
    const summary = SESSION_SUMMARY_RESOURCE.exec(resourcePath);
    if (summary === null) {
      const day = parseDayParam(new URLSearchParams(query).get("day"), sessions.now());
      if (!day.ok) {
        this.answer(id, hostUriErrorResult(id, day.error), send);
        return;
      }
      this.answer(
        id,
        hostUriReadResult(id, renderDayIndex(sessions.records(), sessions.projects(), day.day), "text/markdown"),
        send,
      );
      return;
    }
    const sessionId = summary[1] as string;
    const record = sessions.records().find((candidate) => candidate.sessionId === sessionId);
    if (record === undefined) {
      this.answer(id, hostUriErrorResult(id, `no omp-ui session has id "${sessionId}"`), send);
      return;
    }
    const text = await renderSessionSummary(record, sessions.projects(), (dir, sid) => sessions.locate(dir, sid));
    this.answer(id, hostUriReadResult(id, text, "text/markdown"), send);
  }
}

/** `omp-ui://sessions/<id>/summary`: one owned session's summary (#768). */
const SESSION_SUMMARY_RESOURCE = /^sessions\/([^/?#]+)\/summary$/;

/** The plan's content type follows its file extension. HTML plans serve as markdown here: omp's InternalResource contentType has no html member (verified against omp 18.4.3), and the document's own markup rides through as text. */
function planContentType(absPath: string): HostUriContentType {
  const ext = absPath.slice(absPath.lastIndexOf(".")).toLowerCase();
  return ext === ".json" ? "application/json" : "text/markdown";
}

/** Render one omp-ui_fleet_update answer (fleet remote version update, §8); pure render data from the dispatcher. */
function fleetUpdateAnswerText(machine: string, answer: FleetAgentUpdateAnswer): string {
  if (answer.kind === "refused") return `refused — ${answer.reason}`;
  if (answer.kind === "started") {
    return `maintenance job started on ${machine}: jobId ${answer.jobId}. Poll omp-ui_fleet_update with the same arguments; do not start it twice.`;
  }
  if (answer.kind === "applied") return answer.detail;
  if (answer.kind === "poll") {
    const progress = answer.progress;
    const head =
      answer.state === "running"
        ? progress === null
          ? "running"
          : `running (${progress.percent === null ? progress.phase : `${progress.phase} ${progress.percent}%`})`
        : answer.state === "succeeded"
          ? `succeeded${answer.detail === null ? "" : `: ${answer.detail}`}`
          : answer.state === "failed"
            ? `failed${answer.detail === null ? "" : `: ${answer.detail}`}`
            : "revoked by the member's owner";
    return head;
  }
  const check = answer.check;
  if (check.target === "omp") {
    const lines = [
      `omp on ${machine}:`,
      `- installed: ${check.installedVersion ?? "unknown"}${check.installPath === null ? "" : ` at ${check.installPath}`}`,
      `- latest: ${check.latestVersion ?? "unknown"}`,
      `- ${check.updateAvailable ? "update available" : "up to date"}`,
    ];
    if (check.pinned) lines.push("- pinned by OMP_UI_OMP_PATH on that machine");
    if (check.belowMinimum) lines.push("- below the minimum supported omp version");
    return lines.join("\n");
  }
  const lines = [
    `omp-ui on ${machine}:`,
    `- current: ${check.currentVersion ?? "unknown"}`,
    `- latest: ${check.latestVersion ?? "unknown"}`,
    `- package format: ${check.format ?? "unknown"}`,
    `- update staged: ${check.staged ? "yes" : "no"}${check.installOnQuit ? " (armed to apply at that machine's next quit)" : ""}`,
    `- live sessions: ${check.liveSessions}`,
  ];
  return lines.join("\n");
}

type VaultArguments = { vault?: string } & (
  | { action: "search"; query: string; limit?: number }
  | { action: "read"; path: string }
  | { action: "list"; folder?: string }
  | { action: "create"; title: string; body: string; tags?: string[]; project?: boolean }
  | { action: "append"; path: string; text: string }
  | { action: "edit"; path: string; content: string; baseHash?: string }
  | { action: "link"; path: string; to: string; baseHash?: string }
  | { action: "rename"; path: string; to: string; baseHash?: string }
  | { action: "delete"; path: string; baseHash?: string }
  | { action: "refactor"; into: string; content: string; baseHash?: string; sources: Array<{ path: string; baseHash: string }>; tags?: string[]; project?: boolean }
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
    case "omp-ui_vault_rename": return "rename";
    case "omp-ui_vault_delete": return "delete";
    case "omp-ui_vault_refactor": return "refactor";
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
  if (action === "refactor") {
    const into = raw.into;
    const content = raw.content;
    const sources = raw.sources;
    const baseHash = raw.baseHash;
    let tags: string[] | undefined;
    const project = raw.project;
    if (typeof into !== "string" || into.trim() === "") return fail("into", "non-empty string");
    if (typeof content !== "string") return fail("content", "string");
    if ("baseHash" in raw && typeof baseHash !== "string") return fail("baseHash", "string");
    if (!Array.isArray(sources) || sources.length < 1 || sources.length > 20) return fail("sources", "array of 1 to 20 items");
    const entries: Array<{ path: string; baseHash: string }> = [];
    for (const item of sources) {
      if (!isArgumentRecord(item)) return fail("sources item", "object");
      if (typeof item.path !== "string" || item.path.trim() === "") return fail("sources item path", "non-empty string");
      if (typeof item.baseHash !== "string") return fail("sources item baseHash", "string");
      entries.push({ path: item.path, baseHash: item.baseHash });
    }
    if ("tags" in raw) {
      if (!isStringArray(raw.tags)) return fail("tags", "string array");
      tags = raw.tags;
    }
    if ("project" in raw && typeof project !== "boolean") return fail("project", "boolean");
    return { ok: true, args: { action, ...chosen, into, content,
      ...(typeof baseHash === "string" ? { baseHash } : {}),
      sources: entries,
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
  if (action === "delete") return { ok: true, args: { action, ...chosen, ...hash, path: sourcePath } };
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
    // The caller has already checked presence and latest-read authorization;
    // core re-checks the on-disk hash before every mutation.
    case "edit": return vaultEdit(ctx, args.path, args.content, args.baseHash!);
    case "link": return vaultLink(ctx, args.path, args.to, args.baseHash!);
    case "rename": return vaultRename(ctx, args.path, args.to, args.baseHash!);
    case "delete": return vaultDelete(ctx, args.path, args.baseHash!);
    case "refactor": return vaultRefactor(ctx, { into: args.into, content: args.content, sources: args.sources,
      ...(args.baseHash === undefined ? {} : { baseHash: args.baseHash }),
      ...(args.tags === undefined ? {} : { tags: args.tags }),
    });
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
