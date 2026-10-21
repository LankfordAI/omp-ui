/**
 * Fleet dispatch (issue #899, ADR-0061): the shared, pure half. Types, limits,
 * placement weights, and the validators every side of a dispatch agrees on.
 * Zero `node:` imports — the renderer imports this module through the
 * `@omp-ui/core/fleet` subpath; the host sampler and the staged prompt live in
 * fleet-host.ts.
 */
import { PROVIDER_ENV_NAMES } from "./provider-catalog";
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

// Bounded-execution limits (issue #901, ADR-0062). Owner caps sit below the
// manager's 45 s agent bound, which sits below the 60 s host-answer watchdog.
export const FLEET_EXEC_OUTPUT_MAX = 65_536; // bytes per stream
export const FLEET_EXEC_TIMEOUT_MS = 30_000; // owner cap; caller may only shorten
export const FLEET_EXEC_TIMEOUT_MIN_MS = 100;
export const FLEET_COMMAND_MAX = 8_000; // UTF-16 units, single command string
export const FLEET_CLONE_TIMEOUT_MS = 45_000; // fits the 60 s host-answer watchdog
/** Owner cap for one detached exec (issue #905); the caller may only shorten it. */
export const FLEET_DETACHED_EXEC_TIMEOUT_MS = 30 * 60_000;
/** Bytes per stream a poll shows while the process still runs. */
export const FLEET_EXEC_POLL_TAIL = 4_096;
/** Longest a poll waits for the process to finish; inside the 45 s member-call bound. */
export const FLEET_EXEC_POLL_WAIT_MAX_MS = 25_000;
/** Running detached execs per member, across all dispatchers. */
export const FLEET_DETACHED_EXECS_RUNNING_MAX = 4;
/** Finished detached execs a member keeps for polling; the oldest finished one is evicted first. */
export const FLEET_DETACHED_EXECS_RETAINED = 32;
/** The SSH port the dispatcher probes for each member's reachability (issue #904). */
export const FLEET_SSH_PORT = 22;

/** C0 and C1 control characters; names, titles, and labels refuse them. */
// eslint-disable-next-line no-control-regex
export const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

/** The six agent-facing host tools (§6, issues #901, #905), in registration order. */
export const FLEET_TOOLS = [
  "omp-ui_fleet_machines",
  "omp-ui_fleet_dispatch",
  "omp-ui_fleet_status",
  "omp-ui_fleet_exec",
  "omp-ui_fleet_project",
  "omp-ui_fleet_exec_poll",
] as const;
export type FleetToolName = (typeof FLEET_TOOLS)[number];

// ── Grant ladder (issue #901, ADR-0062 as amended) ──────────────────────────

/** Cumulative access rungs, lowest first. Enforcement lives on the node. */
export const FLEET_RUNGS = ["observe", "dispatch", "manage", "full"] as const;
export type FleetRung = (typeof FLEET_RUNGS)[number];

/** 1..4 ladder depth; compare rungs through ranks. */
export function fleetRungRank(r: FleetRung): 1 | 2 | 3 | 4 {
  return (FLEET_RUNGS.indexOf(r) + 1) as 1 | 2 | 3 | 4;
}

export function fleetRungAtLeast(held: FleetRung, need: FleetRung): boolean {
  return fleetRungRank(held) >= fleetRungRank(need);
}

/** min(grant ?? "dispatch", ceiling) — the amendment's cumulative default. */
export function fleetEffectiveRung(grant: FleetGrantRecord | undefined, ceiling: FleetRung): FleetRung {
  const held = grant?.rung ?? "dispatch";
  return fleetRungRank(held) <= fleetRungRank(ceiling) ? held : ceiling;
}

/**
 * One dispatcher's grant on this node, keyed by its CLAIMED instanceId. A
 * record without `rung` is the lazy first-sight entry: it names the
 * dispatcher for the Fleet-access UI while leaving the default rung in force.
 */
export interface FleetGrantRecord {
  rung?: FleetRung;
  label: string;
  updatedAt: string;
}

