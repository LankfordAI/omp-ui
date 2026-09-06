import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CAPABILITY_DESCRIPTION_LIMIT } from "./capabilities";
import {
  CUSTOM_SKILLS_PRIORITY,
  SKILL_GATE_DEFAULTS,
  SKILL_GATE_KEYS,
  SKILL_SOURCES,
  TOOL_ENABLED_KEYS,
} from "./omp-capability-keys";
import { getOmpAgentDir } from "./omp-config";
import {
  execOmpConfigRunner,
  readOmpSettings,
  writeOmpSetting,
  type OmpConfigRunner,
} from "./omp-settings";
import { readProjectConfigValue, setProjectConfigValue } from "./project-config-writer";
import type {
  OmpSettingEntry,
  ScopedCapabilitiesResult,
  ScopedCapabilityMutation,
  SkillCatalogEntry,
  SkillRootInfo,
  SkillsAtScope,
  ToolsAtScope,
} from "./types";

/**
 * The capability CATALOGS (issue #383, ADR-0025): config truth resolved at a
 * scope — global (`scopeCwd: null`) or one working tree — answering "what can
 * omp load here?", never "what did a session load". The live session's roster
 * (bridge truth, #374) stays in the session-pinned viewer; this module never
 * imitates it, spawns omp as a session, or connects to anything. It reads:
 *
 * - Skills: SKILL.md files under omp's discovery roots (the version-pinned
 *   table in omp-capability-keys.ts), gated and glob-filtered by the same
 *   `skills.*` values omp applies at load, deduped by name in omp's precedence
 *   order — and, like the MCP resolution, a shadowed loser still renders,
 *   labeled, because a disabled winner is visible suppression, not absence.
 * - Tools: the `<tool>.enabled` gates over the settings layers omp's own
 *   `config list --json` publishes (`readOmpSettings`, one call, feeds both).
 *
 * Writes route by scope and never across it: global scope goes through
 * `omp config set` (omp validates the value itself); project scope goes
 * through the line-preserving editor in project-config-writer.ts, because omp
 * has no project-layer verb. Every validation check runs before any spawn or
 * write — a mutation naming an unknown tool or gate key throws outright, the
 * `writeOmpSetting` allowlist pattern extended, not a UI filter.
 */

/** Per-SKILL.md head read; frontmatter lives at the top, the body is never shown. */
const HEAD_BYTES = 64 * 1024;
/** Hard cap on SKILL.md files examined per result; tripping it says so. */
const MAX_SKILL_FILES = 500;
/** Guard for the project-root walk-up (omp walks to the repo root, not forever). */
const MAX_WALK_UP = 64;

interface SettingsView {
  has(key: string): boolean;
  value(key: string): unknown;
  layer(key: string): OmpSettingEntry["layer"];
}

function settingsView(entries: readonly OmpSettingEntry[]): SettingsView {
  const byKey = new Map(entries.map((entry) => [entry.key, entry]));
  return {
    has: (key) => byKey.has(key),
    value: (key) => byKey.get(key)?.value,
    layer: (key) => byKey.get(key)?.layer ?? "default",
  };
}

function boolOf(settings: SettingsView, key: string): boolean {
  const value = settings.value(key);
  if (typeof value === "boolean") return value;
  return SKILL_GATE_DEFAULTS[key] === true;
}

function stringsOf(settings: SettingsView, key: string): string[] {
  const value = settings.value(key);
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * The subset of omp's glob syntax (Bun.Glob) that is meaningful for a skill
 * NAME: `*` within a segment, `**` across segments, `?` for one character;
 * everything else is literal. Skill names are kebab-case, so classes and
 * braces would never fire there.
 */
export function matchSkillGlob(pattern: string, name: string): boolean {
  let re = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i += 1;
        if (pattern[i + 1] === "/") i += 1;
      } else {
        re += "[^/]*";
      }
      continue;
    }
    if (char === "?") {
      re += "[^/]";
      continue;
    }
    re += char.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  }
  try {
    return new RegExp(`^(?:${re})$`, "u").test(name);
  } catch {
    return false;
  }
}

