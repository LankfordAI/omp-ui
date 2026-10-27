// The background-jobs wire contract (issue #835, ADR-0054). Pure — zero
// runtime imports — because the renderer imports it directly via the
// @omp-ui/core/async-jobs subpath, exactly like vibe.ts. The generating half
// lives in async-jobs-extension.ts and interpolates these same constants, so
// the publisher and the parser can never drift.
//
// omp keeps background jobs in an in-process async job manager that no rpc
// frame carries (verified on omp/18.8.9: get_state only says
// hasPendingAsyncWork). The bridge reads AgentSession.getAsyncJobTree /
// getAsyncJobSnapshot / inspectAsyncJob and cancels through cancelAsyncJob —
// the same calls omp's own `/jobs` and `/jobs kill` make.

/** setStatus key the generated bridge publishes on. Routed, never rendered raw. */
export const ASYNC_JOBS_STATUS_KEY = "omp-ui:async-jobs";

/** Hidden slash command: bare = arm + force-publish; `kill <json>` = cancel. */
export const ASYNC_JOBS_COMMAND = "omp-ui-async-jobs";
export const ASYNC_JOBS_KILL_ARG = "kill";

/** Hard cap on the serialized snapshot (UTF-8 bytes). */
export const ASYNC_JOBS_STATUS_BYTE_LIMIT = 256 * 1024;
/** Poll cadence; a publish only leaves the process when the digest changed. */
export const ASYNC_JOBS_POLL_MS = 1_500;
/** Idle cadence once a poll published nothing new (#858); a digest change or
 * a publish from any command path returns the chain to ASYNC_JOBS_POLL_MS. */
export const ASYNC_JOBS_POLL_IDLE_MS = 10_000;
/** Finished jobs requested from omp (omp's own /jobs asks for 5). */
export const ASYNC_JOBS_RECENT_LIMIT = 10;
/** Output tail per job, then the fallback rung when the snapshot is too big. */
export const ASYNC_JOBS_OUTPUT_TAIL_CHARS = 2_000;
export const ASYNC_JOBS_SHORT_TAIL_CHARS = 200;
export const ASYNC_JOBS_LABEL_CHAR_LIMIT = 512;
export const ASYNC_JOBS_COMMAND_CHAR_LIMIT = 1_024;

/** omp's AsyncJobManager statuses (register/cancel paths in omp/18.8.9). */
export const ASYNC_JOB_STATUSES = ["running", "completed", "failed", "cancelled"] as const;
export type AsyncJobStatus = (typeof ASYNC_JOB_STATUSES)[number];

/** omp's job-widget tones (job-widgets/spec.ts, verified on omp/18.13.2). */
export const ASYNC_JOB_WIDGET_TONES = [
  "neutral",
  "accent",
  "info",
  "success",
  "warning",
  "error",
  "pending",
  "muted",
  "user",
] as const;
export type AsyncJobWidgetTone = (typeof ASYNC_JOB_WIDGET_TONES)[number];
/** Per-string cap on widget text: omp's own cap for grid/text cells and stage. */
export const ASYNC_JOB_WIDGET_TEXT_LIMIT = 200;
/** omp allows 1–4 blocks per widget spec. */
export const ASYNC_JOB_WIDGET_BLOCK_LIMIT = 4;
/** Longest list one block carries: omp's 48 spark points / 48 grid cells. */
export const ASYNC_JOB_WIDGET_LIST_LIMIT = 48;

export interface AsyncJobWidgetTrend {
  text: string;
  tone: AsyncJobWidgetTone;
}
export interface AsyncJobWidgetHeadline {
  text: string;
  label: string | null;
  trend: AsyncJobWidgetTrend | null;
}
export interface AsyncJobWidgetMark {
  value: number;
  label: string;
  tone: AsyncJobWidgetTone;
}
export type AsyncJobWidgetBlock =
  | {
      kind: "spark";
      label: string;
      values: number[];
      min: number;
      max: number;
      last: string;
      marks: AsyncJobWidgetMark[];
      tone: AsyncJobWidgetTone | null;
    }
  | {
      kind: "bars";
      label: string;
      items: Array<{ label: string; value: number; text: string; tone: AsyncJobWidgetTone | null }>;
      max: number;
    }
  | { kind: "meter"; label: string; value: number; text: string; tone: AsyncJobWidgetTone | null }
  | { kind: "stat"; items: Array<{ label: string; text: string; trend: AsyncJobWidgetTrend | null }> }
  | { kind: "grid"; label: string; items: Array<{ label: string; text: string; tone: AsyncJobWidgetTone }> }
  | { kind: "text"; text: string };