/** Registry-safe grant map: keys are ids (≤ 128 chars), values shape-checked; anything else drops the entry. */
export function parseFleetGrants(value: unknown): Record<string, FleetGrantRecord> {
  const out: Record<string, FleetGrantRecord> = {};
  if (value === null || typeof value !== "object" || Array.isArray(value)) return out;
  for (const [key, raw] of Object.entries(value as ObjectValue)) {
    if (key === "" || key.length > FLEET_ID_MAX || CONTROL_CHARS.test(key)) continue;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const g = raw as ObjectValue;
    if (Object.keys(g).some((k) => !["rung", "label", "updatedAt"].includes(k))) continue;
    if (g.rung !== undefined && !FLEET_RUNGS.includes(g.rung as FleetRung)) continue;
    if (typeof g.label !== "string" || CONTROL_CHARS.test(g.label)) continue;
    if (typeof g.updatedAt !== "string" || g.updatedAt === "") continue;
    out[key] = {
      ...(g.rung === undefined ? {} : { rung: g.rung as FleetRung }),
      label: [...g.label].slice(0, FLEET_LABEL_MAX).join(""),
      updatedAt: g.updatedAt,
    };
  }
  return out;
}

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

export interface FleetHostOs {
  /** Human name: os-release PRETTY_NAME, "macOS", "Windows 11 Pro", ... */
  name: string;
  /** VERSION_ID / sw_vers productVersion / os.release(); null when unknown. */
  version: string | null;
}

export interface FleetPackageManager {
  /** Fixed table name: dnf, yum, apt, zypper, pacman, apk, brew, flatpak, snap, port, winget, choco, scoop. */
  name: string;
  /** Absolute path of the binary found. */
  path: string;
  /** True when found on the PATH fleet exec children inherit; false when found only at a known install location. */
  onPath: boolean;
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
  /** The member's login user (`os.userInfo().username`); null when unknown or the member predates #904. */
  user: string | null;
  /** The member's declared fleetProjectRoots; null when the member predates #904. */
  projectRoots: string[] | null;
  /** The member's OS (issue #905); null when the member predates #905. */
  os: FleetHostOs | null;
  /** Package managers found on the member, in table order (issue #905); null when the member predates #905. */
  packageManagers: FleetPackageManager[] | null;
}

const FLEET_OS_NAME_MAX = 128;
const FLEET_OS_VERSION_MAX = 64;
const FLEET_PACKAGE_MANAGERS_MAX = 16;

/** "Fedora Linux 44 (Workstation Edition)"; appends version only when name does not already contain it. */
export function fleetOsLabel(os: FleetHostOs): string {
  return os.version === null || os.version === "" || os.name.includes(os.version) ? os.name : `${os.name} ${os.version}`;
}

/** Normalizer for a remote report's `os`: shape-checked or null (name 1..128 chars, version ≤ 64, no control chars). */
export function parseFleetHostOs(value: unknown): FleetHostOs | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const o = value as ObjectValue;
  if (typeof o.name !== "string" || o.name.trim() === "" || o.name.length > FLEET_OS_NAME_MAX || CONTROL_CHARS.test(o.name)) {
    return null;
  }
  if (o.version === null) return { name: o.name, version: null };
  if (typeof o.version !== "string" || o.version.length > FLEET_OS_VERSION_MAX || CONTROL_CHARS.test(o.version)) return null;
  return { name: o.name, version: o.version === "" ? null : o.version };
}