function expandTilde(dir: string, home: string): string {
  if (dir === "~") return home;
  if (dir.startsWith("~/") || dir.startsWith("~\\")) return path.join(home, dir.slice(2));
  return path.resolve(dir);
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** cwd and its ancestors through the nearest `.git` root or home — omp's walk-up bound. */
async function walkUpToRoot(cwd: string, home: string): Promise<string[]> {
  const dirs: string[] = [];
  let current = cwd;
  for (let depth = 0; depth < MAX_WALK_UP; depth += 1) {
    if (current !== home) dirs.push(current);
    if (current === home || path.dirname(current) === current) break;
    if (await isDirectory(path.join(current, ".git"))) break;
    current = path.dirname(current);
  }
  return dirs;
}

interface Frontmatter {
  name?: string;
  description?: string;
  hide?: boolean;
  disableModelInvocation?: boolean;
  enabled?: boolean;
}

/** The SKILL.md frontmatter fields omp's scanner reads, from a head slice. */
function parseFrontmatter(text: string): Frontmatter {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return {};
  const out: Frontmatter = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (line.trim() === "---" || line.trim() === "...") break;
    if (/^\S/.test(line) && line.includes(":")) {
      const colon = line.indexOf(":");
      const key = line.slice(0, colon).trim();
      let value = line.slice(colon + 1).trim();
      const hash = findCommentStart(value);
      if (hash >= 0) value = value.slice(0, hash).trim();
      const unquoted =
        value.length >= 2 &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
          ? value.slice(1, -1)
          : value;
      if (key === "name" || key === "description") {
        if (out[key] === undefined) out[key] = unquoted;
      } else if (key === "hide" || key === "disableModelInvocation" || key === "enabled") {
        if (out[key] === undefined && (unquoted === "true" || unquoted === "false")) {
          out[key] = unquoted === "true";
        }
      }
    }
  }
  return out;
}

function findCommentStart(value: string): number {
  let quote: string | undefined;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (i === 0 || /\s/.test(value[i - 1] ?? ""))) return i;
  }
  return -1;
}

/** One scanned root with its raw entries; dedup happens after every root ran. */
interface RootScan {
  root: SkillRootInfo;
  gateKey: string | null;
  label: string;
  priority: number;
  entries: SkillCatalogEntry[];
}