/** omp's live job widget view (omp 18.12.3+, issue #954), reduced by the
 *  bridge: only a model-authored ("live") view ever reaches the wire. */
export interface AsyncJobWidget {
  title: string;
  headline: AsyncJobWidgetHeadline | null;
  stage: string | null;
  blocks: AsyncJobWidgetBlock[];
  /** Epoch ms of the view's last matched output; the HUD picks the freshest. */
  updatedAt: number;
}

export interface AsyncJob {
  /** omp's job id: `bg_N`, a task agent id, or a caller-chosen id. */
  id: string;
  /** omp's job type — "bash", "task", "eval", "advisor", "yield", … An open set. */
  type: string;
  status: AsyncJobStatus;
  label: string;
  command: string | null;
  cwd: string | null;
  /** Epoch ms. Doubles as the kill guard against omp's `bg_N` id reuse. */
  startTime: number;
  endTime: number | null;
  /** Set for task jobs: the subagent id the Agents roster uses. */
  agentId: string | null;
  /** omp's owning agent id (undefined in omp = no owner). Subagent jobs —
   *  a task child's own bash/task jobs — carry their parent's agent id, so
   *  the pane can nest them. Absent on v1 payloads: parsed as null. */
  ownerId: string | null;
  /** Live process ids; empty once the job stopped running. */
  pids: number[];
  exitCode: number | null;
  /** Last ASYNC_JOBS_OUTPUT_TAIL_CHARS of captured output, control chars stripped. */
  outputTail: string;
  outputTruncated: boolean;
  /** The running job's live widget (issue #954); null otherwise and on v1/v2 payloads. */
  widget: AsyncJobWidget | null;
  /** A running task subagent's own completion estimate, integer 0–100; null otherwise.
   *  omp only computes it in interactive mode, so rpc-ui sessions read null today. */
  completionPercent: number | null;
  /** A running task subagent's current step in its own words; null otherwise. */
  stage: string | null;
}

export interface AsyncJobsKillRequest {
  requestId: string;
  processKey: string;
  /** null = every running job (omp's `/jobs kill all`). */
  jobId: string | null;
  /** The targeted job's startTime; null exactly when jobId is null. */
  startTime: number | null;
}

export interface AsyncJobsKillResult {
  requestId: string;
  ok: boolean;
  cancelled: string[];
  text: string;
}

/** One agent node of getAsyncJobTree's `agents`: the session-root subagent
 *  roster edge omp reports for nesting jobs. All-or-nothing parse: a wrong
 *  member malformed the whole snapshot, matching readJobs' rule. */
export interface AsyncJobAgent {
  id: string;
  parentId: string | null;
}

/** The published envelope version (issues #868, #954). The bridge interpolates
 *  this constant so publisher and parser can never drift; v1 and v2 payloads —
 *  written by an older omp-ui's bridge against the same session — parse to v3
 *  with null widget, completionPercent, and stage (v1 also flat: no tree). */
export const ASYNC_JOBS_SNAPSHOT_VERSION = 3;

export interface AsyncJobsSnapshot {
  version: typeof ASYNC_JOBS_SNAPSHOT_VERSION;
  processKey: string;
  revision: number;
  available: boolean;
  unavailable: string | null;
  /** inspectAsyncJob exists: command/cwd/pids/exit/output are populated. */
  canInspect: boolean;
  /** cancelAsyncJob exists: kill affordances may render. */
  canCancel: boolean;
  running: AsyncJob[];
  recent: AsyncJob[];
  /** getAsyncJobTree's rootId: the session-root agent id. null on v1
   *  payloads and whenever the tree path was unavailable. */
  rootId: string | null;
  /** getAsyncJobTree's agents: every ancestor edge reachable from the
   *  listed jobs. Empty on v1 payloads — the pane renders a flat list. */
  agents: AsyncJobAgent[];
  /** Set only on the publish that answers a kill request. */
  result: AsyncJobsKillResult | null;
}

/** The bare arm prompt that binds the bridge and force-republishes. */
export function asyncJobsArmMessage(): string {
  return `/${ASYNC_JOBS_COMMAND}`;
}