/** Normalizer for a remote report's `packageManagers`: null unless an array; invalid entries dropped; at most 16 kept. */
export function parseFleetPackageManagers(value: unknown): FleetPackageManager[] | null {
  if (!Array.isArray(value)) return null;
  const out: FleetPackageManager[] = [];
  for (const raw of value) {
    if (out.length >= FLEET_PACKAGE_MANAGERS_MAX) break;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
    const m = raw as ObjectValue;
    if (typeof m.name !== "string" || !/^[a-z0-9-]{1,32}$/.test(m.name)) continue;
    if (typeof m.path !== "string" || m.path === "" || m.path.length > 4_096 || CONTROL_CHARS.test(m.path)) continue;
    if (typeof m.onPath !== "boolean") continue;
    out.push({ name: m.name, path: m.path, onPath: m.onPath });
  }
  return out;
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
  /**
   * This dispatcher's effective rung on that member (issue #901); null when
   * the probe failed or the peer predates the grant channel. Never set for
   * LOCAL_MACHINE_KEY: this computer needs no grants.
   */
  grantRung: FleetRung | null;
  /**
   * The host this app reaches the member at: its join URL's hostname, IPv6
   * brackets stripped (issue #904). Null for LOCAL_MACHINE_KEY.
   */
  address: string | null;
  /** Whether FLEET_SSH_PORT answered a TCP connect from this app; null when not probed (this computer, a member not joined, no address). */
  sshReachable: boolean | null;
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

/** Strict decode of the claimed requester identity (shared by codecs and parsers). */
export function parseFleetRequester(value: unknown, label = "requester"): FleetRequester {
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
    requestedBy: parseFleetRequester(spec.requestedBy, `${label}.requestedBy`),
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

// ── Fleet exec & project manage (issue #901, ADR-0062) ─────────────────────

/** One bounded command on the owner's shell. `requester` is the CLAIMED identity. */
export interface FleetExecRequest {
  requester: FleetRequester;
  command: string;
  /** Null runs in the node user's home directory. */
  cwd: string | null;
  /** Null uses FLEET_EXEC_TIMEOUT_MS; the owner clamps into [min, cap]. */
  timeoutMs: number | null;
}

/** Refusals are answers, not transport errors: the reason rides the result. */
export type FleetExecOutcome =
  | {
      status: "accepted";
      exitCode: number | null;
      stdout: string;
      stderr: string;
      truncated: boolean;
      timedOut: boolean;
    }
  | { status: "refused"; reason: string };

/** Rung-3 verbs, fixed surface: clone/register within host-declared roots. */
export type FleetProjectManageRequest =
  | { requester: FleetRequester; verb: "clone"; repositoryUrl: string }
  | { requester: FleetRequester; verb: "register"; path: string };

export type FleetProjectManageOutcome =
  | { status: "accepted"; path: string; headCommit: string | null }
  | { status: "refused"; reason: string };

/** A grant raise re-presents the node's join credential on the node. */
export interface FleetGrantRaiseRequest {
  requester: FleetRequester;
  targetRung: FleetRung;
  /** The node's join token or password; never logged, never stored. */
  credential: string;
}

export type FleetGrantRaiseOutcome = { ok: true; rung: FleetRung } | { ok: false; reason: string };

// ── Detached exec (issue #905, ADR-0065) ────────────────────────────────────

/** Start one command the member keeps running past the call. `requester` is the CLAIMED identity. */
export interface FleetDetachedExecRequest {
  requester: FleetRequester;
  command: string;
  cwd: string | null;
  /** Null uses FLEET_DETACHED_EXEC_TIMEOUT_MS; the owner clamps into [FLEET_EXEC_TIMEOUT_MIN_MS, that cap]. */
  timeoutMs: number | null;
}

export type FleetDetachedExecStartOutcome =
  | { status: "accepted"; execId: string }
  | { status: "refused"; reason: string };

export interface FleetExecPollRequest {
  requester: FleetRequester;
  execId: string;
  /** The owner clamps into [0, FLEET_EXEC_POLL_WAIT_MAX_MS]. */
  waitMs: number;
  /** Kill the process tree before answering. */
  cancel: boolean;
}

export type FleetDetachedExecState = "running" | "exited" | "timed-out" | "cancelled" | "revoked";

export type FleetExecPollOutcome =
  | {
      status: "accepted";
      execId: string;
      state: FleetDetachedExecState;
      /** Null while running, on a signal kill, or on a spawn error. */
      exitCode: number | null;
      stdout: string;
      stderr: string;
      /** Earlier bytes exist that this answer does not show. */
      truncated: boolean;
      elapsedMs: number;
    }
  | { status: "refused"; reason: string };

// ── Provider key rollout (issue #905, ADR-0065) ─────────────────────────────

export interface FleetProviderKeyEntry {
  envName: string;
  value: string;
}

export interface FleetProviderKeysRequest {
  requester: FleetRequester;
  keys: FleetProviderKeyEntry[];
}

export type FleetProviderKeysOutcome =
  | { status: "accepted"; installed: string[]; failed: Array<{ envName: string; reason: string }> }
  | { status: "refused"; reason: string };

/** One accepted-or-refused fleet action on the node (its audit ring entry). */
export interface FleetAuditEntry {
  at: string;
  dispatcherId: string;
  dispatcherLabel: string;
  /** The agent's tab on the dispatcher when the call came from a tool. */
  sourceTabId: string | null;
  action: "exec" | "exec-detached" | "manage" | "keys" | "grant-raise" | "grant-set";
  /** The rung used (actions) or the literal marker for grant bookkeeping. */
  rung: FleetRung | "raise" | "set";
  accepted: boolean;
  /** Command text or verb/path, truncated at record time. */
  detail: string;
  exitCode: number | null;
}

/** The command rule: non-blank, capped, no control characters but newline (LF/CRLF) and tab. */
export function validateFleetCommand(value: unknown, label = "command"): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must not be blank`);
  if (value.length > FLEET_COMMAND_MAX) throw new Error(`${label} exceeds ${FLEET_COMMAND_MAX} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/.test(value)) {
    throw new Error(`${label} must not contain control characters other than newline and tab`);
  }
  return value;
}

