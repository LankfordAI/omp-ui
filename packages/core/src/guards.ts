/**
 * The package's canonical object guard (the web build imports it through the
 * pure subpaths; rpc/codec re-exports it for the node side). Narrows to
 * `Record<string, unknown>` — fields stay `unknown` for per-field checks.
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