/** The hidden kill prompt: `kill <json>` of an AsyncJobsKillRequest. */
export function asyncJobsKillMessage(request: AsyncJobsKillRequest): string {
  return `/${ASYNC_JOBS_COMMAND} ${ASYNC_JOBS_KILL_ARG} ${JSON.stringify(request)}`;
}

type WireVersion = 1 | 2 | typeof ASYNC_JOBS_SNAPSHOT_VERSION;

function asObject(value: unknown): Record<string, unknown> | null {
  return value === null || typeof value !== "object" || Array.isArray(value)
    ? null
    : (value as Record<string, unknown>);
}
function isWidgetText(value: unknown): value is string {
  return typeof value === "string" && value.length <= ASYNC_JOB_WIDGET_TEXT_LIMIT;
}
function isFilledText(value: unknown): value is string {
  return isWidgetText(value) && value !== "";
}
function isTone(value: unknown): value is AsyncJobWidgetTone {
  return typeof value === "string" && (ASYNC_JOB_WIDGET_TONES as readonly string[]).includes(value);
}
function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
function readToneOrNull(value: unknown): AsyncJobWidgetTone | null | undefined {
  if (value === null) return null;
  return isTone(value) ? value : undefined;
}
function readTrend(value: unknown): AsyncJobWidgetTrend | null | undefined {
  if (value === null) return null;
  const record = asObject(value);
  if (record === null) return undefined;
  const { text, tone } = record;
  return isFilledText(text) && isTone(tone) ? { text, tone } : undefined;
}
function readList<T>(value: unknown, read: (item: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value) || value.length > ASYNC_JOB_WIDGET_LIST_LIMIT) return undefined;
  const items: T[] = [];
  for (const raw of value) {
    const item = read(raw);
    if (item === undefined) return undefined;
    items.push(item);
  }
  return items;
}
function readMark(value: unknown): AsyncJobWidgetMark | undefined {
  const record = asObject(value);
  if (record === null) return undefined;
  const { value: at, label, tone } = record;
  return isFiniteNumber(at) && isWidgetText(label) && isTone(tone) ? { value: at, label, tone } : undefined;
}
function readBlock(value: unknown): AsyncJobWidgetBlock | undefined {
  const record = asObject(value);
  if (record === null) return undefined;
  switch (record.kind) {
    case "spark": {
      const { label, values, min, max, last, marks, tone } = record;
      const points = readList(values, (v) => (isFiniteNumber(v) ? v : undefined));
      const lines = readList(marks, readMark);
      const hue = readToneOrNull(tone);
      if (
        !isWidgetText(label) || points === undefined || points.length === 0 ||
        !isFiniteNumber(min) || !isFiniteNumber(max) || max <= min ||
        !isWidgetText(last) || lines === undefined || hue === undefined
      ) {
        return undefined;
      }
      return { kind: "spark", label, values: points, min, max, last, marks: lines, tone: hue };
    }
    case "bars": {
      const { label, items, max } = record;
      const rows = readList(items, (raw) => {
        const item = asObject(raw);
        if (item === null) return undefined;
        const { label: itemLabel, value, text } = item;
        const tone = readToneOrNull(item.tone);
        return isWidgetText(itemLabel) && isFiniteNumber(value) && isWidgetText(text) && tone !== undefined
          ? { label: itemLabel, value, text, tone }
          : undefined;
      });
      if (!isWidgetText(label) || rows === undefined || rows.length === 0 || !isFiniteNumber(max) || max <= 0) {
        return undefined;
      }
      return { kind: "bars", label, items: rows, max };
    }
    case "meter": {
      const { label, value, text, tone } = record;
      const hue = readToneOrNull(tone);
      if (!isWidgetText(label) || !isFiniteNumber(value) || value < 0 || value > 1 || !isWidgetText(text) || hue === undefined) {
        return undefined;
      }
      return { kind: "meter", label, value, text, tone: hue };
    }
    case "stat": {
      const rows = readList(record.items, (raw) => {
        const item = asObject(raw);
        if (item === null) return undefined;
        const { label, text } = item;
        const trend = readTrend(item.trend);
        return isWidgetText(label) && isWidgetText(text) && trend !== undefined ? { label, text, trend } : undefined;
      });
      return rows === undefined || rows.length === 0 ? undefined : { kind: "stat", items: rows };
    }
    case "grid": {
      const { label, items } = record;
      const cells = readList(items, (raw) => {
        const item = asObject(raw);
        if (item === null) return undefined;
        const { label: cellLabel, text, tone } = item;
        return isWidgetText(cellLabel) && isWidgetText(text) && isTone(tone) ? { label: cellLabel, text, tone } : undefined;
      });
      if (!isWidgetText(label) || cells === undefined || cells.length === 0) return undefined;
      return { kind: "grid", label, items: cells };
    }
    case "text": {
      const { text } = record;
      return isFilledText(text) ? { kind: "text", text } : undefined;
    }
    default:
      return undefined;
  }
}
function readHeadline(value: unknown): AsyncJobWidgetHeadline | null | undefined {
  if (value === null) return null;
  const record = asObject(value);
  if (record === null) return undefined;
  const { text, label } = record;
  const trend = readTrend(record.trend);
  if (!isFilledText(text) || !(label === null || isFilledText(label)) || trend === undefined) return undefined;
  return { text, label, trend };
}
function readWidget(value: unknown): AsyncJobWidget | null | undefined {
  if (value === null) return null;
  const record = asObject(value);
  if (record === null) return undefined;
  const { title, stage, blocks, updatedAt } = record;
  const headline = readHeadline(record.headline);
  if (!isFilledText(title) || !(stage === null || isFilledText(stage)) || !isFiniteNumber(updatedAt) || headline === undefined) {
    return undefined;
  }
  if (!Array.isArray(blocks) || blocks.length > ASYNC_JOB_WIDGET_BLOCK_LIMIT) return undefined;
  const read: AsyncJobWidgetBlock[] = [];
  for (const raw of blocks) {
    const block = readBlock(raw);
    if (block === undefined) return undefined;
    read.push(block);
  }
  // The bridge never publishes an empty widget; one on the wire is malformed.
  if (headline === null && read.length === 0 && stage === null) return undefined;
  return { title, headline, stage, blocks: read, updatedAt };
}

