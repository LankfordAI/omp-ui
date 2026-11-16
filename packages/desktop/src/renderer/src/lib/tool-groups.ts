import { strField } from "./fields";
import type { ToolItem } from "./transcript";

/**
 * Tool groups (issue #1186): back-to-back read-only lookups from one assistant
 * message fold into one card. Pure and React-free; the transcript decides
 * where a group starts and ends, this module decides which calls may join.
 */
export type ToolGroupCategory = "read" | "search" | "web" | "vault";

/** Exact tool names that fold into a tool group. Add a name here to group it. */
const CATEGORY_BY_NAME: Readonly<Record<string, ToolGroupCategory>> = {
  read: "read",
  grep: "search",
  glob: "search",
  find: "search",
  ast_grep: "search",
  web_search: "web",
  "omp-ui_vault_search": "vault",
  "omp-ui_vault_read": "vault",
  "omp-ui_vault_list": "vault",
};

/** Own-key lookup, so a tool named like an Object.prototype member never matches. */
function categoryOf(name: string): ToolGroupCategory | undefined {
  return Object.hasOwn(CATEGORY_BY_NAME, name) ? CATEGORY_BY_NAME[name] : undefined;
}

/** The file a tool call names, under any of the arg keys tools use for it. */
export function pathFromArgs(args: unknown): string | undefined {
  return strField(args, "path") ?? strField(args, "file_path") ?? strField(args, "file");
}

/**
 * Category of a call that may join a tool group; null when it must render
 * alone. Anything that needs attention (a failure, notes, images, replies)
 * stays its own card, mirroring ToolCard's "unresolved stays open" rule.
 */
export function toolGroupCategory(item: ToolItem): ToolGroupCategory | null {
  const category = categoryOf(item.name);
  if (category === undefined) return null;
  if (item.status !== "running" && item.status !== "done") return null;
  if ((item.notes?.length ?? 0) > 0) return null;
  if ((item.images?.length ?? 0) > 0) return null;
  if ((item.providerFailures?.length ?? 0) > 0) return null;
  if (item.replies !== undefined || item.artifactCapture !== undefined) return null;
  return category;
}

/** One omp line range: `50`, `50-`, `50-80`, `50+10`, `-60`. */
const RANGE = String.raw`-?\d+(?:[-+]\d*)?`;
/** One selector segment: a keyword or a comma list of ranges. */
const SEGMENT = `(?:raw|conflicts|img|${RANGE}(?:,${RANGE})*)`;
/** One or two trailing segments: `:194-215`, `:raw`, `:2-4:raw`, `:raw:2-4`, `:5-16,960-973`. */
const READ_SELECTOR_RE = new RegExp(`(?::${SEGMENT}){1,2}$`);

/**
 * The file a read names, without its trailing selector: the distinct-file key.
 * Query-bearing paths (`?`) and selectors inside a URL authority (`https://host:8080`)
 * are left whole, so a URL port or a jq expression is never mistaken for a range.
 */
export function readPathKey(path: string): string {
  if (path.includes("?")) return path;
  const match = READ_SELECTOR_RE.exec(path);
  if (match === null) return path;
  const scheme = path.indexOf("://");
  if (scheme !== -1) {
    const pathStart = path.indexOf("/", scheme + 3);
    if (pathStart === -1 || match.index < pathStart) return path;
  }
  return path.slice(0, match.index);
}

export interface ToolGroupCount {
  category: ToolGroupCategory;
  count: number;
}

/** Per-category counts in first-appearance order; reads count distinct files. */
export function toolGroupCounts(items: readonly ToolItem[]): ToolGroupCount[] {
  const order: ToolGroupCategory[] = [];
  const calls = new Map<ToolGroupCategory, number>();
  const files = new Set<string>();
  for (const item of items) {
    const category = categoryOf(item.name);
    if (category === undefined) continue;
    if (!calls.has(category)) order.push(category);
    calls.set(category, (calls.get(category) ?? 0) + 1);
    if (category === "read") {
      const path = pathFromArgs(item.args) ?? item.path;
      files.add(path === undefined ? `id:${item.id}` : readPathKey(path));
    }
  }
  return order.map((category) => ({
    category,
    count: category === "read" ? files.size : calls.get(category)!,
  }));
}
