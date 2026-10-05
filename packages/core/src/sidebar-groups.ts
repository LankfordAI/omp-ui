/** Longest sidebar group name, after normalization (CONTEXT.md "Sidebar group"). */
export const SIDEBAR_GROUP_NAME_MAX_LENGTH = 64;

/** Trimmed, whitespace-collapsed name, or null when empty or too long. */
export function normalizeSidebarGroupName(raw: string): string | null {
  const name = raw.trim().replace(/\s+/g, " ");
  return name.length === 0 || name.length > SIDEBAR_GROUP_NAME_MAX_LENGTH ? null : name;
}
