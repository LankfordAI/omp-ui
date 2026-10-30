/**
 * MCP endpoint, host side (issue #996, ADR-0080): owns the client store (token
 * hashes), the call audit list, and the in-memory rate limits, and answers
 * each tools/call from the same FleetDispatcher the omp-ui_fleet_* host tools
 * use. The server package owns HTTP, JSON-RPC, and the tool listing.
 */
import { randomUUID } from "node:crypto";
import {
  FLEET_SEND_MAX,
  LOCAL_MACHINE_KEY,
  MCP_GLOBAL_PER_HOUR,
  MCP_SESSION_LIST_MAX,
  fleetChoiceText,
  fleetMachineName,
  fleetSessionState,
  fleetToolDispatchRequest,
  fleetToolMachineKey,
  formatFleetMachines,
  mcpScopeAllows,
  mcpTool,
  parseMcpToolArguments,
  validateFleetPrompt,
  validateFleetTitle,
  type FleetDispatchRequest,
  type FleetDispatchResult,
  type FleetMachine,
  type FleetSendOutcome,
  type FleetToolSendArgs,
  type McpCall,
  type McpCallLog,
  type McpCallOutcome,
  type McpClientInput,
  type McpClientPatch,
  type McpClientRecord,
  type McpClientStore,
  type McpEndpointState,
  type McpTokenReveal,
  type McpToolArguments,
  type McpToolName,
  type SessionSummary,
} from "@omp-ui/core";
import {
  mintMcpClientId,
  mintMcpToken,
  type McpCaller,
  type McpIntake,
  type McpRequestMeta,
  type McpToolResult,
} from "@omp-ui/server";

const HOUR_MS = 3_600_000;
/** A session start is bounded like an agent dispatch, well inside any client's request timeout. */
const MCP_DISPATCH_DEADLINE_MS = 45_000;

export interface FleetSessionRow {
  machineKey: string;
  nickname: string | null;
  summary: SessionSummary;
}

export interface McpEndpointServiceDeps {
  store: McpClientStore;
  log: McpCallLog;
  /** The `mcpEndpointEnabled` setting. */
  enabled(): boolean;
  setEnabled(on: boolean): void;
  /** This app's registry instanceId: the requester identity MCP-started sessions carry. */
  instanceId(): string;
  machines(): Promise<FleetMachine[]>;
  /** Project sessions on this computer and every joined instance; chats are not included. */
  sessions(): Promise<FleetSessionRow[]>;
  /** The owner-rendered summary (title line plus latest landed reply). */
  summary(machineKey: string, tabId: string): Promise<string>;
  /** FleetDispatcher.dispatch with requester kind "mcp" and the client id. */
  dispatch(clientId: string, req: FleetDispatchRequest, opts: { deadlineMs: number }): Promise<FleetDispatchResult>;
  /** FleetDispatcher.send with requester kind "mcp" and the client id. */
  send(clientId: string, args: FleetToolSendArgs): Promise<FleetSendOutcome>;
  /** Pushes `mcp:state` to every client. */
  publish(state: McpEndpointState): void;
  now?: () => number;
  uuid?: () => string;
}

interface Answer {
  text: string;
  outcome: McpCallOutcome;
  target: string | null;
  /** Audit detail; never a prompt or message. */
  message: string | null;
}

function refusedAnswer(reason: string, target: string | null = null): Answer {
  return { text: `refused — ${reason}`, outcome: "refused", target, message: reason };
}

function machineLabel(row: Pick<FleetSessionRow, "nickname">): string {
  return fleetMachineName({ nickname: row.nickname });
}

export class McpEndpointService implements McpIntake {
  readonly #deps: McpEndpointServiceDeps;
  readonly #now: () => number;
  readonly #uuid: () => string;
  /** Accepted session starts and sends per client, and app-wide; in memory, reset by a restart. */
  readonly #spent = new Map<string, number[]>();
  #spentAll: number[] = [];

  constructor(deps: McpEndpointServiceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#uuid = deps.uuid ?? randomUUID;
  }