/** A path argument: non-empty, no control characters, generous cap. */
function pathArg(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "" || value.length > 4_096 || CONTROL_CHARS.test(value)) {
    throw new Error(`${label} must be a non-empty path`);
  }
  return value;
}

/** The requester/command/cwd/timeoutMs body both exec request parsers share. */
function parseExecBody(value: unknown, label: string): FleetExecRequest {
  const req = objectValue(value, label);
  rejectUnknownKeys(req, ["requester", "command", "cwd", "timeoutMs"], label);
  const cwd = req.cwd === null || req.cwd === undefined ? null : pathArg(req.cwd, `${label}.cwd`);
  let timeoutMs: number | null = null;
  if (req.timeoutMs !== null && req.timeoutMs !== undefined) {
    if (typeof req.timeoutMs !== "number" || !Number.isFinite(req.timeoutMs)) {
      throw new Error(`${label}.timeoutMs must be a number or null`);
    }
    timeoutMs = req.timeoutMs;
  }
  return {
    requester: parseFleetRequester(req.requester, `${label}.requester`),
    command: validateFleetCommand(req.command),
    cwd,
    timeoutMs,
  };
}

/** Strict parse of a fleet exec request (codec + node entry check). Messages are user-facing. */
export function parseFleetExecRequest(value: unknown): FleetExecRequest {
  return parseExecBody(value, "exec request");
}

/** Strict parse of a detached exec start (codec + node entry check). Messages are user-facing. */
export function parseFleetDetachedExecRequest(value: unknown): FleetDetachedExecRequest {
  return parseExecBody(value, "detached exec request");
}

/** Strict parse of a detached exec poll. Messages are user-facing. */
export function parseFleetExecPollRequest(value: unknown): FleetExecPollRequest {
  const label = "exec poll request";
  const req = objectValue(value, label);
  rejectUnknownKeys(req, ["requester", "execId", "waitMs", "cancel"], label);
  if (typeof req.waitMs !== "number" || !Number.isFinite(req.waitMs)) throw new Error(`${label}.waitMs must be a number`);
  if (typeof req.cancel !== "boolean") throw new Error(`${label}.cancel must be true or false`);
  return {
    requester: parseFleetRequester(req.requester, `${label}.requester`),
    execId: idString(req.execId, `${label}.execId`),
    waitMs: req.waitMs,
    cancel: req.cancel,
  };
}

const FLEET_PROVIDER_KEY_VALUE_MAX_BYTES = 8_192;

/**
 * Strict parse of a Provider key rollout. Messages name an env name or an
 * entry index only — NEVER a value, and never an unrecognized env name (it
 * could be a misplaced value).
 */
