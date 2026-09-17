import * as fs from "node:fs";
import * as path from "node:path";
import { getOmpAgentDir } from "./omp-config";

/**
 * Agent-name discovery for the subagent-model roster (ADR-0031). omp matches
 * `task.agentModelOverrides` keys case-sensitively against the agent's
 * frontmatter `name:`, so names are read from frontmatter, falling back to
 * the file basename. Discovery is on demand (the settings surfaces refresh
 * it), never on the spawn path.
 */

/** Reads the frontmatter `name:` of one agent file; null when absent. */
function frontmatterName(text: string): string | null {
  if (!text.startsWith("---")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const head = text.slice(3, end);
  for (const line of head.split(/\r?\n/)) {
    const match = /^name:\s*("?)([^\s"]+)\1\s*$/.exec(line.trim());
    if (match) return match[2] ?? null;
  }
  return null;
}

/** Agent names declared by the `.md` files directly under `dir`. */
function agentNamesInDir(dir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const file = path.join(dir, entry.name);
    let name: string | null = null;
    try {
      name = frontmatterName(fs.readFileSync(file, "utf8"));
    } catch {
      // Unreadable file: fall back to the basename below.
    }
    names.push(name ?? entry.name.slice(0, -".md".length));
  }
  return names;
}

/** Names from `<agentDir>/agents` + `<cwd>/.omp/agents`, deduped, sorted. */
export function discoverAgentNames(
  projectCwd: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const dirs = [path.join(getOmpAgentDir(env), "agents")];
  if (projectCwd !== null) dirs.push(path.join(projectCwd, ".omp", "agents"));
  const names = new Set<string>();
  for (const dir of dirs) {
    for (const name of agentNamesInDir(dir)) names.add(name);
  }
  return [...names].sort();
}

/** Bundled names from a prior `omp agents unpack --dir`; [] when unknown. */
export function parseUnpackedAgentNames(dir: string): string[] {
  return agentNamesInDir(dir).sort();
}
