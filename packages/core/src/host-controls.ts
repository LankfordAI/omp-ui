// Remote host controls (issue #1272, omp 19.1): the RPC-host verbs an omp-ui
// client sends into a session it does not own — continue a parked run,
// interrupt-and-deliver the queued input, and drive omp's own model picker
// (`get_model_picker` → `set_model`, thinking steps included). Pure module:
// frame construction, tolerant response parsing, and the version gate; the
// subprocess transport stays in the desktop packages (ADR-0002).
//
// Older runtimes REJECT every verb here with a failure response. The gate is
// the honest first filter; the renderer additionally latches the refusal
// ("Unknown command") so a host that misreports its version degrades to a
// disabled control — never to a fallback verb like `prompt`/`steer`, which
// would duplicate queued work (omp docs/rpc.md).
import { compareVersions } from "./semver";
import { isObject } from "./guards";

/** First omp with `resume`, `abort_and_deliver_queue`, and `get_model_picker`. */
export const HOST_CONTROLS_MIN_OMP = "19.1.0";

/** Unknown version hides the control: an older runtime rejects the verb. */
export function supportsHostControls(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, HOST_CONTROLS_MIN_OMP) >= 0;
}

// `resume` and `abort_and_deliver_queue` carry no payload; the command union
// in session-command.ts types them as plain `{ type }` frames. omp semantics
// (docs/rpc.md v19.1.0): `resume` is the TUI's `.`/`c` continue — a running
// turn is interrupted first, and queued input continues the run instead of
// the continue directive; it fails `Nothing to resume` with no conversation.
// `abort_and_deliver_queue` is the TUI's empty Enter — interrupt a streaming
// run that has queued input and continue it with that input, answering
// `aborted: false` (no-op) when nothing is streaming or queued.

/** `{ type: "get_model_picker", query?, limit? }` — omp's alt+p picker served
 *  to any client. Blank `query` browses Recent-first; `provider/` filters;
 *  `@` lists the ctrl+p quick roles. */
export function modelPickerCommand(
  query?: string,
  limit?: number,
): { readonly type: "get_model_picker"; readonly query?: string; readonly limit?: number } {
  return {
    type: "get_model_picker",
    ...(query === undefined || query === "" ? {} : { query }),
    ...(limit === undefined ? {} : { limit }),
  };
}

/** A quick role a picker row chips, in omp's built-in order. */
export interface ModelPickerRole {
  role: string;
  /** The role's display tag. */
  label: string;
  /** Auto-selected: the role has no configured model. */
  auto?: boolean;
}

/**
 * One `get_model_picker` row (upstream `RpcModelPickerRow`, rpc-model-picker.ts
 * at v19.1.0). A quick-role row carries `role`, which `set_model` takes back;
 * a model row's `thinking` lists its slider steps low→high with `thinkingLevel`
 * the level this session would run it at.
 */
export interface ModelPickerRow {
  provider: string;
  id: string;
  name: string;
  role?: string;
  roles?: ModelPickerRole[];
  /** Slider steps low→high; absent when the model has no effort to pick. */
  thinking?: string[];
  thinkingLevel?: string;
  /** The session's context exceeds this model's window. */
  overContext?: boolean;
  /** This session runs this row (its model, or under `@` its active role). */
  current?: boolean;
}

/** `get_model_picker` result. */
export interface ModelPickerResult {
  rows: ModelPickerRow[];
  /** Leading rows in the Recent block; 0 when there is no such split. */
  recent: number;
  /** Matching rows before the limit. */
  total: number;
}

/** The `set_model` frame for one picker pick; `role` rides only from a role
 *  row, and `thinkingLevel` only when the pick carries an explicit level
 *  (docs/rpc.md: `set_model` takes both alongside provider/modelId). */
export function setModelFromRowCommand(
  row: ModelPickerRow,
  thinkingLevel?: string,
): {
  readonly type: "set_model";
  readonly provider: string;
  readonly modelId: string;
  readonly role?: string;
  readonly thinkingLevel?: string;
} {
  return {
    type: "set_model",
    provider: row.provider,
    modelId: row.id,
    ...(row.role === undefined ? {} : { role: row.role }),
    ...(thinkingLevel === undefined || thinkingLevel === "" ? {} : { thinkingLevel }),
  };
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function parsePickerRole(value: unknown): ModelPickerRole | null {
  if (!isObject(value)) return null;
  const role = optionalString(value.role);
  const label = optionalString(value.label);
  if (role === undefined || label === undefined) return null;
  const auto = optionalBoolean(value.auto);
  return { role, label, ...(auto === true ? { auto: true } : {}) };
}

/** Parses one picker row; a row missing provider/id/name is dropped — it
 *  could not be sent back to `set_model` and would render as blank. */
function parsePickerRow(value: unknown): ModelPickerRow | null {
  if (!isObject(value)) return null;
  const provider = optionalString(value.provider);
  const id = optionalString(value.id);
  if (provider === undefined || id === undefined) return null;
  const role = optionalString(value.role);
  const thinkingLevel = optionalString(value.thinkingLevel);
  const roles = Array.isArray(value.roles)
    ? value.roles.map(parsePickerRole).filter((r): r is ModelPickerRole => r !== null)
    : undefined;
  const thinking = Array.isArray(value.thinking)
    ? value.thinking.filter((s): s is string => typeof s === "string" && s !== "")
    : undefined;
  const overContext = optionalBoolean(value.overContext);
  const current = optionalBoolean(value.current);
  return {
    provider,
    id,
    name: typeof value.name === "string" ? value.name : id,
    ...(role === undefined ? {} : { role }),
    ...(roles !== undefined && roles.length > 0 ? { roles } : {}),
    ...(thinking !== undefined && thinking.length > 0 ? { thinking } : {}),
    ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    ...(overContext === true ? { overContext: true } : {}),
    ...(current === true ? { current: true } : {}),
  };
}

/**
 * Parses a decoded `get_model_picker` response payload. Tolerant by contract
 * (same posture as the collab listing): malformed rows drop, missing scalars
 * default (`recent` 0, `total` the returned-row count — never an inflated
 * "N more" claim); a payload without a `rows` array is not a picker result.
 */
export function parseModelPickerResult(value: unknown): ModelPickerResult | null {
  if (!isObject(value) || !Array.isArray(value.rows)) return null;
  const rows = value.rows.map(parsePickerRow).filter((r): r is ModelPickerRow => r !== null);
  const recent = typeof value.recent === "number" && Number.isFinite(value.recent)
    ? Math.max(0, Math.min(Math.trunc(value.recent), rows.length))
    : 0;
  const total = typeof value.total === "number" && Number.isFinite(value.total)
    ? Math.max(rows.length, Math.trunc(value.total))
    : rows.length;
  return { rows, recent, total };
}

/** Parses the `abort_and_deliver_queue` payload's `aborted` flag; null when
 *  the response carries no usable answer (the caller says nothing). */
export function parseDeliverQueueResult(value: unknown): boolean | null {
  if (!isObject(value)) return null;
  return typeof value.aborted === "boolean" ? value.aborted : null;
}
