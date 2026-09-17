import * as fs from "node:fs";
import * as path from "node:path";
import { writeTextAtomic } from "./atomic-write";

/**
 * Line-scoped editing of a project's omp config layer — `<cwd>/.omp/config.yml`
 * (issue #383). omp itself has no project-layer write verb: `omp config set`
 * always targets the global layer (verified, omp-settings.ts), so a project
 * toggle cannot be delegated to the binary the way a global one is.
 *
 * The contract is the opposite of omp's own writer, which regenerates the YAML
 * and drops comments: every byte outside the touched lines survives verbatim,
 * comments included. Values are read as a two-level model — top-level parents
 * at column 0, children one indent deeper — mirroring omp-config.ts's
 * `nestedScalar`, which is all omp's writer ever emits for these keys.
 *
 * Refuse, never guess. A target whose shape the two-level model cannot see —
 * a flow mapping, an anchor or alias, a tag, a multi-document file, a
 * duplicate parent block, or a scalar where a mapping must go — raises an
 * error naming the file and the line instead of reformatting the config.
 */

/** omp reads `config.yml` first, then `config.yaml` — the same order here. */
const CONFIG_FILENAMES = ["config.yml", "config.yaml"] as const;

/** Value shapes this writer can emit in the grammar omp's own writer uses. */
export type ProjectConfigValue = string | boolean | string[];

/** What a project-layer read found for one two-level key path. */
export type ProjectConfigRead =
  | { shape: "value"; value: ProjectConfigValue }
  | { shape: "absent" }
  | { shape: "unsupported"; line: number; reason: string };

/** What a project-layer read found for a two-level key path holding a string map. */
export type ProjectConfigMapRead =
  | { shape: "map"; value: Record<string, string> }
  /** A scalar/array sits where a map was expected. */
  | { shape: "value"; value: ProjectConfigValue }
  | { shape: "absent" }
  | { shape: "unsupported"; line: number; reason: string };

class Refuse extends Error {
  constructor(file: string, line: number, message: string) {
    super(`${file}:${line}: ${message}`);
  }
}

/** The file omp's project layer would read, or the one it would create. */
export function projectConfigFile(projectCwd: string): string {
  for (const name of CONFIG_FILENAMES) {
    const p = path.join(projectCwd, ".omp", name);
    if (fs.existsSync(p)) return p;
  }
  return path.join(projectCwd, ".omp", CONFIG_FILENAMES[0]);
}

const RESERVED_PLAIN: Record<string, true> = {
  "true": true,
  "false": true,
  "null": true,
  "~": true,
  "y": true,
  "yes": true,
  "n": true,
  "no": true,
  "on": true,
  "off": true,
};

/** Double-quote a scalar the way omp's writer does when plain form is unsafe. */
function scalarOut(value: string): string {
  const plain =
    /^[A-Za-z][A-Za-z0-9 .+-]*$/.test(value) && RESERVED_PLAIN[value.toLowerCase()] !== true;
  return plain ? value : `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function scalarOf(value: string | boolean): string {
  return typeof value === "boolean" ? (value ? "true" : "false") : scalarOut(value);
}

/** Split off a trailing `#` comment that sits outside quotes. */
function splitComment(text: string): { value: string; comment: string } {
  let quote: string | undefined;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "#" && (i === 0 || /\s/.test(text[i - 1] ?? ""))) {
      return { value: text.slice(0, i), comment: text.slice(i) };
    }
  }
  return { value: text, comment: "" };
}

/** Unquote a plain or double-quoted scalar read back from disk. */
function scalarIn(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    let out = "";
    const inner = trimmed.slice(1, -1);
    for (let i = 0; i < inner.length; i += 1) {
      const char = inner[i];
      if (char === "\\" && i + 1 < inner.length) {
        i += 1;
        const next = inner[i];
        out += next === "n" ? "\n" : next === "t" ? "\t" : (next ?? "");
        continue;
      }
      out += char;
    }
    return out;
  }
  return trimmed;
}

interface Line {
  /** Raw text, no eol. */
  text: string;
  /** Column of the first non-space character. */
  indent: number;
  /** text with leading whitespace removed. */
  body: string;
}

interface Model {
  lines: Line[];
  /** Line index → mapping name, for every `name:` line at column 0. */
  parents: Map<number, string>;
}