export function parseFleetProviderKeysRequest(value: unknown): FleetProviderKeysRequest {
  const label = "provider keys request";
  const req = objectValue(value, label);
  rejectUnknownKeys(req, ["requester", "keys"], label);
  const requester = parseFleetRequester(req.requester, `${label}.requester`);
  if (!Array.isArray(req.keys) || req.keys.length < 1 || req.keys.length > PROVIDER_ENV_NAMES.length) {
    throw new Error(`${label}.keys must list 1 to ${PROVIDER_ENV_NAMES.length} keys`);
  }
  const seen = new Set<string>();
  const encoder = new TextEncoder();
  const keys = req.keys.map((raw, i): FleetProviderKeyEntry => {
    const at = `${label}.keys[${i}]`;
    const entry = objectValue(raw, at);
    rejectUnknownKeys(entry, ["envName", "value"], at);
    const envName = entry.envName;
    if (typeof envName !== "string" || !PROVIDER_ENV_NAMES.includes(envName)) {
      throw new Error(`${at}.envName is not a known provider variable`);
    }
    if (seen.has(envName)) throw new Error(`${at}: ${envName} appears more than once`);
    seen.add(envName);
    const v = entry.value;
    if (typeof v !== "string" || v === "" || encoder.encode(v).length > FLEET_PROVIDER_KEY_VALUE_MAX_BYTES) {
      throw new Error(`${at}: the value for ${envName} must be a non-empty string of at most ${FLEET_PROVIDER_KEY_VALUE_MAX_BYTES} bytes`);
    }
    return { envName, value: v };
  });
  return { requester, keys };
}

/** Strict parse of a rung-3 project-manage request. Exactly one verb-matched field. */
export function parseFleetProjectManageRequest(value: unknown): FleetProjectManageRequest {
  const label = "project manage request";
  const req = objectValue(value, label);
  rejectUnknownKeys(req, ["requester", "verb", "repositoryUrl", "path"], label);
  const requester = parseFleetRequester(req.requester, `${label}.requester`);
  if (req.verb === "clone") {
    rejectUnknownKeys(req, ["requester", "verb", "repositoryUrl"], label);
    if (typeof req.repositoryUrl !== "string" || req.repositoryUrl.trim() === "") {
      throw new Error(`${label}.repositoryUrl must be a non-empty https URL`);
    }
    return { requester, verb: "clone", repositoryUrl: req.repositoryUrl.trim() };
  }
  if (req.verb === "register") {
    rejectUnknownKeys(req, ["requester", "verb", "path"], label);
    return { requester, verb: "register", path: pathArg(req.path, `${label}.path`) };
  }
  throw new Error(`${label}.verb must be clone or register`);
}

/** Registry-safe project roots: absolute directories only; anything else drops the entry. */
export function parseFleetProjectRoots(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (root): root is string =>
      typeof root === "string" &&
      root.length > 1 &&
      root.length <= 4_096 &&
      !CONTROL_CHARS.test(root) &&
      (root.startsWith("/") || /^[A-Za-z]:[\\/]/.test(root) || root.startsWith("\\\\")),
  );
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

export interface FleetToolExecArgs {
  machine: string;
  command: string;
  cwd: string | null;
  timeoutMs: number | null;
  /** True starts a detached exec (issue #905). Default false. */
  detach: boolean;
}

export interface FleetToolExecPollArgs {
  machine: string;
  execId: string;
  /** Default false. */
  cancel: boolean;
  /** Null waits FLEET_EXEC_POLL_WAIT_MAX_MS. */
  waitMs: number | null;
}

export interface FleetToolProjectArgs {
  machine: string;
  verb: "clone" | "register";
  repositoryUrl: string | null;
  path: string | null;
}