  state(): McpEndpointState {
    return { enabled: this.#deps.enabled(), clients: this.#deps.store.list(), calls: this.#deps.log.list() };
  }

  #publish(): void {
    this.#deps.publish(this.state());
  }

  setEnabled(on: boolean): void {
    this.#deps.setEnabled(on);
    this.#publish();
  }

  create(input: McpClientInput): McpTokenReveal {
    const token = mintMcpToken();
    const client: McpClientRecord = { id: mintMcpClientId(), ...input, createdAt: new Date(this.#now()).toISOString() };
    this.#deps.store.add(client, token);
    this.#publish();
    return { client, token };
  }

  update(id: string, patch: McpClientPatch): void {
    this.#deps.store.update(id, patch);
    this.#publish();
  }

  rotate(id: string): McpTokenReveal {
    const token = mintMcpToken();
    this.#deps.store.rotate(id, token);
    this.#publish();
    return { client: this.#deps.store.get(id)!, token };
  }

  remove(id: string): void {
    this.#deps.store.remove(id);
    this.#spent.delete(id);
    this.#publish();
  }

  clearCalls(): void {
    this.#deps.log.clear();
    this.#publish();
  }

  // --- McpIntake (called by the remote server) ---

  enabled(): boolean {
    return this.#deps.enabled();
  }

  authenticate(token: string): McpCaller | null {
    const client = this.#deps.store.match(token);
    return client === null || !client.enabled ? null : { clientId: client.id, scope: client.scope };
  }

  async callTool(caller: McpCaller, name: McpToolName, args: unknown, meta: McpRequestMeta): Promise<McpToolResult> {
    const started = this.#now();
    // Re-read: the client may have been disabled, removed, or narrowed since authenticate.
    const client = this.#deps.store.get(caller.clientId);
    let answer: Answer;
    if (client === null || !client.enabled) {
      answer = { text: "refused — this MCP client is no longer enabled", outcome: "forbidden", target: null, message: "client disabled" };
    } else if (!mcpScopeAllows(client.scope, mcpTool(name)!.scope)) {
      const reason = `this MCP client's scope (${client.scope}) does not allow ${name}`;
      answer = { text: `refused — ${reason}`, outcome: "forbidden", target: null, message: reason };
    } else {
      try {
        answer = await this.#run(client, name, args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        answer = { text: `omp-ui could not complete ${name} (${message})`, outcome: "error", target: null, message };
      }
    }
    this.#record({
      id: this.#uuid(),
      at: new Date(started).toISOString(),
      clientId: caller.clientId,
      clientName: client?.name ?? caller.clientId,
      remoteAddress: [...meta.remoteAddress].slice(0, 64).join(""),
      tool: name,
      target: answer.target === null ? null : [...answer.target].slice(0, 200).join(""),
      outcome: answer.outcome,
      message: answer.message === null ? null : [...answer.message].slice(0, 300).join(""),
      durationMs: Math.max(0, this.#now() - started),
    });
    return { text: answer.text, isError: answer.outcome !== "ok" };
  }

  #record(call: McpCall): void {
    this.#deps.log.record(call);
    this.#publish();
  }

  /** Spends one start/send against the client's and the app-wide hourly limits; a reason when over. */
  #spend(client: McpClientRecord): string | null {
    const now = this.#now();
    const recent = (this.#spent.get(client.id) ?? []).filter((t) => now - t < HOUR_MS);
    this.#spentAll = this.#spentAll.filter((t) => now - t < HOUR_MS);
    this.#spent.set(client.id, recent);
    if (client.ratePerHour !== null && recent.length >= client.ratePerHour) {
      return `this client's limit of ${client.ratePerHour} session starts and sends per hour is reached`;
    }
    if (this.#spentAll.length >= MCP_GLOBAL_PER_HOUR) {
      return `the app-wide limit of ${MCP_GLOBAL_PER_HOUR} MCP session starts and sends per hour is reached`;
    }
    recent.push(now);
    this.#spentAll.push(now);
    return null;
  }

  async #run(client: McpClientRecord, name: McpToolName, raw: unknown): Promise<Answer> {
    const parsed = parseMcpToolArguments(name, raw);
    if (!parsed.ok) return refusedAnswer(parsed.reason);
    switch (parsed.tool) {
      case "list_machines":
        return { text: formatFleetMachines(await this.#deps.machines()), outcome: "ok", target: null, message: null };
      case "list_projects":
        return { text: this.#projectsText(await this.#deps.machines()), outcome: "ok", target: null, message: null };
      case "list_sessions":
        return this.#listSessions(client, parsed.machine, parsed.project);
      case "session_status":
        return this.#status(parsed.session);
      case "start_session":
        return this.#start(client, parsed);
      case "send_to_session":
        return this.#sendTo(client, parsed.session, parsed.message, parsed.mode);
    }
  }

  #projectsText(machines: readonly FleetMachine[]): string {
    const lines: string[] = [];
    for (const m of machines) {
      if (m.status !== "ready" || m.report === null) continue;
      for (const p of m.report.projects) {
        lines.push(
          `- ${fleetMachineName(m)}: ${p.path} (${p.repositoryKey ?? "no repository key"})${p.providerReady ? "" : " — no model provider ready"}`,
        );
      }
    }
    return lines.length === 0 ? "No projects on any ready fleet machine." : lines.join("\n");
  }

  /** Listed sessions: project sessions only; private sessions never cross this endpoint. */
  async #visible(): Promise<FleetSessionRow[]> {
    return (await this.#deps.sessions()).filter((row) => !row.summary.private && !row.summary.chat);
  }

  #mine(client: McpClientRecord, summary: SessionSummary): boolean {
    const by = summary.fleet?.requestedBy;
    return by?.kind === "mcp" && by.sourceTabId === client.id && by.instanceId === this.#deps.instanceId();
  }

  async #listSessions(client: McpClientRecord, machine: string | null, project: string | null): Promise<Answer> {
    const target = project ?? machine;
    const machines = await this.#deps.machines();
    let machineKey: string | null = null;
    if (machine !== null) {
      const resolved = fleetToolMachineKey(machine, machines);
      if (!resolved.ok) return refusedAnswer(resolved.reason, target);
      machineKey = resolved.machineKey;
    }
    const keyOf = (row: FleetSessionRow): string | null =>
      machines.find((m) => m.key === row.machineKey)?.report?.projects.find((p) => p.path === row.summary.projectCwd)?.repositoryKey ?? null;
    const rows = (await this.#visible())
      .filter((row) => machineKey === null || row.machineKey === machineKey)
      .filter((row) => project === null || row.summary.projectCwd === project || keyOf(row) === project.toLowerCase())
      .sort((a, b) => (b.summary.cachedModified ?? b.summary.launchedAt).localeCompare(a.summary.cachedModified ?? a.summary.launchedAt));
    if (rows.length === 0) return { text: "No sessions match.", outcome: "ok", target, message: null };
    const lines = rows.slice(0, MCP_SESSION_LIST_MAX).map(({ machineKey: key, nickname, summary }) => {
      const mine = this.#mine(client, summary) ? " · started by you" : "";
      return `- ${summary.tabId} · ${machineLabel({ nickname: key === LOCAL_MACHINE_KEY ? null : nickname })} · ${summary.projectCwd} · ${summary.title} · ${fleetSessionState(summary)}${mine}`;
    });
    if (rows.length > MCP_SESSION_LIST_MAX) lines.push(`… ${rows.length - MCP_SESSION_LIST_MAX} older sessions not shown; narrow by machine or project.`);
    return { text: lines.join("\n"), outcome: "ok", target, message: null };
  }

  async #find(session: string): Promise<FleetSessionRow | undefined> {
    return (await this.#visible()).find((row) => row.summary.tabId === session);
  }

  async #status(session: string): Promise<Answer> {
    const row = await this.#find(session);
    if (row === undefined) return refusedAnswer(`no session ${session}`, session);
    const state = fleetSessionState(row.summary);
    const head = `${row.summary.title} · ${machineLabel(row)} · ${state}`;
    if (state === "working") return { text: `${head}\n\nThe session is still working; check again later.`, outcome: "ok", target: session, message: null };
    const summary = await this.#deps.summary(row.machineKey, row.summary.tabId).catch(() => null);
    const note = state === "awaiting answer" ? "\n\nIt is waiting for the user's answer in omp-ui." : "";
    return { text: `${head}${note}\n\n${summary?.trim() ?? "Summary unavailable."}`, outcome: "ok", target: session, message: null };
  }

