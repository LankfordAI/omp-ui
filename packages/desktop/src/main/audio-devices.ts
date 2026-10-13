import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AudioDeviceEntry, AudioDeviceRole } from "@omp-ui/core";

/** Re-exported from core so main-process callers can import the role from the module that uses it. */
export type { AudioDeviceRole } from "@omp-ui/core";

const execFileAsync = promisify(execFile);

/**
 * Test seam: one pactl invocation resolving its stdout; rejects on a spawn
 * failure or a non-zero exit (issue #855).
 */
export interface AudioDeviceRunner {
  run(cmd: string, args: string[]): Promise<string>;
}

/** The production runner: pactl on PATH, generous buffer for large listings. */
export function execPactlRunner(): AudioDeviceRunner {
  return {
    run: (cmd, args) =>
      execFileAsync(cmd, args, { maxBuffer: 16 * 1024 * 1024 }).then(({ stdout }) => stdout),
  };
}

interface PactlNode {
  name?: unknown;
  properties?: unknown;
}

/** Live nodes keyed by their trimmed card label; the same shape enumeration and apply need. */
interface NodeMap {
  [label: string]: { sources: string[]; sinks: string[] };
}

const labelOf = (node: PactlNode): string | null => {
  const props = node.properties;
  if (typeof props !== "object" || props === null) return null;
  const raw = (props as Record<string, unknown>)["device.description"];
  if (typeof raw !== "string") return null;
  // PipeWire pads some labels (e.g. the AT2020); the trimmed text is the id.
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
};

/** A node contributes to the picker only as a real, labelled device endpoint. */
const usable = (node: PactlNode): node is { name: string } => {
  if (typeof node.name !== "string" || node.name === "") return false;
  // Monitor sources mirror a sink's output; loopback devices are virtual.
  if (node.name.endsWith(".monitor")) return false;
  const props = node.properties;
  if (typeof props === "object" && props !== null) {
    if ((props as Record<string, unknown>)["device.api"] === "loopback") return false;
  }
  return labelOf(node) !== null;
};

async function listNodes(deps: AudioDeviceRunner, kind: "sources" | "sinks"): Promise<PactlNode[]> {
  const out = await deps.run("pactl", ["--format=json", "list", kind]);
  const parsed: unknown = JSON.parse(out);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is PactlNode => typeof entry === "object" && entry !== null);
}

/** Group every usable node by its card label; names stay sorted by pactl order. */
async function enumerate(deps: AudioDeviceRunner): Promise<NodeMap> {
  const [sources, sinks] = await Promise.all([
    listNodes(deps, "sources"),
    listNodes(deps, "sinks"),
  ]);
  const map: NodeMap = {};
  const add = (kind: "sources" | "sinks", node: PactlNode): void => {
    if (!usable(node)) return;
    const label = labelOf(node)!;
    (map[label] ??= { sources: [], sinks: [] })[kind].push(node.name);
  };
  for (const node of sources) add("sources", node);
  for (const node of sinks) add("sinks", node);
  return map;
}

/** The label owning the OS default for one `get-default-*` query; null when unresolved. */
async function defaultLabel(
  deps: AudioDeviceRunner,
  query: "get-default-source" | "get-default-sink",
  map: NodeMap,
): Promise<string | null> {
  // Best-effort per the fallback chain: a failing query leaves the default
  // unmarked rather than failing the whole read.
  let out: string;
  try {
    out = await deps.run("pactl", [query]);
  } catch {
    return null;
  }
  const name = out.trim();
  if (name === "" || name === "N/A") return null;
  for (const [label, nodes] of Object.entries(map)) {
    if (nodes.sources.includes(name) || nodes.sinks.includes(name)) return label;
  }
  return null;
}

/**
 * Every real audio device on the machine, grouped by card label. Each role's
 * default marker comes from that role's OS default node name resolved
 * through the node → label map: that is what dictation and omp's live-voice
 * capture actually follow, and the only source of truth pactl exposes on
 * PipeWire. Rejects when pactl is absent or fails — the handler turns that
 * into `supported: false`.
 */
export async function readAudioDevices(deps: AudioDeviceRunner): Promise<AudioDeviceEntry[]> {
  const map = await enumerate(deps);
  const [sourceLabel, sinkLabel] = await Promise.all([
    defaultLabel(deps, "get-default-source", map),
    defaultLabel(deps, "get-default-sink", map),
  ]);
  const entries: AudioDeviceEntry[] = [];
  for (const [id, nodes] of Object.entries(map)) {
    if (nodes.sources.length === 0 && nodes.sinks.length === 0) continue;
    entries.push({
      id,
      // Independent per role: the source query resolving through a sink node
      // marks that card's output half only, so no row ever claims a default
      // it does not own.
      isDefaultInput: sourceLabel !== null && id === sourceLabel,
      isDefaultOutput: sinkLabel !== null && id === sinkLabel,
      hasInput: nodes.sources.length > 0,
      hasOutput: nodes.sinks.length > 0,
    });
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Point one role's OS default at every live node carrying `deviceId`'s label
 * for that role — the input role runs `set-default-source`, the output role
 * `set-default-sink`. A label absent, or present with no nodes for that
 * role, is "not connected" for that role: log and leave the OS default, so a
 * legacy cross-role seed never hijacks the other side. null means "system
 * default": persisted intent only, nothing to assert (issue #857).
 */
export async function applyAudioDevice(
  deps: AudioDeviceRunner,
  deviceId: string | null,
  role: AudioDeviceRole,
): Promise<void> {
  if (deviceId === null) return;
  const map = await enumerate(deps);
  const nodes = map[deviceId];
  const names = nodes === undefined ? [] : role === "input" ? nodes.sources : nodes.sinks;
  if (names.length === 0) {
    // Unplugged — or the label only serves the other role: change nothing;
    // the OS default stays and the next resolve sees the live list again.
    console.warn(
      `[audio] stored audio ${role} device "${deviceId}" is not connected; leaving the system default`,
    );
    return;
  }
  const verb = role === "input" ? "set-default-source" : "set-default-sink";
  const failures: string[] = [];
  let succeeded = 0;
  for (const name of names) {
    try {
      await deps.run("pactl", [verb, name]);
      succeeded += 1;
    } catch (err) {
      failures.push(`${verb} ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  // The picker must not claim success it did not get: only a total failure of
  // every attempted command throws (startup apply swallows it into a log).
  if (succeeded === 0) {
    throw new Error(`could not select audio ${role} device "${deviceId}": ${failures.join("; ")}`);
  }
  for (const failure of failures) console.warn(`[audio] ${failure}`);
}