function modelize(text: string): Model {
  const lines = text.split(/\r?\n/).map((t) => {
    const body = t.trimStart();
    return { text: t, indent: t.length - body.length, body };
  });
  const parents = new Map<number, string>();
  lines.forEach((line, i) => {
    if (line.indent !== 0 || line.body === "" || line.body.startsWith("#")) return;
    const colon = line.body.indexOf(":");
    if (colon < 0) return;
    const name = line.body.slice(0, colon).trim();
    if (name.startsWith('"') || name.startsWith("'") || name.includes(" ")) return;
    parents.set(i, name);
  });
  return { lines, parents };
}

function isCommentOrBlank(line: Line): boolean {
  return line.body === "" || line.body.startsWith("#");
}

/** Anchors, aliases, and tags ride the value text; a rewrite would silently drop them. */
function hasNodeSyntax(value: string): boolean {
  return /[\s&][&*]\S/.test(" " + value) || /\s!(?:[\w-]|%)/.test(" " + value);
}

/** Find the top-level block named `parent`; duplicates, scalars, and flows refuse. */
function findParent(model: Model, file: string, parent: string): number | null {
  let found: number | null = null;
  for (const [i, name] of model.parents) {
    if (name !== parent) continue;
    if (found !== null) {
      throw new Refuse(file, i + 1, `duplicate "${parent}:" block (first at line ${found + 1})`);
    }
    found = i;
  }
  if (found === null) return null;
  const line = model.lines[found]!;
  const value = splitComment(line.text.slice(line.indent)).value.slice(parent.length + 1).trim();
  if (value.startsWith("&") || value.startsWith("*") || hasNodeSyntax(value)) {
    throw new Refuse(file, found + 1, `"${parent}" carries an anchor, alias, or tag`);
  }
  if (value.startsWith("{")) {
    throw new Refuse(file, found + 1, `"${parent}" is a flow mapping, outside this writer's grammar`);
  }
  if (value !== "") {
    throw new Refuse(file, found + 1, `"${parent}" holds a scalar, not a mapping`);
  }
  return found;
}

/** The end (exclusive) of the block starting at top-level line `start`. */
function blockEnd(model: Model, start: number): number {
  for (let i = start + 1; i < model.lines.length; i += 1) {
    const line = model.lines[i]!;
    if (isCommentOrBlank(line)) continue;
    if (line.indent === 0) return i;
  }
  return model.lines.length;
}

function lastContentIndex(model: Model, from: number, to: number): number {
  let last = from;
  for (let i = from; i < to; i += 1) {
    if (!isCommentOrBlank(model.lines[i]!)) last = i;
  }
  return last;
}

interface ChildHit {
  /** Index of the child line. */
  line: number;
  /** Inline value after `key:` ("" when the value lives on following lines). */
  inline: string;
  /** Contiguous deeper lines forming the child's block value. */
  block: number[];
}

/** Locate `child` at the block's own indent; throws on anchored/tagged hits. */
function findChild(model: Model, file: string, start: number, child: string): ChildHit | null {
  const end = blockEnd(model, start);
  let childIndent = -1;
  for (let i = start + 1; i < end; i += 1) {
    const line = model.lines[i]!;
    if (isCommentOrBlank(line)) continue;
    if (childIndent === -1) childIndent = line.indent;
    if (line.indent !== childIndent) continue;
    if (!line.body.startsWith(`${child}:`)) continue;
    const inline = splitComment(line.text.slice(line.indent)).value.slice(child.length + 1).trim();
    if (hasNodeSyntax(inline)) {
      throw new Refuse(file, i + 1, `"${child}" carries an anchor, alias, or tag`);
    }
    const block: number[] = [];
    for (let j = i + 1; j < end; j += 1) {
      const inner = model.lines[j]!;
      if (!isCommentOrBlank(inner) && inner.indent <= childIndent) break;
      if (isCommentOrBlank(inner) && block.length === 0) continue;
      block.push(j);
    }
    return { line: i, inline, block };
  }
  return null;
}

/** Whether the child's deeper lines are block-sequence items, a nested map, or nothing yet. */
function childBlockShape(model: Model, hit: ChildHit): "seq" | "map" | "empty" {
  const contents = hit.block.filter((j) => !isCommentOrBlank(model.lines[j]!));
  if (contents.length === 0) return "empty";
  const allSeq = contents.every(
    (j) => model.lines[j]!.body.startsWith("- ") || model.lines[j]!.body === "-",
  );
  return allSeq ? "seq" : "map";
}