export type FleetToolArguments =
  | { ok: true; tool: "machines" }
  | { ok: true; tool: "dispatch"; args: FleetToolDispatchArgs }
  | { ok: true; tool: "status"; selector: { batchId: string } | { dispatchId: string } }
  | { ok: true; tool: "exec"; args: FleetToolExecArgs }
  | { ok: true; tool: "project"; args: FleetToolProjectArgs }
  | { ok: true; tool: "execPoll"; args: FleetToolExecPollArgs }
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
  if (name === "omp-ui_fleet_exec") {
    const extra = unknownKey(["machine", "command", "cwd", "timeoutMs", "detach"]);
    if (extra !== undefined) return refuse(`unknown argument "${extra}"`);
    if (typeof a.machine !== "string" || a.machine.trim() === "") return refuse("machine must be a non-empty string");
    let command: string;
    try {
      command = validateFleetCommand(a.command);
    } catch (error) {
      return refuse((error as Error).message);
    }
    let cwd: string | null = null;
    if (a.cwd !== undefined) {
      if (typeof a.cwd !== "string" || a.cwd === "") return refuse("cwd must be a non-empty string");
      cwd = a.cwd;
    }
    let timeoutMs: number | null = null;
    if (a.timeoutMs !== undefined) {
      if (typeof a.timeoutMs !== "number" || !Number.isInteger(a.timeoutMs)) return refuse("timeoutMs must be a whole number");
      // The owner clamps into [FLEET_EXEC_TIMEOUT_MIN_MS, its cap] (30 s, or
      // 30 min detached); the tool only refuses absurd values the model could not mean.
      if (a.timeoutMs <= 0 || !Number.isFinite(a.timeoutMs)) return refuse("timeoutMs must be positive");
      timeoutMs = a.timeoutMs;
    }
    if (a.detach !== undefined && typeof a.detach !== "boolean") return refuse("detach must be true or false");
    return { ok: true, tool: "exec", args: { machine: a.machine.trim(), command, cwd, timeoutMs, detach: a.detach === true } };
  }
  if (name === "omp-ui_fleet_exec_poll") {
    const extra = unknownKey(["machine", "execId", "cancel", "waitMs"]);
    if (extra !== undefined) return refuse(`unknown argument "${extra}"`);
    if (typeof a.machine !== "string" || a.machine.trim() === "") return refuse("machine must be a non-empty string");
    if (typeof a.execId !== "string" || a.execId.trim() === "") return refuse("execId must be a non-empty string");
    if (a.cancel !== undefined && typeof a.cancel !== "boolean") return refuse("cancel must be true or false");
    let waitMs: number | null = null;
    if (a.waitMs !== undefined) {
      if (typeof a.waitMs !== "number" || !Number.isInteger(a.waitMs) || a.waitMs < 0 || a.waitMs > FLEET_EXEC_POLL_WAIT_MAX_MS) {
        return refuse(`waitMs must be a whole number from 0 to ${FLEET_EXEC_POLL_WAIT_MAX_MS}`);
      }
      waitMs = a.waitMs;
    }
    return {
      ok: true,
      tool: "execPoll",
      args: { machine: a.machine.trim(), execId: a.execId.trim(), cancel: a.cancel === true, waitMs },
    };
  }
  if (name === "omp-ui_fleet_project") {
    const extra = unknownKey(["machine", "verb", "repositoryUrl", "path"]);
    if (extra !== undefined) return refuse(`unknown argument "${extra}"`);
    if (typeof a.machine !== "string" || a.machine.trim() === "") return refuse("machine must be a non-empty string");
    if (a.verb !== "clone" && a.verb !== "register") return refuse("verb must be clone or register");
    const hasUrl = a.repositoryUrl !== undefined;
    const hasPath = a.path !== undefined;
    if (hasUrl === hasPath) return refuse("give exactly one of repositoryUrl or path, matching the verb");
    if (a.verb === "clone") {
      if (!hasUrl) return refuse("clone needs repositoryUrl");
      if (typeof a.repositoryUrl !== "string" || a.repositoryUrl.trim() === "") return refuse("repositoryUrl must be a non-empty string");
      return { ok: true, tool: "project", args: { machine: a.machine.trim(), verb: "clone", repositoryUrl: a.repositoryUrl.trim(), path: null } };
    }
    if (!hasPath) return refuse("register needs path");
    if (typeof a.path !== "string" || a.path === "") return refuse("path must be a non-empty string");
    return { ok: true, tool: "project", args: { machine: a.machine.trim(), verb: "register", repositoryUrl: null, path: a.path } };
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

/** A join URL's hostname without IPv6 brackets; null when the URL does not parse or names no host. */
export function fleetMemberAddress(url: string): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return bare === "" ? null : bare;
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

/**
 * Translate omp-ui_fleet_exec / omp-ui_fleet_exec_poll / omp-ui_fleet_project `machine` into a machine
 * key: "this computer" resolves to LOCAL_MACHINE_KEY, otherwise the nickname
 * match (case-insensitive). A refusal lists the known names.
 */
export function fleetToolMachineKey(name: string, machines: readonly FleetMachine[]): { ok: true; machineKey: string } | { ok: false; reason: string } {
  const wanted = name.toLowerCase();
  const machine =
    wanted === THIS_COMPUTER
      ? machines.find((m) => m.key === LOCAL_MACHINE_KEY)
      : machines.find((m) => m.nickname !== null && m.nickname.toLowerCase() === wanted);
  if (machine !== undefined) return { ok: true, machineKey: machine.key };
  const known = [THIS_COMPUTER, ...machines.filter((m) => m.nickname !== null).map((m) => m.nickname!)].join(", ");
  return refuse(`no fleet machine is named "${name}" (known: ${known})`);
}

/**
 * Translate omp-ui_fleet_exec arguments into a request; the owner holds the
 * ladder. `detach` rides beside the request so the dispatcher picks the
 * channel (fleet:exec or fleet:execDetach); both take the same request body.
 */
export function fleetToolExecRequest(
  args: FleetToolExecArgs,
  machines: readonly FleetMachine[],
):
  | { ok: true; machineKey: string; detach: boolean; request: Omit<FleetExecRequest, "requester"> }
  | { ok: false; reason: string } {
  const resolved = fleetToolMachineKey(args.machine, machines);
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    machineKey: resolved.machineKey,
    detach: args.detach,
    request: { command: args.command, cwd: args.cwd, timeoutMs: args.timeoutMs },
  };
}

