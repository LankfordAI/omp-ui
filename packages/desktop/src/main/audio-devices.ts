import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AudioDeviceEntry } from "@omp-ui/core";

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
 * Every real audio device on the machine, grouped by card label. The default
 * marker comes from the OS default source/sink node names resolved through the
 * node → label map: that is what dictation and omp's live-voice capture
 * actually follow, and the only source of truth pactl exposes on PipeWire.
 * Rejects when pactl is absent or fails — the handler turns that into
 * `supported: false`.
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
      // Source wins when the two halves disagree; a differing sink label is
      // marked too so the row never lies about which card is the default.
      isDefault: (sourceLabel !== null && id === sourceLabel) || (sinkLabel !== null && id === sinkLabel),
      hasInput: nodes.sources.length > 0,
      hasOutput: nodes.sinks.length > 0,
    });
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Point the OS defaults at every live node carrying `deviceId`'s label —
 * sources get `set-default-source`, sinks get `set-default-sink`. An
 * input-only device flips only the source and an output-only device only the
 * sink; that is correct, not a half-failure. null means "system default":
 * persisted intent only, nothing to assert (issue #855).
 */
export async function applyAudioDevice(
  deps: AudioDeviceRunner,
  deviceId: string | null,
): Promise<void> {
  if (deviceId === null) return;
  const map = await enumerate(deps);
  const nodes = map[deviceId];
  if (nodes === undefined || (nodes.sources.length === 0 && nodes.sinks.length === 0)) {
    // Unplugged: change nothing; the OS default stays and the next resolve
    // sees the live list again.
    console.warn(`[audio] stored audio device "${deviceId}" is not connected; leaving the system default`);
    return;
  }
  const failures: string[] = [];
  let attempted = 0;
  let succeeded = 0;
  for (const [verb, names] of [
    ["set-default-source", nodes.sources],
    ["set-default-sink", nodes.sinks],
  ] as const) {
    for (const name of names) {
      attempted += 1;
      try {
        await deps.run("pactl", [verb, name]);
        succeeded += 1;
      } catch (err) {
        failures.push(`${verb} ${name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  // The picker must not claim success it did not get: only a total failure of
  // every attempted command throws (startup apply swallows it into a log).
  if (attempted > 0 && succeeded === 0) {
    throw new Error(`could not select audio device "${deviceId}": ${failures.join("; ")}`);
  }
  for (const failure of failures) console.warn(`[audio] ${failure}`);
}