function parseFlowSeq(text: string): string[] | null {
  const inner = text.trim().replace(/^\[/, "").replace(/\]\s*$/, "");
  if (inner.trim() === "") return [];
  const parts: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (const char of inner) {
    if (quote !== undefined) {
      current += char;
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  if (parts.some((p) => p.includes(","))) return null;
  return parts.map((p) => scalarIn(p));
}

interface MapEntry {
  /** Index into model.lines. */
  line: number;
  /** The unquoted key. */
  name: string;
  /** Raw value text, comment stripped. */
  inline: string;
}

/** The colon separating key from value, outside quotes; -1 when the line is not `key: value`. */
function keyColon(body: string): number {
  let quote: string | undefined;
  for (let i = 0; i < body.length; i += 1) {
    const char = body[i]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    // YAML separates key and value with `:` plus whitespace or end-of-line.
    if (char === ":" && (i + 1 === body.length || /\s/.test(body[i + 1]!))) return i;
  }
  return -1;
}

/**
 * The entries of a child block already known to be a mapping. Anything outside
 * the one-level `key: scalar` shape — a nested mapping, a flow value, an
 * anchor, a duplicate key — refuses, naming the file and the line.
 */
function mapEntries(model: Model, file: string, hit: ChildHit): MapEntry[] {
  const contents = hit.block.filter((j) => !isCommentOrBlank(model.lines[j]!));
  const entryIndent = model.lines[contents[0]!]!.indent;
  const entries: MapEntry[] = [];
  const seen = new Set<string>();
  for (const j of contents) {
    const line = model.lines[j]!;
    if (line.indent !== entryIndent) {
      throw new Refuse(file, j + 1, "nested content under a map entry");
    }
    const colon = keyColon(line.body);
    if (colon < 0) {
      throw new Refuse(file, j + 1, "not a `key: value` map entry");
    }
    const name = scalarIn(line.body.slice(0, colon));
    const inline = splitComment(line.body.slice(colon + 1)).value.trim();
    if (inline === "") {
      throw new Refuse(file, j + 1, `"${name}" holds no scalar`);
    }
    if (inline.startsWith("[") || inline.startsWith("{")) {
      throw new Refuse(file, j + 1, `"${name}" holds a flow value`);
    }
    if (hasNodeSyntax(inline) || inline.startsWith("&") || inline.startsWith("*") || inline.startsWith("!")) {
      throw new Refuse(file, j + 1, `"${name}" carries an anchor, alias, or tag`);
    }
    if (seen.has(name)) {
      throw new Refuse(file, j + 1, `duplicate "${name}" entry`);
    }
    seen.add(name);
    entries.push({ line: j, name, inline });
  }
  return entries;
}

/** Sequence items of a child block, or the refusal a bad item produces. */
function blockSeqItems(
  model: Model,
  file: string,
  hit: ChildHit,
): { items: string[] } | { line: number; reason: string } {
  const items: string[] = [];
  for (const j of hit.block) {
    const line = model.lines[j]!;
    if (isCommentOrBlank(line)) continue;
    if (!line.body.startsWith("-") && !line.body.startsWith("- ")) {
      return { line: j + 1, reason: `${file}: not a sequence entry` };
    }
    items.push(scalarIn(splitComment(line.body.slice(1)).value));
  }
  return { items };
}

/** Read the project layer's OWN value for a two-level key path; never throws on absence. */
export function readProjectConfigValue(
  projectCwd: string,
  keyPath: readonly string[],
): ProjectConfigRead {
  if (keyPath.length !== 2) {
    return { shape: "unsupported", line: 0, reason: "key path must be parent + key" };
  }
  const file = projectConfigFile(projectCwd);
  if (!fs.existsSync(file)) return { shape: "absent" };
  const text = fs.readFileSync(file, "utf8");
  if (/^---/m.test(text)) {
    const i = text.split(/\r?\n/).findIndex((l) => l.startsWith("---"));
    return { shape: "unsupported", line: i + 1, reason: `${file}: multi-document YAML` };
  }
  const model = modelize(text);
  let read: ProjectConfigRead;
  try {
    const parentLine = findParent(model, file, keyPath[0]!);
    if (parentLine === null) return { shape: "absent" };
    const hit = findChild(model, file, parentLine, keyPath[1]!);
    if (hit === null) return { shape: "absent" };
    if (hit.inline.startsWith("[")) {
      const items = parseFlowSeq(hit.inline);
      return items === null
        ? { shape: "unsupported", line: hit.line + 1, reason: `${file}: flow sequence not parseable` }
        : { shape: "value", value: items };
    }
    if (hit.inline !== "") {
      const low = splitComment(hit.inline).value.trim().toLowerCase();
      if (low === "true") return { shape: "value", value: true };
      if (low === "false") return { shape: "value", value: false };
      return { shape: "value", value: scalarIn(splitComment(hit.inline).value) };
    }
    const shape = childBlockShape(model, hit);
    if (shape === "empty") return { shape: "absent" };
    if (shape === "map") {
      return {
        shape: "unsupported",
        line: hit.line + 1,
        reason: `${file}: nested mapping under ${keyPath[1]}`,
      };
    }
    const seq = blockSeqItems(model, file, hit);
    if ("reason" in seq) return { shape: "unsupported", line: seq.line, reason: seq.reason };
    return { shape: "value", value: seq.items };
  } catch (err) {
    read = { shape: "unsupported", line: 0, reason: (err as Error).message };
  }
  return read;
}

/**
 * Read the project layer's OWN string map for a two-level key path —
 * `task.agentModelOverrides` is the consumer (ADR-0031). A scalar or
 * sequence where the map was expected reads back as a plain value so the
 * caller can show it; a flow mapping, anchor, or duplicate key reports
 * `unsupported` with the file and line rather than being reformatted.
 */
export function readProjectConfigMap(
  projectCwd: string,
  keyPath: readonly string[],
): ProjectConfigMapRead {
  if (keyPath.length !== 2) {
    return { shape: "unsupported", line: 0, reason: "key path must be parent + key" };
  }
  const file = projectConfigFile(projectCwd);
  if (!fs.existsSync(file)) return { shape: "absent" };
  const text = fs.readFileSync(file, "utf8");
  if (/^---/m.test(text)) {
    const i = text.split(/\r?\n/).findIndex((l) => l.startsWith("---"));
    return { shape: "unsupported", line: i + 1, reason: `${file}: multi-document YAML` };
  }
  const model = modelize(text);
  let read: ProjectConfigMapRead;
  try {
    const parentLine = findParent(model, file, keyPath[0]!);
    if (parentLine === null) return { shape: "absent" };
    const hit = findChild(model, file, parentLine, keyPath[1]!);
    if (hit === null) return { shape: "absent" };
    if (hit.inline.startsWith("{")) {
      return {
        shape: "unsupported",
        line: hit.line + 1,
        reason: `${file}: flow mapping under ${keyPath[1]}`,
      };
    }
    if (hit.inline.startsWith("[")) {
      const items = parseFlowSeq(hit.inline);
      return items === null
        ? { shape: "unsupported", line: hit.line + 1, reason: `${file}: flow sequence not parseable` }
        : { shape: "value", value: items };
    }
    if (hit.inline !== "") {
      const low = splitComment(hit.inline).value.trim().toLowerCase();
      if (low === "true") return { shape: "value", value: true };
      if (low === "false") return { shape: "value", value: false };
      return { shape: "value", value: scalarIn(splitComment(hit.inline).value) };
    }
    const shape = childBlockShape(model, hit);
    if (shape === "empty") return { shape: "absent" };
    if (shape === "seq") {
      const seq = blockSeqItems(model, file, hit);
      if ("reason" in seq) return { shape: "unsupported", line: seq.line, reason: seq.reason };
      return { shape: "value", value: seq.items };
    }
    const value: Record<string, string> = {};
    for (const entry of mapEntries(model, file, hit)) {
      value[entry.name] = scalarIn(entry.inline);
    }
    return { shape: "map", value };
  } catch (err) {
    read = { shape: "unsupported", line: 0, reason: (err as Error).message };
  }
  return read;
}

/**
 * Write one two-level value into the project's config layer, in place.
 * Creates the file (mode 0o600) when neither config.yml nor config.yaml
 * exists. Throws (naming file and line) on any shape outside the grammar.
 */
export async function setProjectConfigValue(
  projectCwd: string,
  keyPath: readonly string[],
  value: ProjectConfigValue,
): Promise<void> {
  if (
    keyPath.length !== 2 ||
    keyPath.some((k) => k.length === 0 || /[:#\s]/.test(k))
  ) {
    throw new Error(`invalid project config key path: ${keyPath.join(".")}`);
  }
  const [parent, child] = [keyPath[0]!, keyPath[1]!];
  const file = projectConfigFile(projectCwd);
  const existed = fs.existsSync(file);
  const text = existed ? fs.readFileSync(file, "utf8") : "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (/^---/m.test(text)) {
    const i = text.split(/\r?\n/).findIndex((l) => l.startsWith("---"));
    throw new Refuse(file, i + 1, "multi-document YAML is outside this writer's grammar");
  }

  /** The child block `indent` columns in: `child: v`, or `child:` + seq items. */
  const childLines = (indent: number): string[] =>
    Array.isArray(value)
      ? [
          `${" ".repeat(indent)}${child}:`,
          ...value.map((item) => `${" ".repeat(indent + 2)}- ${scalarOf(item)}`),
        ]
      : [`${" ".repeat(indent)}${child}: ${scalarOf(value)}`];

  if (!existed) {
    // A fresh file gets omp's own shape: `parent:` at column 0, `child:` at 2.
    writeTextAtomic(file, [`${parent}:`, ...childLines(2)].join(eol) + eol, 0o600);
    return;
  }

  const model = modelize(text);
  const out = model.lines.map((l) => l.text);
  const parentLine = findParent(model, file, parent);

  if (parentLine === null) {
    // Append a fresh parent block formatted like the `omp config set` fixture:
    // no blank-line gap, parent at column 0, child at 2, seq items at 4.
    const head = text === "" || text.endsWith("\n") ? "" : eol;
    writeTextAtomic(file, text + head + [`${parent}:`, ...childLines(2)].join(eol) + eol);
    return;
  }

  const end = blockEnd(model, parentLine);
  const hit = findChild(model, file, parentLine, child);
  if (hit === null) {
    const firstChild = model.lines
      .slice(parentLine + 1, end)
      .find((l) => !isCommentOrBlank(l));
    const indent = firstChild === undefined ? 2 : firstChild.indent;
    // A same-named key buried deeper in the block is a nested mapping; the
    // two-level model must not duplicate it at the block's own indent.
    for (let i = parentLine + 1; i < end; i += 1) {
      const line = model.lines[i]!;
      if (isCommentOrBlank(line) || line.indent === indent) continue;
      if (line.body.startsWith(`${child}:`)) {
        throw new Refuse(file, i + 1, `${child} lives in a nested mapping`);
      }
    }
    out.splice(lastContentIndex(model, parentLine, end) + 1, 0, ...childLines(indent));
    writeTextAtomic(file, out.join(eol));
    return;
  }

  // Existing child: replace in place, keeping every untouched line verbatim.
  const pad = " ".repeat(model.lines[hit.line]!.indent);
  const shape = childBlockShape(model, hit);
  if (shape === "map") {
    throw new Refuse(file, hit.line + 1, `${child} holds a mapping; refusing to overwrite it`);
  }
  if (!Array.isArray(value) && (shape === "seq" || hit.inline.startsWith("["))) {
    throw new Refuse(file, hit.line + 1, `${child} holds a list; refusing to replace it with a scalar`);
  }
  if (Array.isArray(value) && hit.inline !== "" && !hit.inline.startsWith("[")) {
    throw new Refuse(file, hit.line + 1, `${child} holds a scalar; refusing to replace it with a list`);
  }
  const lastContent = [...hit.block].reverse().find((j) => !isCommentOrBlank(model.lines[j]!));
  const deleteCount = lastContent === undefined ? 1 : lastContent - hit.line + 1;
  out.splice(hit.line, deleteCount, ...childLines(pad.length));
  writeTextAtomic(file, out.join(eol));
}

/**
 * Write ONE entry of a two-level string map (`task.agentModelOverrides`) into
 * the project's config layer, in place — an unrelated hand-written sibling
 * entry survives untouched, comments included. `value: null` deletes that one
 * entry, and a deletion that empties the map removes the child key with it.
 * Creates the file (mode 0o600) when neither config.yml nor config.yaml
 * exists. Throws (naming file and line) on any shape outside the grammar.
 */
export async function setProjectConfigMapEntry(
  projectCwd: string,
  keyPath: readonly string[],
  entry: string,
  value: string | null,
): Promise<void> {
  if (
    keyPath.length !== 2 ||
    keyPath.some((k) => k.length === 0 || /[:#\s]/.test(k))
  ) {
    throw new Error(`invalid project config key path: ${keyPath.join(".")}`);
  }
  if (entry.length === 0 || /[\r\n]/.test(entry)) {
    throw new Error("invalid map entry name");
  }
  if (value !== null && /[\r\n]/.test(value)) {
    throw new Error("invalid map entry value");
  }
  const [parent, child] = [keyPath[0]!, keyPath[1]!];
  const file = projectConfigFile(projectCwd);
  const existed = fs.existsSync(file);
  const text = existed ? fs.readFileSync(file, "utf8") : "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  if (/^---/m.test(text)) {
    const i = text.split(/\r?\n/).findIndex((l) => l.startsWith("---"));
    throw new Refuse(file, i + 1, "multi-document YAML is outside this writer's grammar");
  }

  /** The three fresh lines for a file/parent/child that does not exist yet. */
  const freshLines = (indent: number): string[] => [
    `${parent}:`,
    `${" ".repeat(indent)}${child}:`,
    `${" ".repeat(indent + 2)}${scalarOut(entry)}: ${scalarOut(value ?? "")}`,
  ];

  if (value === null && !existed) return;
  if (!existed) {
    writeTextAtomic(file, freshLines(2).join(eol) + eol, 0o600);
    return;
  }

  const model = modelize(text);
  const out = model.lines.map((l) => l.text);
  const parentLine = findParent(model, file, parent);
  if (parentLine === null) {
    if (value === null) return;
    const head = text === "" || text.endsWith("\n") ? "" : eol;
    writeTextAtomic(file, text + head + freshLines(2).join(eol) + eol);
    return;
  }

  const end = blockEnd(model, parentLine);
  const hit = findChild(model, file, parentLine, child);
  if (hit === null) {
    if (value === null) return;
    const firstChild = model.lines
      .slice(parentLine + 1, end)
      .find((l) => !isCommentOrBlank(l));
    const indent = firstChild === undefined ? 2 : firstChild.indent;
    // A same-named key buried deeper in the block is a nested mapping; the
    // two-level model must not duplicate it at the block's own indent.
    for (let i = parentLine + 1; i < end; i += 1) {
      const line = model.lines[i]!;
      if (isCommentOrBlank(line) || line.indent === indent) continue;
      if (line.body.startsWith(`${child}:`)) {
        throw new Refuse(file, i + 1, `${child} lives in a nested mapping`);
      }
    }
    out.splice(
      lastContentIndex(model, parentLine, end) + 1,
      0,
      `${" ".repeat(indent)}${child}:`,
      `${" ".repeat(indent + 2)}${scalarOut(entry)}: ${scalarOut(value)}`,
    );
    writeTextAtomic(file, out.join(eol));
    return;
  }

  if (hit.inline !== "") {
    if (hit.inline.startsWith("{")) {
      throw new Refuse(file, hit.line + 1, `${child} is a flow mapping`);
    }
    if (hit.inline.startsWith("[")) {
      throw new Refuse(file, hit.line + 1, `${child} holds a list; refusing to overwrite it`);
    }
    throw new Refuse(file, hit.line + 1, `${child} holds a scalar; refusing to overwrite it`);
  }
  const shape = childBlockShape(model, hit);
  if (shape === "seq") {
    throw new Refuse(file, hit.line + 1, `${child} holds a list; refusing to overwrite it`);
  }
  if (shape === "empty") {
    if (value === null) return;
    out.splice(
      hit.line + 1,
      0,
      `${" ".repeat(model.lines[hit.line]!.indent + 2)}${scalarOut(entry)}: ${scalarOut(value)}`,
    );
    writeTextAtomic(file, out.join(eol));
    return;
  }

  const entries = mapEntries(model, file, hit);
  const entryIndent = model.lines[entries[0]!.line]!.indent;
  const found = entries.find((e) => e.name === entry);
  if (found === undefined) {
    if (value === null) return;
    out.splice(
      entries[entries.length - 1]!.line + 1,
      0,
      `${" ".repeat(entryIndent)}${scalarOut(entry)}: ${scalarOut(value)}`,
    );
    writeTextAtomic(file, out.join(eol));
    return;
  }
  if (value !== null) {
    out.splice(found.line, 1, `${" ".repeat(entryIndent)}${scalarOut(entry)}: ${scalarOut(value)}`);
    writeTextAtomic(file, out.join(eol));
    return;
  }
  // Delete one entry; a deletion that empties the map removes the child too.
  if (entries.length === 1) {
    const lastContent = [...hit.block].reverse().find((j) => !isCommentOrBlank(model.lines[j]!));
    const deleteCount = lastContent === undefined ? 1 : lastContent - hit.line + 1;
    out.splice(hit.line, deleteCount);
  } else {
    out.splice(found.line, 1);
  }
  writeTextAtomic(file, out.join(eol));
}