/** Translate omp-ui_fleet_exec_poll arguments into a request; ownership of the execId is the member's gate. */
export function fleetToolExecPollRequest(
  args: FleetToolExecPollArgs,
  machines: readonly FleetMachine[],
): { ok: true; machineKey: string; request: Omit<FleetExecPollRequest, "requester"> } | { ok: false; reason: string } {
  const resolved = fleetToolMachineKey(args.machine, machines);
  if (!resolved.ok) return resolved;
  return {
    ok: true,
    machineKey: resolved.machineKey,
    request: { execId: args.execId, waitMs: args.waitMs ?? FLEET_EXEC_POLL_WAIT_MAX_MS, cancel: args.cancel },
  };
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
      if (m.key !== LOCAL_MACHINE_KEY && m.address !== null) lines.push(`  address: ${m.address} (not connected)`);
      continue;
    }
    const cpu = report.cpuUtilization === null ? "CPU unknown" : `CPU ${Math.round(report.cpuUtilization * 100)}%`;
    const memory =
      report.totalMemoryBytes > 0
        ? `${Math.round((report.availableMemoryBytes / report.totalMemoryBytes) * 100)}% memory free`
        : "memory unknown";
    // The rung this dispatcher holds on that member (issue #901); never for
    // this computer, which carries no grants.
    const access = m.key !== LOCAL_MACHINE_KEY && m.grantRung !== null ? `; access ${m.grantRung}` : "";
    lines.push(
      `- ${name}: ready; ${cpu}; ${memory}; ${report.liveSessions} live sessions, ${report.runningTurns} running turns; preference ${m.preference}${access}`,
    );
    // Where the session's own ssh reaches this member (issue #904, ADR-0064).
    if (m.key !== LOCAL_MACHINE_KEY && m.address !== null) {
      const target = report.user === null ? m.address : `${report.user}@${m.address}`;
      const probe =
        m.sshReachable === null
          ? `port ${FLEET_SSH_PORT} not checked`
          : m.sshReachable
            ? `port ${FLEET_SSH_PORT} open`
            : `port ${FLEET_SSH_PORT} closed`;
      const roots =
        report.projectRoots === null
          ? "not reported"
          : report.projectRoots.length === 0
            ? "none declared"
            : report.projectRoots.join(", ");
      lines.push(`  ssh: ${target} (${probe}); platform ${report.platform} ${report.arch}; project roots: ${roots}`);
    }
    // What the member runs and can install with (issue #905, ADR-0065).
    if (m.key !== LOCAL_MACHINE_KEY) {
      const system = report.os === null ? "not reported" : fleetOsLabel(report.os);
      const managers =
        report.packageManagers === null
          ? "not reported"
          : report.packageManagers.length === 0
            ? "none found"
            : report.packageManagers.map((pm) => (pm.onPath ? pm.name : `${pm.name} at ${pm.path}`)).join(", ");
      lines.push(`  system: ${system}; package managers: ${managers}`);
    }
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