  async #start(
    client: McpClientRecord,
    args: Extract<McpToolArguments, { tool: "start_session" }>,
  ): Promise<Answer> {
    const target = args.project;
    let prompt: string;
    let title: string | null;
    try {
      prompt = validateFleetPrompt(args.prompt);
      title = args.title === null ? null : validateFleetTitle(args.title);
    } catch (err) {
      return refusedAnswer((err as Error).message, target);
    }
    const machines = await this.#deps.machines();
    const translated = fleetToolDispatchRequest(
      {
        prompt,
        title,
        project: args.project,
        machines: args.machine === null ? null : [args.machine],
        count: null,
        workspace: args.workspace,
        planMode: args.planMode,
        model: null,
        thinkingLevel: null,
      },
      machines,
    );
    if (!translated.ok) return refusedAnswer(translated.reason, target);
    const over = this.#spend(client);
    if (over !== null) return { text: `refused — ${over}`, outcome: "rate-limited", target, message: over };
    const result = await this.#deps.dispatch(client.id, translated.request, { deadlineMs: MCP_DISPATCH_DEADLINE_MS });
    const outcome = result.outcomes[0];
    if (outcome === undefined) return { text: "omp-ui reported no outcome", outcome: "error", target, message: "no dispatch outcome" };
    const machine = fleetMachineName(machines.find((m) => m.key === outcome.machineKey) ?? { nickname: outcome.machineKey });
    if (outcome.status === "started") {
      return {
        text: `Started session ${outcome.tabId} on ${machine} in ${outcome.projectCwd}${args.planMode ? " (Plan mode)" : " (Build mode)"}${fleetChoiceText(outcome.choice)}. Poll session_status with session "${outcome.tabId}".`,
        outcome: "ok",
        target,
        message: `tab ${outcome.tabId} on ${outcome.machineKey}`,
      };
    }
    if (outcome.status === "unknown") {
      return {
        text: `The session may still start on ${machine}: ${outcome.message}. Look for it with list_sessions before starting it again.`,
        outcome: "error",
        target,
        message: outcome.message,
      };
    }
    return { text: `failed on ${machine} — ${outcome.message}`, outcome: "refused", target, message: outcome.message };
  }

  async #sendTo(client: McpClientRecord, session: string, message: string, mode: "queue" | "steer"): Promise<Answer> {
    if (message.length > FLEET_SEND_MAX) return refusedAnswer(`message exceeds ${FLEET_SEND_MAX} characters`, session);
    const row = await this.#find(session);
    if (row === undefined || !this.#mine(client, row.summary) || row.summary.fleet == null) {
      // A session someone else started reads the same as a missing one.
      return refusedAnswer("only a session this MCP client started can receive its messages", session);
    }
    const over = this.#spend(client);
    if (over !== null) return { text: `refused — ${over}`, outcome: "rate-limited", target: session, message: over };
    const outcome = await this.#deps.send(client.id, { dispatchId: row.summary.fleet.dispatchId, message, mode });
    if (outcome.status === "refused") return refusedAnswer(outcome.reason, session);
    return {
      text: outcome.status === "delivered" ? `delivered to session ${session}` : `queued — ${outcome.detail}`,
      outcome: "ok",
      target: session,
      message: outcome.status,
    };
  }
}
