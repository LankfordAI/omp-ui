/** Defensive reads over `unknown` protocol payloads (renderer components). */
export function field(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== "object" || !(key in obj)) return undefined;
  // Guarded by `key in obj` above; TS can't narrow indexing with a variable key.
  const record = obj as Record<string, unknown>;
  return record[key];
}

export function strField(obj: unknown, key: string): string | undefined {
  const value = field(obj, key);
  return typeof value === "string" ? value : undefined;
}

export function numField(obj: unknown, key: string): number | undefined {
  const value = field(obj, key);
  return typeof value === "number" ? value : undefined;
}

export function boolField(obj: unknown, key: string): boolean | undefined {
  const value = field(obj, key);
  return typeof value === "boolean" ? value : undefined;
}

/** Absent or non-array reads as empty — callers iterate without a guard. */
export function arrField(obj: unknown, key: string): unknown[] {
  const value = field(obj, key);
  return Array.isArray(value) ? value : [];
}
