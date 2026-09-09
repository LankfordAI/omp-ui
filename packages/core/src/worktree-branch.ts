// Worktree branch naming (issues #405, #428, #438). Pure — zero imports —
// because the renderer imports it directly via the
// @omp-ui/core/worktree-branch subpath, exactly like remote-instances.ts.
// The node half (checkout creation, the CSPRNG mint hash) stays in
// worktree.ts and consumes these same rules, so the two sides of the name
// can never drift.

/** The mint tail: 8 lowercase hex, the only part of a worktree branch no human chose. */
const MINT_TAIL_RE = /^[0-9a-f]{8}$/;

/**
 * One slug rule for project names: lowercased, runs of non-alphanumerics
 * collapsed to dashes, capped at 32 chars, "project" when nothing usable is
 * left. Shared by the lineage dir name, the worktree slot directory, and the
 * branch prefix (paths.ts:projectSlug delegates here).
 */
export function slugifyProjectName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "project";
}

/**
 * The first segment of a worktree branch: the project's own name. Splits on
 * both separators so a Windows path resolves the same way under a posix Node
 * (path.basename would not), and degenerate input yields "project".
 */
export function worktreeBranchPrefix(projectCwd: string): string {
  const segments = projectCwd.split(/[\\/]+/).filter((part) => part !== "");
  return slugifyProjectName(segments[segments.length - 1] ?? "");
}

/**
 * The sanitised middle segment: the branch the session was cut from.
 * Precedence is the new base branch being created, then the picked base ref,
 * then the checkout's active branch — which is exactly what addWorktree
 * records as the base when no ref is picked (worktree.ts:146-156), so the
 * name and the record always agree. Null only when nothing names a branch: a
 * detached HEAD, or a repository with no branches yet. Case is preserved — a
 * ticket key is the segment users read (sanitizeBranchName is for model
 * output and lowercases; this is not it).
 */
export function baseBranchSegment(
  baseBranch: string | null,
  baseRef: string | null,
  currentBranch: string | null,
): string | null {
  const raw = [baseBranch, baseRef, currentBranch]
    .map((value) => (value ?? "").trim())
    .find((value) => value !== "");
  if (raw === undefined) return null;
  const segments = raw
    .split("/")
    .map((s) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32))
    .filter((s) => s !== "");
  return segments.length === 0 ? null : segments.join("/").slice(0, 64);
}

/** The one composition rule: `<prefix>/[<segment>/]<hash>`. */
export function composeWorktreeBranch(
  prefix: string,
  segment: string | null,
  hash: string,
): string {
  return segment === null ? `${prefix}/${hash}` : `${prefix}/${segment}/${hash}`;
}

/**
 * A minted name no human chose: this project's prefix, an optional run of
 * base segments, then the 8-hex mint. Only these are recomposed when the base
 * changes, and only these pre-fill the finish dialog's rename field; a
 * user-typed name is never touched. A mint made under a different project's
 * prefix is not one of ours and is left alone.
 */
export function isMintedWorktreeBranch(branch: string, prefix: string): boolean {
  const parts = branch.split("/");
  return (
    parts.length >= 2 && parts[0] === prefix && MINT_TAIL_RE.test(parts[parts.length - 1]!)
  );
}

/**
 * Follows the base while the name is still a mint: the hash survives, so the
 * checkout slot's slug stays recognisable across base edits, and a hand-typed
 * branch is returned untouched.
 */
export function remintWorktreeBranch(
  branch: string,
  prefix: string,
  segment: string | null,
): string {
  if (!isMintedWorktreeBranch(branch, prefix)) return branch;
  return composeWorktreeBranch(prefix, segment, branch.slice(branch.lastIndexOf("/") + 1));
}
