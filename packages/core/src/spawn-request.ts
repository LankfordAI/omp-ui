import type {
  PlanImplementationSource,
  SessionWorktree,
  SpawnRequest,
  SpawnWorktree,
} from "./types";

type ObjectValue = Record<string, unknown>;
function hasOwn(value: ObjectValue, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

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

function requiredString(value: ObjectValue, key: string, label = "spawn request"): string {
  const field = value[key];
  if (typeof field !== "string" || field.length === 0) {
    throw new Error(`${label}.${key} must be a non-empty string`);
  }
  return field;
}

function optionalNullableString(value: ObjectValue, key: string): string | null | undefined {
  if (!hasOwn(value, key)) return undefined;
  const field = value[key];
  if (field !== null && typeof field !== "string") {
    throw new Error(`spawn request.${key} must be a string or null`);
  }
  return field;
}

function requiredBoolean(value: ObjectValue, key: string): boolean {
  const field = value[key];
  if (typeof field !== "boolean") throw new Error(`spawn request.${key} must be a boolean`);
  return field;
}

function optionalBoolean(value: ObjectValue, key: string): boolean | undefined {
  if (!hasOwn(value, key)) return undefined;
  const field = value[key];
  if (typeof field !== "boolean") throw new Error(`spawn request.${key} must be a boolean`);
  return field;
}

function finiteNumber(value: ObjectValue, key: "cols" | "rows"): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isFinite(field)) {
    throw new Error(`spawn request.${key} must be a finite number`);
  }
  return field;
}

function parsePlanImplementationSource(value: unknown): PlanImplementationSource {
  const source = objectValue(value, "spawn request.planImplementationSource");
  rejectUnknownKeys(
    source,
    ["sourceTabId", "planTitle", "planFilePath"],
    "spawn request.planImplementationSource",
  );
  return {
    sourceTabId: requiredString(source, "sourceTabId", "spawn request.planImplementationSource"),
    planTitle: requiredString(source, "planTitle", "spawn request.planImplementationSource"),
    planFilePath: requiredString(source, "planFilePath", "spawn request.planImplementationSource"),
  };
}

function parseSessionWorktree(value: unknown): SessionWorktree {
  const reuse = objectValue(value, "spawn request.worktree.reuse");
  rejectUnknownKeys(reuse, ["path", "branch", "base"], "spawn request.worktree.reuse");
  const base = reuse.base;
  if (base !== null && typeof base !== "string") {
    throw new Error("spawn request.worktree.reuse.base must be a string or null");
  }
  return {
    path: requiredString(reuse, "path", "spawn request.worktree.reuse"),
    branch: requiredString(reuse, "branch", "spawn request.worktree.reuse"),
    base,
  };
}

function parseWorktree(value: unknown): SpawnWorktree {
  if (value === null) return null;
  const worktree = objectValue(value, "spawn request.worktree");
  rejectUnknownKeys(worktree, ["mint", "reuse"], "spawn request.worktree");
  const hasMint = hasOwn(worktree, "mint");
  const hasReuse = hasOwn(worktree, "reuse");
  if (hasMint === hasReuse) {
    throw new Error("spawn request.worktree must contain exactly one of mint or reuse");
  }
  if (hasReuse) return { reuse: parseSessionWorktree(worktree.reuse) };

  const mint = objectValue(worktree.mint, "spawn request.worktree.mint");
  rejectUnknownKeys(mint, ["branch", "baseRef"], "spawn request.worktree.mint");
  const baseRef = mint.baseRef;
  if (baseRef !== null && typeof baseRef !== "string") {
    throw new Error("spawn request.worktree.mint.baseRef must be a string or null");
  }
  return {
    mint: {
      branch: requiredString(mint, "branch", "spawn request.worktree.mint"),
      baseRef,
    },
  };
}

const NEW_KEYS = [
  "origin",
  "mode",
  "projectCwd",
  "advisor",
  "advisorModel",
  "cols",
  "rows",
  "worktree",
  "planImplementationSource",
  "planMode",
] as const;

const RESUME_KEYS = [
  "origin",
  "resumeTabId",
  "cols",
  "rows",
  "mode",
  "advisor",
  "advisorModel",
  "planMode",
] as const;

/** Parse and structurally validate a spawn request received from either wire transport. */
export function parseSpawnRequest(raw: unknown): SpawnRequest {
  const value = objectValue(raw, "spawn request");
  const origin = value.origin;
  if (origin !== "new" && origin !== "resume") {
    throw new Error("spawn request.origin must be new or resume");
  }

  const cols = finiteNumber(value, "cols");
  const rows = finiteNumber(value, "rows");
  if (origin === "resume") {
    rejectUnknownKeys(value, RESUME_KEYS, "spawn request");
    const mode = value.mode;
    if (mode !== undefined && mode !== "pty" && mode !== "rpc-ui") {
      throw new Error("spawn request.mode must be pty or rpc-ui");
    }
    const planMode = optionalBoolean(value, "planMode");
    if (mode === "pty" && planMode !== undefined) {
      throw new Error("spawn request.planMode is not valid for pty mode");
    }
    const advisor = optionalBoolean(value, "advisor");
    const advisorModel = optionalNullableString(value, "advisorModel");
    const common = {
      origin: "resume" as const,
      resumeTabId: requiredString(value, "resumeTabId"),
      cols,
      rows,
      ...(advisor === undefined ? {} : { advisor }),
      ...(advisorModel === undefined ? {} : { advisorModel }),
    };
    if (mode === "pty") return { ...common, mode };
    return {
      ...common,
      ...(mode === undefined ? {} : { mode }),
      ...(planMode === undefined ? {} : { planMode }),
    };
  }

  rejectUnknownKeys(value, NEW_KEYS, "spawn request");
  const mode = value.mode;
  if (mode !== "pty" && mode !== "rpc-ui") {
    throw new Error("spawn request.mode must be pty or rpc-ui");
  }
  const advisorModel = optionalNullableString(value, "advisorModel");
  const planMode = optionalBoolean(value, "planMode");
  if (mode === "pty" && planMode !== undefined) {
    throw new Error("spawn request.planMode is not valid for pty mode");
  }
  const source = hasOwn(value, "planImplementationSource")
    ? value.planImplementationSource === null
      ? null
      : parsePlanImplementationSource(value.planImplementationSource)
    : undefined;
  const common = {
    origin: "new" as const,
    projectCwd: requiredString(value, "projectCwd"),
    advisor: requiredBoolean(value, "advisor"),
    cols,
    rows,
    worktree: parseWorktree(value.worktree),
    ...(advisorModel === undefined ? {} : { advisorModel }),
    ...(source === undefined ? {} : { planImplementationSource: source }),
  };
  return mode === "pty"
    ? { ...common, mode }
    : { ...common, mode, ...(planMode === undefined ? {} : { planMode }) };
}