/** One wire job; null when any field is wrong. The wire is untrusted by definition. */
function readJob(value: unknown, version: WireVersion): AsyncJob | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { id, type, status, label, command, cwd, startTime, endTime, agentId, ownerId, pids, exitCode, outputTail, outputTruncated } =
    record;
  if (typeof id !== "string" || id === "") return null;
  if (typeof type !== "string" || type === "") return null;
  if (
    typeof status !== "string" ||
    !(ASYNC_JOB_STATUSES as readonly string[]).includes(status)
  ) {
    return null;
  }
  if (typeof label !== "string") return null;
  if (
    !(command === null || typeof command === "string") ||
    !(cwd === null || typeof cwd === "string") ||
    !(agentId === null || typeof agentId === "string") ||
    !(ownerId === undefined || ownerId === null || typeof ownerId === "string")
  ) {
    return null;
  }
  if (typeof startTime !== "number" || !Number.isFinite(startTime)) return null;
  if (!(endTime === null || (typeof endTime === "number" && Number.isFinite(endTime)))) return null;
  if (!Array.isArray(pids) || !pids.every((pid) => Number.isInteger(pid))) return null;
  if (!(exitCode === null || (typeof exitCode === "number" && Number.isFinite(exitCode)))) return null;
  if (typeof outputTail !== "string" || typeof outputTruncated !== "boolean") return null;
  const { widget, completionPercent, stage } = record;
  let liveWidget: AsyncJobWidget | null = null;
  let percent: number | null = null;
  let step: string | null = null;
  if (version === ASYNC_JOBS_SNAPSHOT_VERSION) {
    // v3 states every key; null is the absent value, a missing key is malformed.
    if (!("widget" in record) || !("completionPercent" in record) || !("stage" in record)) return null;
    const read = readWidget(widget);
    if (read === undefined) return null;
    liveWidget = read;
    if (completionPercent !== null) {
      if (typeof completionPercent !== "number" || !Number.isInteger(completionPercent) || completionPercent < 0 || completionPercent > 100) {
        return null;
      }
      percent = completionPercent;
    }
    if (stage !== null) {
      if (!isFilledText(stage)) return null;
      step = stage;
    }
  } else if (widget !== undefined || completionPercent !== undefined || stage !== undefined) {
    // An older envelope carrying v3 keys is a half-written hybrid (the #868 rule).
    return null;
  }
  return {
    id,
    type,
    status: status as AsyncJobStatus,
    label,
    command: command as string | null,
    cwd: cwd as string | null,
    startTime,
    endTime: endTime as number | null,
    agentId: agentId as string | null,
    // omp leaves ownerId undefined for unowned jobs; JSON drops the key.
    ownerId: ownerId === undefined ? null : (ownerId as string | null),
    pids: pids as number[],
    exitCode: exitCode as number | null,
    outputTail,
    outputTruncated,
    widget: liveWidget,
    completionPercent: percent,
    stage: step,
  };
}

