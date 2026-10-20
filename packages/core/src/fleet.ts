/**
 * Fleet dispatch (issue #899, ADR-0061): the shared, pure half. Types, limits,
 * placement weights, and the validators every side of a dispatch agrees on.
 * Zero `node:` imports — the renderer imports this module through the
 * `@omp-ui/core/fleet` subpath; the host sampler and the staged prompt live in
 * fleet-host.ts.
 */
import type { SessionSummary } from "./types";

export const LOCAL_MACHINE_KEY = "local";
export type PlacementPreference = "prefer" | "normal" | "less" | "manual";
export const PLACEMENT_PREFERENCES: readonly PlacementPreference[] = ["prefer", "normal", "less", "manual"];
export const PLACEMENT_WEIGHT: Record<PlacementPreference, number> = {
  prefer: 100,
  normal: 50,
  less: 25,
  manual: 0,
};
export const FLEET_TITLE_MAX = 200; // code points, after trim
export const FLEET_PROMPT_MAX = 200_000; // UTF-16 units
export const FLEET_LABEL_MAX = 64;
export const FLEET_BATCH_MAX = 8; // targets per request
export const FLEET_REPORT_MAX_AGE_MS = 15_000;
export const FLEET_REPORT_MAX_SKEW_MS = 5_000;
/** The derived title (no explicit one given) keeps this many code points of the prompt's first line. */
export const FLEET_DERIVED_TITLE_MAX = 80;
const FLEET_ID_MAX = 128;

/** C0 and C1 control characters; names, titles, and labels refuse them. */
// eslint-disable-next-line no-control-regex
export const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** The three agent-facing host tools (§6), in registration order. */
export const FLEET_TOOLS = ["omp-ui_fleet_machines", "omp-ui_fleet_dispatch", "omp-ui_fleet_status"] as const;
export type FleetToolName = (typeof FLEET_TOOLS)[number];

export interface FleetRequester {
  /** The dispatching app's registry instanceId. */
  instanceId: string;
  /** `os.hostname()`, truncated to FLEET_LABEL_MAX. */
  label: string;
  kind: "user" | "agent";
  /** The agent's tab on the dispatcher; null for a user dispatch. */
  sourceTabId: string | null;
}

/** Rides NewRpcSpawnRequest.fleet; validated by parseFleetSpawnSpec. */
export interface FleetSpawnSpec {
  dispatchId: string;
  /** Null for a single-target dispatch. */
  batchId: string | null;
  title: string;
  prompt: string;
  requestedBy: FleetRequester;
}

/** Persisted on OwnedSessionRecord.fleet (no prompt: it is staged on disk). */
export interface FleetProvenance {
  dispatchId: string;
  batchId: string | null;
  /** ISO, stamped by the owner at accept time. */
  dispatchedAt: string;
  requestedBy: FleetRequester;
}

export interface FleetHostProject {
  path: string;
  name: string;
  /** `host/owner/repo`, lowercased; null when the checkout has no web remote. */
  repositoryKey: string | null;
  /** `git rev-parse HEAD` of the project checkout; null when unknown. */
  headCommit: string | null;
  /** The spawn provider gate for this path. */
  providerReady: boolean;
  /** Owner-resolved spawn advisor default. */
  advisor: boolean;
  advisorModel: string | null;
}

export interface FleetHostReport {
  instanceId: string;
  label: string;
  version: string;
  platform: string;
  arch: string;
  cpuCount: number;
  /** 0..1 over the sample window; null when unknown. */
  cpuUtilization: number | null;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
  liveSessions: number;
  runningTurns: number;
  /** Owner clock; never used for freshness. */
  sampledAt: number;
  projects: FleetHostProject[];
}

export type FleetMachineStatus = "ready" | "unsupported" | "unreachable" | "error";

export interface FleetMachine {
  /** LOCAL_MACHINE_KEY or the remote instance id. */
  key: string;
  /** Null for this app (the renderer labels it "This computer"). */
  nickname: string | null;
  status: FleetMachineStatus;
  error: string | null;
  preference: PlacementPreference;
  report: FleetHostReport | null;
  /** Dispatcher clock when the report arrived. */
  receivedAt: number | null;
}

export interface FleetTargetPick {
  machineKey: string;
  projectCwd: string;
}

export type FleetTargets =
  | { kind: "explicit"; picks: FleetTargetPick[] }
  | { kind: "auto"; reference: FleetTargetPick; count: number };

