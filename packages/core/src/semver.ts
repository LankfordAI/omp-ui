export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/** Parses an optional `v`-prefixed `X.Y.Z` (extra segments ignored). */
export function parseSemver(value: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** -1 when a < b, 0 when equal, 1 when a > b. Unparseable sorts lowest. */
export function compareVersions(a: string, b: string): number {
  const A = parseSemver(a);
  const B = parseSemver(b);
  if (!A && !B) return 0;
  if (!A) return -1;
  if (!B) return 1;
  for (const key of ["major", "minor", "patch"] as const) {
    if (A[key] !== B[key]) return A[key] < B[key] ? -1 : 1;
  }
  return 0;
}