/** One wire job list; null when the array or any member is wrong. */
function readJobs(value: unknown, version: WireVersion): AsyncJob[] | null {
  if (!Array.isArray(value)) return null;
  const jobs: AsyncJob[] = [];
  for (const raw of value) {
    const job = readJob(raw, version);
    if (job === null) return null;
    jobs.push(job);
  }
  return jobs;
}

/** The tree's agent roster; null when the array or any member is wrong. An
 *  absent list (v1 payload) reads as empty at the snapshot level, not here. */
function readAgents(value: unknown): AsyncJobAgent[] | null {
  if (!Array.isArray(value)) return null;
  const agents: AsyncJobAgent[] = [];
  for (const raw of value) {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const record = raw as Record<string, unknown>;
    const { id, parentId } = record;
    if (typeof id !== "string" || id === "") return null;
    if (!("parentId" in record) || !(parentId === null || typeof parentId === "string")) {
      return null;
    }
    agents.push({ id, parentId: parentId as string | null });
  }
  return agents;
}

/** null result is legal; a non-null value must be a complete result; undefined is malformed. */
function readResult(value: unknown): AsyncJobsKillResult | null | undefined {
  if (value === null) return null;
  if (value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { requestId, ok, cancelled, text } = record;
  if (typeof requestId !== "string" || requestId === "") return undefined;
  if (typeof ok !== "boolean" || typeof text !== "string") return undefined;
  if (!Array.isArray(cancelled) || !cancelled.every((id) => typeof id === "string")) return undefined;
  return { requestId, ok, cancelled: cancelled as string[], text };
}

/** Parses the JSON published on ASYNC_JOBS_STATUS_KEY; null when malformed in any part. */
export function parseAsyncJobsSnapshot(text: string | undefined): AsyncJobsSnapshot | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  // v1 (before the jobs tree, issue #868) and v2 (before live widgets, issue
  // #954) are stale bridges: legal on the wire of an older publish, mapped to
  // v3 — v1 flat, both with null live fields — so the pane renders today's list.
  const version = record.version;
  if (version !== 1 && version !== 2 && version !== ASYNC_JOBS_SNAPSHOT_VERSION) return null;
  const { processKey, revision, available, unavailable, canInspect, canCancel } = record;
  if (typeof processKey !== "string" || processKey === "") return null;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) return null;
  if (typeof available !== "boolean") return null;
  if (!(unavailable === null || typeof unavailable === "string")) return null;
  if (typeof canInspect !== "boolean" || typeof canCancel !== "boolean") return null;
  const running = readJobs(record.running, version);
  const recent = readJobs(record.recent, version);
  const result = readResult(record.result);
  if (running === null || recent === null || result === undefined) return null;
  let rootId: string | null = null;
  let agents: AsyncJobAgent[] = [];
  if (version !== 1) {
    const rawRootId = record.rootId;
    if (!(rawRootId === null || typeof rawRootId === "string")) return null;
    const rawAgents = readAgents(record.agents);
    if (rawAgents === null) return null;
    rootId = rawRootId as string | null;
    agents = rawAgents;
  } else if (record.rootId !== undefined || record.agents !== undefined) {
    // A v1 envelope that carries the v2 keys is a half-written hybrid, not a v1.
    return null;
  }
  return {
    version: ASYNC_JOBS_SNAPSHOT_VERSION,
    processKey,
    revision,
    available,
    unavailable: unavailable as string | null,
    canInspect,
    canCancel,
    running,
    recent,
    rootId,
    agents,
    result,
  };
}

/** One pane row: a job and its tree depth (0 = top level, issue #868). */
export interface AsyncJobRow {
  job: AsyncJob;
  depth: number;
}

/** internal layout node — mirrors omp's mP node shape. */
interface JobTreeNode {
  agent: AsyncJobAgent | null;
  job: AsyncJob | null;
  children: JobTreeNode[];
  size: number;
  running: boolean;
  startTime: number;
}