export interface FleetDispatchRequest {
  targets: FleetTargets;
  prompt: string;
  /** Null derives the title from the prompt's first line. */
  title: string | null;
  workspace: "worktree" | "checkout";
  planMode: boolean;
  /** Retry of an unknown outcome: exactly one explicit pick; both ids are reused. */
  retryOf?: { dispatchId: string; batchId: string | null };
}

export type FleetDispatchOutcome =
  | { dispatchId: string; machineKey: string; projectCwd: string; status: "started"; tabId: string }
  | { dispatchId: string; machineKey: string; projectCwd: string; status: "failed" | "unknown"; message: string };

export interface FleetDispatchResult {
  batchId: string | null;
  outcomes: FleetDispatchOutcome[];
}

export interface FleetPendingDispatch {
  dispatchId: string;
  batchId: string | null;
  machineKey: string;
  nickname: string | null;
  projectCwd: string;
  title: string;
  since: string;
  message: string;
}

/** The id of the dispatched prompt command on the owner's initialCommands rail. */
export function fleetPromptCommandId(dispatchId: string): string {
  return `omp-ui-fleet-prompt-${dispatchId}`;
}

// ── Placement ───────────────────────────────────────────────────────────────

export interface PlacementCandidate {
  machineKey: string;
  projectCwd: string;
  weight: number;
  report: FleetHostReport | null;
  receivedAt: number | null;
}

/** 0 = ineligible. weight * cpuCount * (1 - cpu) * (available / total). */
export function placementScore(c: PlacementCandidate, now: number): number {
  const report = c.report;
  if (report === null || c.receivedAt === null) return 0;
  if (now - c.receivedAt > FLEET_REPORT_MAX_AGE_MS || c.receivedAt > now + FLEET_REPORT_MAX_SKEW_MS) return 0;
  if (!Number.isFinite(c.weight) || c.weight <= 0) return 0;
  const cpu = report.cpuUtilization;
  if (cpu === null || !Number.isFinite(cpu) || cpu >= 0.95) return 0;
  if (!(report.cpuCount > 0) || !(report.totalMemoryBytes > 0)) return 0;
  const memory = report.availableMemoryBytes / report.totalMemoryBytes;
  if (!Number.isFinite(memory) || memory <= 0.05) return 0;
  return c.weight * report.cpuCount * (1 - Math.max(0, cpu)) * Math.min(1, memory);
}

/** Distinct machines, best first; ties keep input order. Returns [] when fewer
 *  than `count` candidates score above 0 (the caller reports the shortfall). */
export function choosePlacement(cands: PlacementCandidate[], now: number, count: number): PlacementCandidate[] {
  const scored = cands
    .map((candidate, index) => ({ candidate, index, score: placementScore(candidate, now) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const seen = new Set<string>();
  const picked: PlacementCandidate[] = [];
  for (const { candidate } of scored) {
    if (seen.has(candidate.machineKey)) continue;
    seen.add(candidate.machineKey);
    picked.push(candidate);
  }
  return picked.length < count ? [] : picked.slice(0, count);
}

/** Eligible machines (score above 0) among `cands`, counted once each. */
export function eligibleMachineCount(cands: PlacementCandidate[], now: number): number {
  return new Set(cands.filter((c) => placementScore(c, now) > 0).map((c) => c.machineKey)).size;
}

// ── Validation ──────────────────────────────────────────────────────────────

type ObjectValue = Record<string, unknown>;

function objectValue(value: unknown, label: string): ObjectValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as ObjectValue;
}

function rejectUnknownKeys(value: ObjectValue, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`${label} contains unknown field ${unknown}`);
}

function idString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "" || value.length > FLEET_ID_MAX || CONTROL_CHARS.test(value)) {
    throw new Error(`${label} must be a non-empty id`);
  }
  return value;
}

function nullableId(value: unknown, label: string): string | null {
  return value === null ? null : idString(value, label);
}

