import { contextBridge, ipcRenderer } from "electron";
import type { ArtifactGuestBridge, ArtifactStatePatch } from "../artifact-runtime-protocol";

// Bundled as a single sandbox-compatible CommonJS file. Only electron is external.
// No backend client, filesystem, local require(), generic IPC or ticket is exposed.
const surfacePrefix = "--omp-artifact-surface=";
const surfaceId = process.argv.find((arg) => arg.startsWith(surfacePrefix))?.slice(surfacePrefix.length);
const keyPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const forbidden = ["__proto__", "prototype", "constructor"];
const encoder = new TextEncoder();
const stateBytes = 1024 * 1024;
const patchBytes = 2 * stateBytes;
function validatePatch(input: unknown): asserts input is ArtifactStatePatch {
  let nodes = 0;
  let bytes = 0;
  const ancestors = new Set<object>();
  function visit(value: unknown, depth: number): void {
    if (depth > 64 || ++nodes > patchBytes) throw new Error("Artifact JSON exceeds structural bounds");
    if (value === null || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (typeof value === "string") {
      if (value.length > 1024 * 1024) throw new Error("Artifact state exceeds 1 MiB");
      bytes += encoder.encode(value).length;
      if (bytes > patchBytes) throw new Error("Artifact patch exceeds bounds");
      return;
    }
    if (typeof value !== "object" || value === null) throw new Error("Artifact state must be finite JSON");
    if (ancestors.has(value)) throw new Error("Artifact state cannot contain cycles");
    const proto = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && proto !== Object.prototype && proto !== null) throw new Error("Artifact state must contain plain JSON objects");
    if (Array.isArray(value) && (proto !== Array.prototype || value.length > stateBytes || Reflect.ownKeys(value).length !== value.length + 1)) throw new Error("Artifact JSON cannot contain sparse or extended arrays");
    ancestors.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || forbidden.includes(key)) throw new Error("Artifact JSON contains a forbidden key");
      if (Array.isArray(value) && key === "length") continue;
      if (Array.isArray(value) && (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) throw new Error("Artifact JSON cannot contain extended arrays");
      const property = Object.getOwnPropertyDescriptor(value, key);
      if (!property || !("value" in property) || !property.enumerable) throw new Error("Artifact JSON cannot contain accessors");
      if (key.length > 1024 * 1024) throw new Error("Artifact state exceeds 1 MiB");
      if (!Array.isArray(value)) bytes += encoder.encode(key).length;
      if (bytes > patchBytes) throw new Error("Artifact patch exceeds bounds");
      visit(property.value, depth + 1);
    }
    ancestors.delete(value);
  }
  visit(input, 0);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid artifact patch");
  const patch = input as ArtifactStatePatch;
  if (Object.keys(input).some((key) => !["expectedStateRevision", "set", "remove"].includes(key)) ||
      !Number.isSafeInteger(patch.expectedStateRevision) || patch.expectedStateRevision < 0 ||
      !patch.set || typeof patch.set !== "object" || Array.isArray(patch.set) ||
      Object.keys(patch.set).some((key) => !keyPattern.test(key)) ||
      (patch.remove !== undefined && (!Array.isArray(patch.remove) || patch.remove.length > 4096 || patch.remove.some((key) => typeof key !== "string" || !keyPattern.test(key) || forbidden.includes(key))))) throw new Error("Invalid artifact patch");
  if (encoder.encode(JSON.stringify(patch.set)).length > stateBytes) throw new Error("Artifact state exceeds 1 MiB");
  if (encoder.encode(JSON.stringify(input)).length > patchBytes) throw new Error("Artifact patch exceeds bounds");
}

if (process.isMainFrame && surfaceId) {
  let inFlight = 0;
  let windowStart = Date.now();
  let calls = 0;
  // Admit while the main-issued ticket is fresh, even if author code waits to use state.
  const hello = ipcRenderer.invoke("artifact-runtime:hello", surfaceId).then(
    () => ({ok: true as const}), error => ({ok: false as const, error: error as unknown}),
  );
  const invoke = async <T>(channel: string, patch?: ArtifactStatePatch): Promise<T> => {
    const now = Date.now();
    if (now - windowStart >= 1000) { windowStart = now; calls = 0; }
    if (++calls > 20 || inFlight >= 8) throw new Error("Artifact runtime rate limit exceeded");
    if (patch !== undefined) validatePatch(patch);
    inFlight++;
    try {
      const admission = await hello;
      if (!admission.ok) throw admission.error;
      return await ipcRenderer.invoke(channel, ...(patch === undefined ? [] : [patch])) as T;
    } finally { inFlight--; }
  };
  const bridge: ArtifactGuestBridge = {
    load: () => invoke("artifact-runtime:load"),
    saveState: (patch) => invoke("artifact-runtime:save-state", patch),
  };
  contextBridge.exposeInMainWorld("ompArtifact", bridge);
  ipcRenderer.on("artifact-runtime:theme", (_event, css: unknown) => {
    if (typeof css !== "string" || css.length > 16_384) return;
    let style = document.getElementById("omp-artifact-runtime-theme");
    if (!style) {
      style = document.createElement("style");
      style.id = "omp-artifact-runtime-theme";
      (document.head ?? document.documentElement).append(style);
    }
    style.textContent = css;
  });
}