/**
 * The omp `/jobs` tree layout (issue #868), ported from the binary's `mP`
 * (verified byte-exact on omp/18.11.1): agent nodes from the wire roster,
 * each featuring one job (running beats a non-running feature; a newer job
 * replaces an older non-running feature); every other job hangs off its
 * owner's node, else depth 0; siblings sort branchiest-first, then running,
 * then oldest start. A cycle in the agent parent chain means the untrusted
 * wire is malformed: fall back to today's flat order (running, then recent),
 * never a partial tree. A node whose spawning task job was evicted has no
 * featured job to render; its children take its depth so nothing orphans.
 */
export function buildAsyncJobRows(
  running: readonly AsyncJob[],
  recent: readonly AsyncJob[],
  agents: readonly AsyncJobAgent[],
  rootId: string | null,
): AsyncJobRow[] {
  const flat = (): AsyncJobRow[] => [...running, ...recent].map((job) => ({ job, depth: 0 }));
  const nodes = new Map<string, JobTreeNode>();
  for (const agent of agents) {
    if (agent.id === rootId) continue;
    if (!nodes.has(agent.id)) {
      nodes.set(agent.id, { agent, job: null, children: [], size: 0, running: false, startTime: Infinity });
    }
  }
  // Cycle guard over the untrusted parent chain: any revisit flattens.
  for (const node of nodes.values()) {
    const seen = new Set<string>([node.agent!.id]);
    let parentId = node.agent!.parentId;
    while (parentId !== null) {
      if (seen.has(parentId)) return flat();
      seen.add(parentId);
      parentId = nodes.get(parentId)?.agent?.parentId ?? null;
    }
  }
  const jobs = [...running, ...recent];
  // Featured-job pass: a task job features the node for the agent it spawned.
  for (const job of jobs) {
    if (job.agentId === null) continue;
    const node = nodes.get(job.agentId);
    if (node === undefined) continue;
    const featured = node.job;
    if (featured === null || (featured.status !== "running" && (job.status === "running" || job.startTime > featured.startTime))) {
      node.job = job;
    }
  }
  // Agent nodes nest under their parent's node; unknown parents (the excluded
  // root, an off-roster id) land top-level — omp's `?? d` rule.
  const top: JobTreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.agent!.parentId === null ? undefined : nodes.get(node.agent!.parentId);
    if (parent === undefined) top.push(node);
    else parent.children.push(node);
  }
  // Unfeatured jobs hang off their owner's node, else top-level.
  for (const job of jobs) {
    if (job.agentId !== null && nodes.get(job.agentId)?.job === job) continue;
    const owner = job.ownerId === null || job.ownerId === rootId ? undefined : nodes.get(job.ownerId);
    const container = owner === undefined ? top : owner.children;
    container.push({ agent: null, job, children: [], size: 0, running: false, startTime: Infinity });
  }
  // Bottom-up measure + prune + sibling sort over the BFS pre-order (omp's `u`):
  // reverse pre-order visits every child before its parent. The top list keeps
  // omp's insertion order — mP sorts only nested children lists.
  const all: JobTreeNode[] = [];
  const stack = [...top];
  while (stack.length > 0) {
    const node = stack.pop()!;
    all.push(node);
    stack.push(...node.children);
  }
  const orderChildren = (list: JobTreeNode[]): void => {
    const kept = list.filter((node) => node.job !== null || node.children.length > 0);
    list.splice(0, list.length, ...kept);
    kept.sort(
      (a, b) => b.size - a.size || Number(!a.running) - Number(!b.running) || a.startTime - b.startTime,
    );
  };
  for (let i = all.length - 1; i >= 0; i--) {
    const node = all[i]!;
    orderChildren(node.children);
    node.size = 0;
    node.running = node.job !== null && node.job.status === "running";
    node.startTime = node.job?.startTime ?? Infinity;
    for (const child of node.children) {
      node.size += 1 + child.size;
      node.running ||= child.running;
      node.startTime = Math.min(node.startTime, child.startTime);
    }
  }
  // DFS emit; a job-less scaffold agent node renders no row and passes its
  // depth to its children (the pane has no agent rows, issue #868).
  const rows: AsyncJobRow[] = [];
  const emit = (list: readonly JobTreeNode[], depth: number): void => {
    for (const node of list) {
      if (node.job !== null) rows.push({ job: node.job, depth });
      emit(node.children, node.job === null ? depth : depth + 1);
    }
  };
  emit(
    top.filter((node) => node.job !== null || node.children.length > 0),
    0,
  );
  return rows;
}