/** The prompt rule: not blank, at most FLEET_PROMPT_MAX UTF-16 units. */
export function validateFleetPrompt(value: unknown, label = "prompt"): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must not be blank`);
  if (value.length > FLEET_PROMPT_MAX) throw new Error(`${label} exceeds ${FLEET_PROMPT_MAX} characters`);
  return value;
}

/** The title rule: trimmed, 1..FLEET_TITLE_MAX code points, no control characters. */
export function validateFleetTitle(value: unknown, label = "title"): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const title = value.trim();
  if (title === "") throw new Error(`${label} must not be blank`);
  if (CONTROL_CHARS.test(title)) throw new Error(`${label} must not contain control characters`);
  if ([...title].length > FLEET_TITLE_MAX) throw new Error(`${label} must be at most ${FLEET_TITLE_MAX} characters`);
  return title;
}

/** The title a dispatch without one gets: the prompt's first non-blank line, cut to 80 code points. */
export function deriveFleetTitle(prompt: string): string {
  const line = prompt.split(/\r?\n/).map((l) => l.trim()).find((l) => l !== "") ?? "";
  // eslint-disable-next-line no-control-regex
  const clean = line.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").trim();
  return [...clean].slice(0, FLEET_DERIVED_TITLE_MAX).join("").trim();
}

function parseRequester(value: unknown, label: string): FleetRequester {
  const r = objectValue(value, label);
  rejectUnknownKeys(r, ["instanceId", "label", "kind", "sourceTabId"], label);
  const name = r.label;
  if (typeof name !== "string" || name.trim() === "" || CONTROL_CHARS.test(name) || [...name].length > FLEET_LABEL_MAX) {
    throw new Error(`${label}.label must be 1..${FLEET_LABEL_MAX} characters without control characters`);
  }
  if (r.kind !== "user" && r.kind !== "agent") throw new Error(`${label}.kind must be user or agent`);
  return {
    instanceId: idString(r.instanceId, `${label}.instanceId`),
    label: name,
    kind: r.kind,
    sourceTabId: nullableId(r.sourceTabId, `${label}.sourceTabId`),
  };
}

/** Strict parse of NewRpcSpawnRequest.fleet. Throws with a `spawn request.fleet` prefix. */
export function parseFleetSpawnSpec(value: unknown): FleetSpawnSpec {
  const label = "spawn request.fleet";
  const spec = objectValue(value, label);
  rejectUnknownKeys(spec, ["dispatchId", "batchId", "title", "prompt", "requestedBy"], label);
  return {
    dispatchId: idString(spec.dispatchId, `${label}.dispatchId`),
    batchId: nullableId(spec.batchId, `${label}.batchId`),
    title: validateFleetTitle(spec.title, `${label}.title`),
    prompt: validateFleetPrompt(spec.prompt, `${label}.prompt`),
    requestedBy: parseRequester(spec.requestedBy, `${label}.requestedBy`),
  };
}

/** Strict shape guard for a persisted FleetProvenance; anything else drops the record. */
export function isFleetProvenance(value: unknown): value is FleetProvenance {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const p = value as ObjectValue;
  if (Object.keys(p).some((k) => !["dispatchId", "batchId", "dispatchedAt", "requestedBy"].includes(k))) return false;
  if (typeof p.dispatchId !== "string" || p.dispatchId === "") return false;
  if (p.batchId !== null && (typeof p.batchId !== "string" || p.batchId === "")) return false;
  if (typeof p.dispatchedAt !== "string" || p.dispatchedAt === "") return false;
  const r = p.requestedBy;
  if (r === null || typeof r !== "object" || Array.isArray(r)) return false;
  const q = r as ObjectValue;
  if (Object.keys(q).some((k) => !["instanceId", "label", "kind", "sourceTabId"].includes(k))) return false;
  return (
    typeof q.instanceId === "string" &&
    typeof q.label === "string" &&
    (q.kind === "user" || q.kind === "agent") &&
    (q.sourceTabId === null || typeof q.sourceTabId === "string")
  );
}

function parsePick(value: unknown, label: string): FleetTargetPick {
  const pick = objectValue(value, label);
  rejectUnknownKeys(pick, ["machineKey", "projectCwd"], label);
  if (typeof pick.machineKey !== "string" || pick.machineKey === "") throw new Error(`${label}.machineKey must be a non-empty string`);
  if (typeof pick.projectCwd !== "string" || pick.projectCwd === "") throw new Error(`${label}.projectCwd must be a non-empty string`);
  return { machineKey: pick.machineKey, projectCwd: pick.projectCwd };
}

function batchCount(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > FLEET_BATCH_MAX) {
    throw new Error(`${label} must be a whole number from 1 to ${FLEET_BATCH_MAX}`);
  }
  return value;
}

/**
 * Strict parse of a dispatch request (the `fleet:dispatch` codec and the
 * dispatcher's own entry check). Messages are user-facing.
 */
export function parseFleetDispatchRequest(value: unknown): FleetDispatchRequest {
  const req = objectValue(value, "dispatch request");
  rejectUnknownKeys(req, ["targets", "prompt", "title", "workspace", "planMode", "retryOf"], "dispatch request");
  const t = objectValue(req.targets, "dispatch request.targets");
  let targets: FleetTargets;
  if (t.kind === "explicit") {
    rejectUnknownKeys(t, ["kind", "picks"], "dispatch request.targets");
    if (!Array.isArray(t.picks) || t.picks.length < 1 || t.picks.length > FLEET_BATCH_MAX) {
      throw new Error(`choose 1 to ${FLEET_BATCH_MAX} targets`);
    }
    targets = { kind: "explicit", picks: t.picks.map((p, i) => parsePick(p, `dispatch request.targets.picks[${i}]`)) };
  } else if (t.kind === "auto") {
    rejectUnknownKeys(t, ["kind", "reference", "count"], "dispatch request.targets");
    targets = {
      kind: "auto",
      reference: parsePick(t.reference, "dispatch request.targets.reference"),
      count: batchCount(t.count, "copies"),
    };
  } else {
    throw new Error("dispatch request.targets.kind must be explicit or auto");
  }
  const prompt = validateFleetPrompt(req.prompt);
  let title: string | null = null;
  if (req.title !== null) {
    if (typeof req.title !== "string") throw new Error("title must be a string or null");
    title = req.title.trim() === "" ? null : validateFleetTitle(req.title);
  }
  if (req.workspace !== "worktree" && req.workspace !== "checkout") {
    throw new Error("workspace must be worktree or checkout");
  }
  if (typeof req.planMode !== "boolean") throw new Error("planMode must be a boolean");
  const workspace = req.workspace;
  if (workspace === "checkout") {
    if (targets.kind === "auto" && targets.count > 1) {
      throw new Error("several copies need a new worktree each; choose New worktree");
    }
    if (targets.kind === "explicit") {
      const seen = new Set<string>();
      for (const pick of targets.picks) {
        const key = `${pick.machineKey}\u0000${pick.projectCwd}`;
        if (seen.has(key)) throw new Error("two copies cannot share one project checkout; choose New worktree");
        seen.add(key);
      }
    }
  }
  let retryOf: FleetDispatchRequest["retryOf"];
  if (Object.prototype.hasOwnProperty.call(req, "retryOf") && req.retryOf !== undefined) {
    const r = objectValue(req.retryOf, "dispatch request.retryOf");
    rejectUnknownKeys(r, ["dispatchId", "batchId"], "dispatch request.retryOf");
    if (targets.kind !== "explicit" || targets.picks.length !== 1) {
      throw new Error("a retry re-sends exactly one explicit target");
    }
    retryOf = {
      dispatchId: idString(r.dispatchId, "dispatch request.retryOf.dispatchId"),
      batchId: nullableId(r.batchId, "dispatch request.retryOf.batchId"),
    };
  }
  return {
    targets,
    prompt,
    title,
    workspace,
    planMode: req.planMode,
    ...(retryOf === undefined ? {} : { retryOf }),
  };
}

// ── Agent tools ─────────────────────────────────────────────────────────────

export interface FleetToolDispatchArgs {
  prompt: string;
  title: string | null;
  project: string;
  machines: string[] | null;
  count: number | null;
  workspace: "worktree" | "checkout";
}

export type FleetToolArguments =
  | { ok: true; tool: "machines" }
  | { ok: true; tool: "dispatch"; args: FleetToolDispatchArgs }
  | { ok: true; tool: "status"; selector: { batchId: string } | { dispatchId: string } }
  | { ok: false; reason: string };

function refuse(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

/** Strict parse of one fleet tool call's arguments; a refusal is the model-facing reason. */
export function parseFleetToolArguments(name: string, raw: unknown): FleetToolArguments {
  const args = raw === undefined || raw === null ? {} : raw;
  if (typeof args !== "object" || Array.isArray(args)) return refuse("arguments must be an object");
  const a = args as ObjectValue;
  const unknownKey = (allowed: readonly string[]): string | undefined => Object.keys(a).find((k) => !allowed.includes(k));
  if (name === "omp-ui_fleet_machines") {
    const extra = unknownKey([]);
    return extra === undefined ? { ok: true, tool: "machines" } : refuse(`unknown argument "${extra}"`);
  }
  if (name === "omp-ui_fleet_status") {
    const extra = unknownKey(["batchId", "dispatchId"]);
    if (extra !== undefined) return refuse(`unknown argument "${extra}"`);
    const hasBatch = a.batchId !== undefined;
    const hasDispatch = a.dispatchId !== undefined;
    if (hasBatch === hasDispatch) return refuse("give exactly one of batchId or dispatchId");
    const value = hasBatch ? a.batchId : a.dispatchId;
    if (typeof value !== "string" || value.trim() === "") return refuse(`${hasBatch ? "batchId" : "dispatchId"} must be a non-empty string`);
    return { ok: true, tool: "status", selector: hasBatch ? { batchId: value.trim() } : { dispatchId: value.trim() } };
  }
  if (name !== "omp-ui_fleet_dispatch") return refuse(`unknown host tool "${name}"`);
  const extra = unknownKey(["prompt", "title", "project", "machines", "count", "workspace"]);
  if (extra !== undefined) return refuse(`unknown argument "${extra}"`);
  let prompt: string;
  let title: string | null = null;
  try {
    prompt = validateFleetPrompt(a.prompt);
    if (a.title !== undefined) {
      if (typeof a.title !== "string") return refuse("title must be a string");
      title = a.title.trim() === "" ? null : validateFleetTitle(a.title);
    }
  } catch (error) {
    return refuse((error as Error).message);
  }
  if (typeof a.project !== "string" || a.project.trim() === "") return refuse("project must be a non-empty string");
  let machines: string[] | null = null;
  if (a.machines !== undefined) {
    if (!Array.isArray(a.machines) || a.machines.length < 1 || a.machines.length > FLEET_BATCH_MAX) {
      return refuse(`machines must list 1 to ${FLEET_BATCH_MAX} machine names`);
    }
    if (a.machines.some((m) => typeof m !== "string" || m.trim() === "")) return refuse("machines must be non-empty names");
    machines = (a.machines as string[]).map((m) => m.trim());
  }
  let count: number | null = null;
  if (a.count !== undefined) {
    if (typeof a.count !== "number" || !Number.isInteger(a.count) || a.count < 1 || a.count > FLEET_BATCH_MAX) {
      return refuse(`count must be a whole number from 1 to ${FLEET_BATCH_MAX}`);
    }
    count = a.count;
  }
  if (machines !== null && count !== null) return refuse("give either machines or count, not both");
  if (a.workspace !== undefined && a.workspace !== "worktree" && a.workspace !== "checkout") {
    return refuse("workspace must be worktree or checkout");
  }
  return {
    ok: true,
    tool: "dispatch",
    args: {
      prompt,
      title,
      project: a.project.trim(),
      machines,
      count,
      workspace: a.workspace === "checkout" ? "checkout" : "worktree",
    },
  };
}

const THIS_COMPUTER = "this computer";

/** The tools' name for a machine: its nickname, or "this computer". */
export function fleetMachineName(machine: Pick<FleetMachine, "nickname">): string {
  return machine.nickname ?? THIS_COMPUTER;
}

/**
 * Translate omp-ui_fleet_dispatch arguments into a dispatch request against
 * the current machines. `project` is an absolute path registered on this app,
 * or a repository key; `machines` are nicknames or "this computer". Agent
 * dispatches are always build mode.
 */
export function fleetToolDispatchRequest(
  args: FleetToolDispatchArgs,
  machines: readonly FleetMachine[],
): { ok: true; request: FleetDispatchRequest } | { ok: false; reason: string } {
  const ready = machines.filter((m) => m.status === "ready" && m.report !== null);
  const local = ready.find((m) => m.key === LOCAL_MACHINE_KEY);
  let reference: FleetTargetPick;
  let repositoryKey: string | null;
  const byPath = args.project.startsWith("/") || args.project.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(args.project);
  if (byPath) {
    const project = local?.report?.projects.find((p) => p.path === args.project);
    if (project === undefined) return refuse(`"${args.project}" is not a project registered on this computer`);
    reference = { machineKey: LOCAL_MACHINE_KEY, projectCwd: project.path };
    repositoryKey = project.repositoryKey;
  } else {
    repositoryKey = args.project.toLowerCase();
    const holder = ready.find((m) => m.report!.projects.some((p) => p.repositoryKey === repositoryKey));
    const project = holder?.report!.projects.find((p) => p.repositoryKey === repositoryKey);
    if (holder === undefined || project === undefined) {
      return refuse(`no ready fleet machine has a project with repository key "${args.project}"`);
    }
    reference = { machineKey: holder.key, projectCwd: project.path };
  }
  const base = { prompt: args.prompt, title: args.title, workspace: args.workspace, planMode: false } as const;
  if (args.machines === null) {
    return { ok: true, request: { ...base, targets: { kind: "auto", reference, count: args.count ?? 1 } } };
  }
  const picks: FleetTargetPick[] = [];
  for (const name of args.machines) {
    const wanted = name.toLowerCase();
    const machine =
      wanted === THIS_COMPUTER
        ? machines.find((m) => m.key === LOCAL_MACHINE_KEY)
        : machines.find((m) => m.nickname !== null && m.nickname.toLowerCase() === wanted);
    if (machine === undefined) return refuse(`no fleet machine is named "${name}"`);
    if (machine.status !== "ready" || machine.report === null) {
      return refuse(`${fleetMachineName(machine)} is not ready (${machine.status}${machine.error ? `: ${machine.error}` : ""})`);
    }
    if (byPath && machine.key === LOCAL_MACHINE_KEY) {
      picks.push({ machineKey: machine.key, projectCwd: reference.projectCwd });
      continue;
    }
    if (repositoryKey === null) {
      return refuse(`"${args.project}" has no repository key, so only this computer can run it`);
    }
    const project = machine.report.projects.find((p) => p.repositoryKey === repositoryKey);
    if (project === undefined) return refuse(`${fleetMachineName(machine)} has no project for ${repositoryKey}`);
    picks.push({ machineKey: machine.key, projectCwd: project.path });
  }
  return { ok: true, request: { ...base, targets: { kind: "explicit", picks } } };
}

/** The omp-ui_fleet_machines answer: one line per machine, then each ready project. */
export function formatFleetMachines(machines: readonly FleetMachine[]): string {
  if (machines.length === 0) return "No fleet machines.";
  const lines: string[] = [];
  for (const m of machines) {
    const name = fleetMachineName(m);
    const report = m.report;
    if (m.status !== "ready" || report === null) {
      lines.push(`- ${name}: ${m.status}${m.error ? ` (${m.error})` : ""}; preference ${m.preference}`);
      continue;
    }
    const cpu = report.cpuUtilization === null ? "CPU unknown" : `CPU ${Math.round(report.cpuUtilization * 100)}%`;
    const memory =
      report.totalMemoryBytes > 0
        ? `${Math.round((report.availableMemoryBytes / report.totalMemoryBytes) * 100)}% memory free`
        : "memory unknown";
    lines.push(
      `- ${name}: ready; ${cpu}; ${memory}; ${report.liveSessions} live sessions, ${report.runningTurns} running turns; preference ${m.preference}`,
    );
    for (const p of report.projects) {
      if (!p.providerReady) continue;
      lines.push(`  - ${p.path} (${p.repositoryKey ?? "no repository key"})`);
    }
  }
  return lines.join("\n");
}

export type FleetSessionState = "working" | "awaiting answer" | "idle" | "dormant";

/** The sidebar level rule without renderer runtime: owner-published state only. */
export function fleetSessionState(
  summary: Pick<SessionSummary, "live" | "pendingPlan" | "awaitingHumanAnswer" | "turnRunning">,
): FleetSessionState {
  if (summary.live !== "live") return "dormant";
  if (summary.pendingPlan !== null || summary.awaitingHumanAnswer === true) return "awaiting answer";
  if (summary.turnRunning === true) return "working";
  return "idle";
}

/** A registry-safe placement map: 1–64-character keys whose values are known preferences. */
export function parseFleetPlacement(value: unknown): Record<string, PlacementPreference> {
  const out: Record<string, PlacementPreference> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, pref] of Object.entries(value as ObjectValue)) {
    if (key.length < 1 || key.length > 64) continue;
    if (typeof pref === "string" && (PLACEMENT_PREFERENCES as readonly string[]).includes(pref)) {
      out[key] = pref as PlacementPreference;
    }
  }
  return out;
}