async function scanRoot(
  root: SkillRootInfo,
  gateKey: string | null,
  label: string,
  priority: number,
  budget: { files: number; truncated: boolean },
): Promise<RootScan> {
  const scan: RootScan = { root, gateKey, label, priority, entries: [] };
  if (!root.exists || budget.truncated) return scan;
  let dirNames: string[];
  try {
    dirNames = (await fs.readdir(root.path, { withFileTypes: true }))
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      // omp sorts each root deterministically (compareSkillOrder by name/path).
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return scan;
  }
  for (const dirName of dirNames) {
    if (budget.files >= MAX_SKILL_FILES) {
      budget.truncated = true;
      break;
    }
    const filePath = path.join(root.path, dirName, "SKILL.md");
    let head: string;
    try {
      const handle = await fs.open(filePath, "r");
      try {
        const buffer = Buffer.alloc(HEAD_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
        head = buffer.subarray(0, Math.min(bytesRead, HEAD_BYTES)).toString("utf8");
      } finally {
        await handle.close();
      }
    } catch {
      continue; // no SKILL.md in this child — not a skill, exactly as omp's scan sees it
    }
    budget.files += 1;
    const fm = parseFrontmatter(head);
    const name = typeof fm.name === "string" && fm.name.trim().length > 0 ? fm.name.trim() : dirName;
    const raw = fm.description ?? "";
    scan.entries.push({
      name,
      description:
        raw.length > CAPABILITY_DESCRIPTION_LIMIT ? raw.slice(0, CAPABILITY_DESCRIPTION_LIMIT) : raw,
      filePath,
      origin: root.origin,
      scope: root.scope,
      // Filled by the resolution pass: patterns are global, precedence is per name.
      ignored: false,
      gateEnabled: root.gateEnabled,
      gateKey,
      hidden:
        fm.hide === true || fm.disableModelInvocation === true
          ? true
          : fm.hide === false || fm.disableModelInvocation === false
            ? false
            : null,
      disabledInFile: fm.enabled === false,
      shadowedBy: null,
    });
  }
  return scan;
}

export async function getScopedCapabilities(
  scopeCwd: string | null,
  ompPath: string | null,
  env: NodeJS.ProcessEnv = process.env,
  run: OmpConfigRunner = execOmpConfigRunner(ompPath ?? ""),
): Promise<ScopedCapabilitiesResult> {
  // omp-settings' discipline, kept: a failed settings read yields per-section
  // errors carrying omp's own message, never a throw and never an empty list.
  const snapshot = await readOmpSettings({ ompPath, projectCwd: scopeCwd }, run);
  const version = await readOmpVersion(run, env, ompPath);
  if (snapshot.error !== null) {
    return {
      skills: { status: "error", message: snapshot.error },
      tools: { status: "error", message: snapshot.error },
      agentDir: snapshot.agentDir,
      projectConfigPath: snapshot.projectConfigPath,
      ompVersion: version,
    };
  }
  const settings = settingsView(snapshot.entries);
  const skills = await skillsAtScope(scopeCwd, settings, env);
  return {
    skills,
    tools: toolsAtScope(settings),
    agentDir: snapshot.agentDir,
    projectConfigPath: snapshot.projectConfigPath,
    ompVersion: version,
  };
}

/** `omp --version` prints `omp/x.y.z`; a failed version read is simply unknown. */
async function readOmpVersion(
  run: OmpConfigRunner,
  env: NodeJS.ProcessEnv,
  ompPath: string | null,
): Promise<string | null> {
  if (ompPath === null) return null;
  try {
    const match = /omp\/([^\s]+)/.exec(await run(["--version"], { cwd: process.cwd(), env }));
    return match !== null ? (match[1] ?? null) : null;
  } catch {
    return null;
  }
}

function toolsAtScope(settings: SettingsView): ToolsAtScope {
  const items: ToolsAtScope["items"] = [];
  for (const gate of TOOL_ENABLED_KEYS) {
    // A key omp no longer publishes drops out silently — readOmpSettings'
    // per-entry rule, guarded by the parity test in omp-capability-keys.
    if (!settings.has(gate.key)) continue;
    const value = settings.value(gate.key);
    items.push({
      tool: gate.tool,
      key: gate.key,
      enabled: typeof value === "boolean" ? value : null,
      layer: settings.layer(gate.key),
    });
  }
  return { status: "available", items };
}

async function skillsAtScope(
  scopeCwd: string | null,
  settings: SettingsView,
  env: NodeJS.ProcessEnv,
): Promise<SkillsAtScope> {
  const home = os.homedir();
  const agentDir = getOmpAgentDir(env);
  const ignoredPatterns = stringsOf(settings, "skills.ignoredSkills");
  const includePatterns = stringsOf(settings, "skills.includeSkills");
  const customDirectories = stringsOf(settings, "skills.customDirectories").map((dir) =>
    expandTilde(dir, home),
  );

  // Resolution order = omp's: table order already carries priority descending
  // with omp's provider-registration ties broken, and the custom directories
  // override any default-path skill of the same name (issue #7190) — 1000.
  const roots: SkillRootInfo[] = [];
  const scans: RootScan[] = [];
  const budget = { files: 0, truncated: false };
  for (const dir of customDirectories) {
    const root: SkillRootInfo = {
      origin: "custom",
      scope: "user",
      path: dir,
      exists: await isDirectory(dir),
      gateEnabled: true,
    };
    roots.push(root);
    scans.push(await scanRoot(root, null, `custom:${dir}`, CUSTOM_SKILLS_PRIORITY, budget));
  }
  for (const spec of SKILL_SOURCES) {
    if (spec.scope === "project" && scopeCwd === null) continue;
    const bases =
      spec.base === "cwd"
        ? scopeCwd === null
          ? []
          : spec.walkUp
            ? await walkUpToRoot(scopeCwd, home)
            : [scopeCwd]
        : spec.base === "home"
          ? [home]
          : [agentDir];
    for (const baseDir of bases) {
      const rootPath = path.join(baseDir, ...spec.parts);
      const root: SkillRootInfo = {
        origin: spec.origin,
        scope: spec.scope,
        path: rootPath,
        exists: await isDirectory(rootPath),
        gateEnabled: spec.gateKey === null ? true : boolOf(settings, spec.gateKey),
      };
      roots.push(root);
      scans.push(
        await scanRoot(root, spec.gateKey, `${spec.origin}:${rootPath}`, spec.priority, budget),
      );
    }
  }

  // Two passes mirroring omp's filter chain (extensibility/skills.ts):
  // gate → patterns → name-dedup runs per entry in resolution order, so a
  // DISABLED or ignored winner does not shadow an enabled lower root — the
  // winner is the first LOADABLE entry for the name — and custom (first here)
  // overrides authored, authored shadows managed.
  const loadableOf = (entry: SkillCatalogEntry, gateEnabled: boolean): boolean =>
    !entry.disabledInFile &&
    gateEnabled &&
    !ignoredPatterns.some((pattern) => matchSkillGlob(pattern, entry.name)) &&
    (includePatterns.length === 0 ||
      includePatterns.some((pattern) => matchSkillGlob(pattern, entry.name)));

  const winners = new Map<string, { label: string; realPath: string }>();
  const items: SkillCatalogEntry[] = [];

  for (const scan of scans) {
    for (const found of scan.entries) {
      const ignored =
        ignoredPatterns.some((pattern) => matchSkillGlob(pattern, found.name)) ||
        (includePatterns.length > 0 &&
          !includePatterns.some((pattern) => matchSkillGlob(pattern, found.name)));
      let realPath = found.filePath;
      try {
        realPath = await fs.realpath(found.filePath);
      } catch {
        /* unresolvable path keeps its raw identity */
      }
      const winner = winners.get(found.name);
      const isWinner = winner === undefined && loadableOf(found, scan.root.gateEnabled);
      if (isWinner) winners.set(found.name, { label: scan.label, realPath });
      // A symlink to the loaded winner is the SAME file listed twice; omp
      // skips it silently (its realpath set), and so does the catalog.
      if (winner !== undefined && winner.realPath === realPath) continue;
      items.push({ ...found, ignored, shadowedBy: isWinner || winner === undefined ? null : winner.label });
    }
  }

  return {
    status: "available",
    items,
    roots,
    masterEnabled: boolOf(settings, "skills.enabled"),
    skillCommandsEnabled: boolOf(settings, "skills.enableSkillCommands"),
    // omp's curated/bundled skills are embedded in the binary
    // (discovery/builtin-defaults.ts) and cannot be enumerated from disk.
    note: "bundles-not-listed",
    truncated: budget.truncated,
  };
}

/**
 * Apply one scoped mutation and answer with the scope's refreshed catalogs —
 * the `setMcpServerEnabled` contract: one round trip, rows that match disk.
 * Every shape check runs BEFORE any spawn or write; a request naming an
 * unknown tool or gate key never reaches a subprocess or a file.
 */
export async function setScopedCapability(
  req: ScopedCapabilityMutation,
  ompPath: string | null,
  env: NodeJS.ProcessEnv = process.env,
  run: OmpConfigRunner = execOmpConfigRunner(ompPath ?? ""),
): Promise<ScopedCapabilitiesResult> {
  if (ompPath === null) throw new Error("omp binary not found");
  if (req.kind === "tool" && !TOOL_ENABLED_KEYS.some((gate) => gate.tool === req.tool)) {
    throw new Error(`refusing to toggle unknown tool gate: ${req.tool}`);
  }
  if (req.kind === "skill-gate" && !SKILL_GATE_KEYS.includes(req.key)) {
    throw new Error(`refusing to write non-gate skills setting: ${req.key}`);
  }
  if (req.kind === "skill-ignore" && req.name.trim().length === 0) {
    throw new Error("refusing to ignore an unnamed skill");
  }

  if (req.scopeCwd === null) {
    if (req.kind === "skill-ignore") {
      // Read-modify-write of the GLOBAL list: the global read is neutral-cwd,
      // so its value IS the global layer. The read→write window is one spawn;
      // concurrent writers race last-write-wins, and the refreshed rows below
      // re-state whatever disk ended up holding.
      const snapshot = await readOmpSettings({ ompPath, projectCwd: null }, run);
      if (snapshot.error !== null) throw new Error(snapshot.error);
      const current = stringsOf(settingsView(snapshot.entries), "skills.ignoredSkills");
      const next = req.ignored
        ? [...new Set([...current, req.name])]
        : current.filter((pattern) => pattern !== req.name);
      await writeOmpSetting({ ompPath, key: "skills.ignoredSkills", value: next }, run);
    } else {
      const key = req.kind === "tool" ? gateKeyOfTool(req.tool) : req.key;
      await writeOmpSetting({ ompPath, key, value: req.enabled }, run);
    }
  } else if (req.kind === "skill-ignore") {
    const read = readProjectConfigValue(req.scopeCwd, ["skills", "ignoredSkills"]);
    let current: string[];
    if (read.shape === "absent") current = [];
    else if (read.shape === "value" && Array.isArray(read.value)) current = read.value;
    else if (read.shape === "value") {
      throw new Error(
        `${req.scopeCwd}: skills.ignoredSkills holds a ${typeof read.value}, not a list; refusing to merge`,
      );
    } else throw new Error(read.reason);
    const next = req.ignored
      ? [...new Set([...current, req.name])]
      : current.filter((pattern) => pattern !== req.name);
    await setProjectConfigValue(req.scopeCwd, ["skills", "ignoredSkills"], next);
  } else {
    const key = req.kind === "tool" ? gateKeyOfTool(req.tool) : req.key;
    await setProjectConfigValue(req.scopeCwd, key.split("."), req.enabled);
  }
  return getScopedCapabilities(req.scopeCwd, ompPath, env, run);
}

function gateKeyOfTool(tool: string): string {
  const gate = TOOL_ENABLED_KEYS.find((candidate) => candidate.tool === tool);
  if (gate === undefined) throw new Error(`unknown tool gate: ${tool}`);
  return gate.key;
}
